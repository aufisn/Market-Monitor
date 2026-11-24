/**
 * Dashboard authentication (FR-8.10, S-5): Bearer access code, constant-time
 * compare, per-client lockout (10 failures -> 15 minutes). The client key is a
 * hash of the connecting address; raw addresses are never stored.
 */
import { constantTimeEqual, shortHash } from "../adapters/util";
import type { Ctx } from "./env";
import { json } from "./http";

export const MAX_FAILS = 10;
export const LOCK_MS = 15 * 60_000;
export const WINDOW_MS = 15 * 60_000;
export const MIN_CODE_LENGTH = 32;

/** Returns null when the request may proceed, otherwise the response to send. */
export async function authenticate(request: Request, ctx: Ctx): Promise<Response | null> {
  const code = ctx.env.DASHBOARD_ACCESS_CODE;
  if (!code || code.length < MIN_CODE_LENGTH) {
    return json({ error: "NOT_CONFIGURED", message: "The dashboard access code is not set on the server." }, 503);
  }
  const now = ctx.now();
  const client = await shortHash(request.headers.get("cf-connecting-ip") ?? "unknown");
  const row = await ctx.store.getAuthRow(client);
  if (row && row.locked_until_ms > now) {
    const retry = Math.ceil((row.locked_until_ms - now) / 1000);
    return json({ error: "LOCKED", message: "Too many wrong attempts. Try again later." }, 429, { "retry-after": String(retry) });
  }
  const h = request.headers.get("authorization") ?? "";
  const m = /^Bearer ([\x21-\x7e]{1,256})$/.exec(h);
  const ok = m ? await constantTimeEqual(m[1] as string, code) : false;
  if (!ok) {
    await ctx.store.recordAuthFailure(client, now, MAX_FAILS, WINDOW_MS, LOCK_MS);
    return json({ error: "UNAUTHORIZED", message: "Access code missing or wrong." }, 401);
  }
  if (row && row.fails > 0) await ctx.store.clearAuthFailures(client);
  return null;
}
