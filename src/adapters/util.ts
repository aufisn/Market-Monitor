/**
 * Small shared helpers for adapters and the worker: call budget counter,
 * constant-time compare, sleep, New York date. No dependencies.
 */

/** Counts outbound / binding calls in one run (PRD section 1c: at most 45). */
export class CallCounter {
  used = 0;
  constructor(readonly limit = 45) {}
  spend(n = 1): void {
    this.used += n;
  }
  get remaining(): number {
    return this.limit - this.used;
  }
  reset(): void {
    this.used = 0;
  }
}

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const enc = new TextEncoder();

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

/** Constant-time string compare: both sides are hashed first so length does not leak. */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= (ha[i] ?? 0) ^ (hb[i] ?? 0);
  return diff === 0 && a.length === b.length;
}

/** Short hash used as a throttling key so raw client addresses are never stored. */
export async function shortHash(s: string): Promise<string> {
  const h = await sha256(s);
  let out = "";
  for (let i = 0; i < 8; i++) out += (h[i] ?? 0).toString(16).padStart(2, "0");
  return out;
}

let nyFmt: Intl.DateTimeFormat | undefined;
/** New York calendar date YYYY-MM-DD for an epoch ms (the trading-date key). */
export function nyDate(ms: number): string {
  nyFmt ??= new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return nyFmt.format(ms);
}

/** Lenient RFC 3339 -> epoch ms; accepts nanosecond fractions. NaN when invalid. */
export function parseTime(s: unknown): number {
  if (typeof s !== "string") return NaN;
  return Date.parse(s.replace(/(\.\d{3})\d+/, "$1"));
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
