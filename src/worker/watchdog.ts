/**
 * Outside watchdog (Healthchecks.io dead-man's switch, docs/phase0-findings.md).
 *
 * Every fifth minute the timer run pings a Healthchecks URL kept in the optional secret HEALTHCHECK_URL.
 * If the pings stop (timer not firing, Worker failing, secrets missing), Healthchecks sends its own
 * alert by Telegram. A run in which a poll failed pings ".../fail" so the problem shows at once.
 * One outbound call, only when there is room in the run's call budget. Never blocks alerting.
 */
import type { Ctx } from "./env";

/** Pings on runs that start in these minutes (UTC minute % 5 === 0): 12 calls an hour. */
export const PING_EVERY_MIN = 5;
const PING_HOST = "hc-ping.com";

/** Only a plain https://hc-ping.com/<id> address is used; anything else turns the watchdog off. */
export function cleanPingUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (s.length > 200) return undefined;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" || u.hostname !== PING_HOST || u.port || u.username || u.password || u.search || u.hash) return undefined;
  if (!/^\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)?$/.test(u.pathname)) return undefined;
  return `https://${PING_HOST}${u.pathname}`;
}

export const isPingMinute = (t0: number): boolean => new Date(t0).getUTCMinutes() % PING_EVERY_MIN === 0;

/** Sends the ping. Returns whether a ping was attempted. */
export async function pingWatchdog(ctx: Ctx, fetchImpl: typeof fetch, t0: number, ok: boolean): Promise<boolean> {
  const url = cleanPingUrl(ctx.env.HEALTHCHECK_URL);
  if (!url || !isPingMinute(t0) || ctx.counter.remaining < 1) return false;
  ctx.counter.spend();
  try {
    await fetchImpl(ok ? url : `${url}/fail`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(5_000) });
  } catch {
    /* the watchdog itself never blocks alerting */
  }
  return true;
}
