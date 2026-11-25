/** "Why did / didn't I get an alert?" (FR-11.3). One function behind both /why in Telegram and GET /api/why. */
import { f2, etOnly, num, pctOf, vol } from "../adapters/glance-fmt";
import type { LogRow } from "../adapters/d1store";
import type { RuleKind, StockConfig, ThresholdInput } from "../core/ports";
import { sessionFor } from "../core/calendar";
import { resolveThreshold } from "../core/rules";
import { MIN, nyLocalToUtc } from "../core/time";
import type { Ctx } from "./env";

const RULES: RuleKind[] = ["HIGH", "LOW", "VOLUME", "HIGH52", "LOW52"];

export const volumeRuleText = (v: StockConfig["volume"]): string | undefined =>
  !v ? undefined : v.mode === "multiple" ? `${v.value}x average` : `${vol(v.value)} shares`;

export interface WhyFacts {
  symbol: string;
  date: string;
  atMs: number;
  /** Plain-text sentences (used by the Telegram reply). */
  lines: string[];
  /** Price known for that time: the alert's price when one was sent, else the last stored price (priceKind says which). */
  price: { value: number; kind: "alert" | "last_seen"; tMs?: number } | null;
  /** Thresholds in force at that time, in dollars (null = off). */
  limits: { high: number | null; low: number | null; volume: string | null };
  /** Rule state at that time rebuilt from the log. */
  states: { rule: RuleKind; state: "armed" | "alert_open" | "reminding" | "acknowledged" }[];
  /** Alerts and reminders within 3 minutes of the time. */
  sent: { kind: string; rule: string | null; tMs: number; detail: unknown }[];
  /** Other log rows within 10 minutes (suppressed events, errors). */
  related: { kind: string; rule: string | null; tMs: number; detail: unknown }[];
  paused: boolean;
  mutedNow: boolean;
  /** Reason when the market was closed that day (holiday, weekend, expired calendar), else null. */
  marketClosed: string | null;
}

export async function explainWhy(ctx: Ctx, symbol: string, date: string, hour: number, minute: number): Promise<WhyFacts | { error: string }> {
  const now = ctx.now();
  const at = nyLocalToUtc(date, hour, minute);
  if (at > now) return { error: "That time has not happened yet." };
  const dayStart = nyLocalToUtc(date, 0);
  const near = 3 * MIN;
  const [logs, cfg, stocks, mstates] = await Promise.all([
    ctx.store.queryLog({ limit: 200, symbol }),
    ctx.store.queryConfigLog(200),
    ctx.store.listStocks(),
    ctx.store.getMarketStates(date),
  ]);
  const stock = stocks.find((s) => s.symbol === symbol);
  const ms = mstates.find((m) => m.symbol === symbol);
  const prev = ms?.prev?.close;
  const L: string[] = [];
  const session = sessionFor(date);
  const marketClosed = session.kind === "closed" ? session.closedReason : session.kind === "expired" ? "calendar expired" : null;
  if (marketClosed) L.push(`Market closed: ${marketClosed}`);
  const slim = (r: LogRow) => ({ kind: r.kind, rule: r.rule, tMs: r.tMs, detail: r.detail });

  const sent = logs.filter((r) => ["FIRST_ALERT", "LATE_ALERT", "REMINDER"].includes(r.kind) && Math.abs(r.tMs - at) <= near);
  if (sent.length === 0) L.push("No alert or reminder was logged within 3 min of that time.");
  let price: WhyFacts["price"] = null;
  for (const r of sent) {
    const d = (r.detail ?? {}) as Record<string, unknown>;
    if (r.kind === "REMINDER") L.push(`Reminder ${typeof d.n === "number" ? d.n + " " : ""}${r.rule ?? ""} sent at ${etOnly(r.tMs)}.`);
    else {
      L.push(`${r.kind === "LATE_ALERT" ? "Late alert" : "Alert"} ${r.rule ?? ""} sent at ${etOnly(r.tMs)}: price ${num(d.value as number)} against limit ${num(d.threshold as number)}.`);
      if (!price && typeof d.value === "number") price = { value: d.value, kind: "alert", tMs: r.tMs };
    }
  }

  const hist = (cfg as { t_ms: number; kind: string; key: string; prev: string | null; next: string | null }[]).filter((c) => c.key === symbol && c.kind === "stock");
  const before = hist.find((c) => c.t_ms <= at); // newest first
  const after = [...hist].reverse().find((c) => c.t_ms > at);
  let inForce: StockConfig | undefined = stock;
  try {
    if (before?.next) inForce = JSON.parse(before.next) as StockConfig;
    else if (after?.prev) inForce = JSON.parse(after.prev) as StockConfig;
  } catch { /* keep the current configuration */ }
  const hi = resolveThreshold(inForce?.high as ThresholdInput | undefined, prev);
  const lo = resolveThreshold(inForce?.low as ThresholdInput | undefined, prev);
  const vt = volumeRuleText(inForce?.volume);
  L.push(`Limits then: HIGH ${hi === undefined ? "off" : f2(hi)}, LOW ${lo === undefined ? "off" : f2(lo)}${vt ? `, VOLUME ${vt}` : ""}.`);
  const changed = hist.filter((c) => c.t_ms >= dayStart && c.t_ms <= at + 30 * MIN);
  if (changed.length) L.push(`Limits were edited at ${changed.map((c) => etOnly(c.t_ms)).reverse().join(", ")}.`);

  const upTo = logs.filter((r) => r.tMs >= dayStart && r.tMs <= at);
  const states: WhyFacts["states"] = [];
  for (const rule of RULES) {
    const last = upTo.find((r) => r.rule === rule && ["FIRST_ALERT", "LATE_ALERT", "REMINDER", "ACK"].includes(r.kind)); // newest first
    const state = !last ? "armed" : last.kind === "ACK" ? "acknowledged" : last.kind === "REMINDER" ? "reminding" : "alert_open";
    const word = state === "armed" ? "armed, nothing sent yet" : state === "alert_open" ? "alert open" : state;
    if (last || (rule === "HIGH" && hi !== undefined) || (rule === "LOW" && lo !== undefined) || (rule === "VOLUME" && vt)) {
      L.push(`${rule} state: ${word}.`);
      states.push({ rule, state });
    }
  }

  const related = logs.filter((x) => ["SUPPRESSED", "ERROR"].includes(x.kind) && Math.abs(x.tMs - at) <= 10 * MIN).slice(0, 5);
  for (const r of related.filter((x) => x.kind === "SUPPRESSED").slice(0, 3)) {
    const reason = (r.detail as Record<string, unknown> | null)?.reason;
    L.push(`Suppressed at ${etOnly(r.tMs)}: ${typeof reason === "string" ? reason : "see log"}.`);
  }
  const mutedNow = (stock?.mutedUntilMs ?? 0) > now;
  if (stock?.paused) L.push("Note: this stock is paused now.");
  if (mutedNow) L.push("Note: this stock is muted now.");
  if (!price && ms?.last) {
    price = { value: ms.last.p, kind: "last_seen" };
    if (sent.length === 0) L.push(`Price history is not stored. Last seen ${f2(ms.last.p)}${prev ? ` (${pctOf(ms.last.p, prev)})` : ""}.`);
  }
  return {
    symbol, date, atMs: at, lines: L, price,
    limits: { high: hi ?? null, low: lo ?? null, volume: vt ?? null },
    states, sent: sent.map(slim), related: related.map(slim), paused: !!stock?.paused, mutedNow, marketClosed,
  };
}
