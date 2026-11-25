/**
 * One-time free-plan access check (design step 7): can this account read Alpaca news and split
 * announcements? Runs once from the scheduled handler, records only HTTP results (never the data),
 * and sends one silent Telegram message. Features that depend on refused data are not built.
 */
import { AlpacaError } from "../adapters/alpaca";
import type { Rendered } from "../adapters/telegram";
import { formatEtMuscat } from "../core/time";
import type { Ctx } from "./env";

export const ACCESS_KEY = "access_check_v1";
const CALLS = 3;

export interface Probe {
  ok: boolean;
  status: number | null; // HTTP status; null = no answer (network / timeout)
  note?: string;
}
export interface AccessResult {
  tMs: number;
  news: Probe;
  splitsPast: Probe;
  splitsFuture: Probe;
}

async function probe(fn: () => Promise<unknown>, check: (body: unknown) => string | undefined): Promise<Probe> {
  try {
    const body = await fn();
    const note = check(body);
    return note === undefined ? { ok: false, status: 200 } : { ok: true, status: 200, note };
  } catch (e) {
    if (e instanceof AlpacaError && e.status !== undefined) return { ok: false, status: e.status };
    return { ok: false, status: null };
  }
}

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export async function runAccessCheck(ctx: Ctx): Promise<AccessResult> {
  const now = ctx.now();
  const news = await probe(
    () => ctx.market.rawGet("/v1beta1/news", { symbols: "AAPL", limit: "1", sort: "desc" }),
    (b) => {
      const list = obj(b)?.news;
      if (!Array.isArray(list)) return undefined;
      const t = Date.parse(String(obj(list[0])?.created_at ?? ""));
      return Number.isFinite(t) ? `latest ${Math.max(0, Math.round((now - t) / 60_000))} min old` : "no recent headline";
    },
  );
  // A known past split (NVDA 10-for-1, June 2024) proves real split data comes back, not just HTTP 200.
  const splitsPast = await probe(
    () => ctx.market.rawGet("/v1/corporate-actions", { symbols: "NVDA", types: "forward_split", start: "2024-06-01", end: "2024-06-30", limit: "5" }),
    (b) => {
      const ca = obj(obj(b)?.corporate_actions);
      if (!ca) return undefined;
      const fs = Array.isArray(ca.forward_splits) ? ca.forward_splits.map(obj) : [];
      const hit = fs.find((x) => x?.symbol === "NVDA" && Number(x?.new_rate) === 10 && Number(x?.old_rate) === 1);
      return hit ? "NVDA 10-for-1 found" : undefined; // allowed but no real split data = not usable
    },
  );
  // Announced splits are dated in the future: the date window must be allowed to reach ahead.
  const splitsFuture = await probe(
    () => ctx.market.rawGet("/v1/corporate-actions", { types: "forward_split,reverse_split", start: ymd(now), end: ymd(now + 90 * 86_400_000), limit: "5" }),
    (b) => {
      const ca = obj(obj(b)?.corporate_actions);
      if (!ca) return undefined;
      const n = (Array.isArray(ca.forward_splits) ? ca.forward_splits.length : 0) + (Array.isArray(ca.reverse_splits) ? ca.reverse_splits.length : 0);
      return `${n} upcoming listed`;
    },
  );
  return { tMs: now, news, splitsPast, splitsFuture };
}

const word = (p: Probe) => (p.ok ? "allowed" : p.status === null ? "no answer" : p.status === 200 ? "answered, no usable data" : `refused (HTTP ${p.status})`);

export function renderAccessCheck(r: AccessResult): Rendered {
  const line = (label: string, p: Probe) => `${label}: ${word(p)}`;
  const L = [
    "🔎 <b>DATA ACCESS CHECK</b> · free plan",
    line("News", r.news),
    ...(r.news.ok && r.news.note ? [`  ${r.news.note}`] : []),
    line("Splits (past)", r.splitsPast),
    ...(r.splitsPast.ok && r.splitsPast.note ? [`  ${r.splitsPast.note}`] : []),
    line("Splits (coming)", r.splitsFuture),
    r.news.ok && r.splitsPast.ok && r.splitsFuture.ok ? "All free. Nothing else is used." : "Refused data will not be used.",
    formatEtMuscat(r.tMs),
  ];
  return { text: L.join("\n"), silent: true };
}

/** Called once per scheduled run; does nothing after the check has run once. */
let doneInThisIsolate = false; // saves the D1 read on warm runs once the check is recorded

export async function maybeAccessCheck(ctx: Ctx): Promise<void> {
  if (doneInThisIsolate || ctx.counter.remaining < CALLS + 8) return;
  if (await ctx.store.getMeta(ACCESS_KEY)) {
    doneInThisIsolate = true;
    return;
  }
  const r = await runAccessCheck(ctx);
  // No answer at all (network trouble): try again on a later run instead of recording a false "refused".
  if ([r.news, r.splitsPast, r.splitsFuture].some((p) => p.status === null)) return;
  await ctx.store.setMeta(ACCESS_KEY, JSON.stringify(r)); // marker first: the message is never sent twice
  await ctx.store.log([{ tMs: r.tMs, kind: "HEALTH", detail: { what: "access_check", news: r.news.status, splitsPast: r.splitsPast.status, splitsFuture: r.splitsFuture.status } }]);
  doneInThisIsolate = true;
  await ctx.telegram.sendMessage(renderAccessCheck(r));
}

/** Tests only. */
export const resetAccessCheckForTests = (): void => {
  doneInThisIsolate = false;
};
