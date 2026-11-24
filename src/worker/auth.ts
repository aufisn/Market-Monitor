/**
 * Dashboard authentication (FR-8.10, S-5): Bearer access code, constant-time
 * compare, per-client lockout (10 failures -> 15 minutes) and a global brake.
 *
 * Client key: a hash of the connecting address. IPv6 clients are keyed by their
 * /64 prefix, because one subscriber normally owns a whole /64 and could
 * otherwise rotate through billions of addresses. Raw addresses are never stored.
 *
 * Global brake: more than GLOBAL_MAX failed attempts in one 15-minute window
 * (from anywhere) stops all per-client D1 writes and rejects every FAILED API login for
 * the rest of the window (a correct code is always accepted), with ONE operational notice. The auth path then does a
 * single read and no write, so a flood can never use up the D1 write allowance
 * that alert state needs (alert writes go through the webhook and the cron, not here).
 */
import { renderGlance } from "../adapters/render-glance";
import { constantTimeEqual, shortHash } from "../adapters/util";
import type { Ctx } from "./env";
import { json } from "./http";

export const MAX_FAILS = 10;
export const LOCK_MS = 15 * 60_000;
export const WINDOW_MS = 15 * 60_000;
export const MIN_CODE_LENGTH = 32;
export const GLOBAL_MAX = 200;
export const GLOBAL_KEY = "*global*";

/** What gets hashed for lockout purposes: IPv4 as is, IPv6 reduced to its /64 (first four groups). */
export function clientKeySource(raw: string): string {
  let ip = raw.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  if (!ip.includes(":")) return ip.slice(0, 64);
  const mapped = /^(?:0{0,4}:){0,5}ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip) ?? /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) return mapped[1] as string; // IPv4-mapped IPv6 is an IPv4 client
  const groups = expandV6(ip);
  return groups ? `v6/64:${groups.slice(0, 4).join(":")}` : `raw:${raw.slice(0, 64)}`;
}

function expandV6(ip: string): string[] | null {
  let s = ip;
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const b = v4.slice(1).map(Number);
    if (b.some((x) => x > 255)) return null;
    s = s.slice(0, v4.index) + ((b[0]! << 8) | b[1]!).toString(16) + ":" + ((b[2]! << 8) | b[3]!).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < (halves.length === 2 ? 1 : 0)) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => g.padStart(4, "0"));
}

/** Returns null when the request may proceed, otherwise the response to send. */
export async function authenticate(request: Request, ctx: Ctx): Promise<Response | null> {
  const code = ctx.env.DASHBOARD_ACCESS_CODE;
  if (!code || code.length < MIN_CODE_LENGTH) {
    return json({ error: "NOT_CONFIGURED", message: "The dashboard access code is not set on the server." }, 503);
  }
  const now = ctx.now();
  // The compare comes first: the right code is never refused because of the global brake.
  const h = request.headers.get("authorization") ?? "";
  const m = /^Bearer ([\x21-\x7e]{1,256})$/.exec(h);
  const ok = m ? await constantTimeEqual(m[1] as string, code) : false;
  const client = await shortHash(clientKeySource(request.headers.get("cf-connecting-ip") ?? "unknown"));
  const rows = await ctx.store.getAuthRows([client, GLOBAL_KEY]);

  const row = rows.get(client);
  if (row && row.locked_until_ms > now) {
    const retry = Math.ceil((row.locked_until_ms - now) / 1000);
    return json({ error: "LOCKED", message: "Too many wrong attempts. Try again later." }, 429, { "retry-after": String(retry) });
  }
  if (ok) {
    if (row && row.fails > 0) await ctx.store.clearAuthFailures(client);
    return null;
  }

  // Failures only from here on.
  const g = rows.get(GLOBAL_KEY);
  if (g && g.window_start_ms > now - WINDOW_MS && g.fails > GLOBAL_MAX) {
    const retryAfterMs = Math.max(1000, g.window_start_ms + WINDOW_MS - now);
    return json({ error: "GLOBAL_LOCK", message: "Too many wrong attempts overall. Try again later.", retryAfterMs }, 429, { "retry-after": String(Math.ceil(retryAfterMs / 1000)) }); // no D1 write
  }
  const total = await ctx.store.bumpGlobalAuthFailure(GLOBAL_KEY, now, WINDOW_MS);
  if (total === GLOBAL_MAX + 1) await tellOwner(ctx, now);
  if (total <= GLOBAL_MAX) await ctx.store.recordAuthFailure(client, now, MAX_FAILS, WINDOW_MS, LOCK_MS);
  return json({ error: "UNAUTHORIZED", message: "Access code missing or wrong." }, 401);
}

/** One notice per window (only the request that crosses the line sends it). Never throws. */
async function tellOwner(ctx: Ctx, now: number): Promise<void> {
  const ev = { type: "OPS_NOTICE" as const, code: "AUTH_FLOOD", detail: `More than ${GLOBAL_MAX} wrong dashboard logins in 15 min. Dashboard logins are paused until the window ends. Alerts are not affected.` };
  try {
    await ctx.telegram.sendMessage(renderGlance(ev, { nowMs: now, dashboardUrl: ctx.dashboardUrl }));
  } catch {
    await ctx.store.enqueue(ev, 3, now).catch(() => undefined); // the next scheduled run sends it
  }
}
