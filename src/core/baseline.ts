/**
 * Volume baseline (FR-6): AvgCum(t) from historical bars, plausibility check,
 * and the planner that picks one stock per run (FR-6.2).
 */
import { sessionFor } from "./calendar";
import type { Bar, Baseline, StockConfig, TradingDate } from "./ports";
import { addDays, nyLocalToUtc, nyParts } from "./time";

export const BASELINE_BAR_MINUTES = 5 as const; // 5 or 15 (decided in Phase 0 from measured CPU)
const SESSION_MINUTES = 390; // 09:30-16:00
const OPEN_MINUTE = 570;
/** A session whose full-day volume is more than 5x or less than 1/5 of the median session is an outlier. */
const OUTLIER_FACTOR = 5;

const medianOf = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Bars window to request for a build: from enough calendar days back to the open of `date`. */
export function baselineWindow(date: TradingDate, sessions: number): { startMs: number; endMs: number } {
  const open = sessionFor(date);
  return {
    startMs: nyLocalToUtc(addDays(date, -Math.ceil(sessions * 1.5) - 10), 0),
    endMs: open.kind === "open" ? open.open : nyLocalToUtc(date, 9, 30),
  };
}

export function isPlausible(b: Baseline): boolean {
  const n = Math.ceil(SESSION_MINUTES / b.barMinutes);
  if (b.avgCum.length !== n || !Number.isFinite(b.avgFullDay) || b.avgFullDay <= 0) return false;
  for (let i = 0; i < n; i++) {
    const v = b.avgCum[i]!;
    if (!Number.isFinite(v) || v < 0 || (i > 0 && v < b.avgCum[i - 1]!)) return false;
  }
  return b.avgCum[n - 1]! > 0;
}

/**
 * Build AvgCum from bars of `barMinutes` covering past sessions. Skips weekends,
 * holidays (no bars), early-close days, today, zero-volume sessions and outliers;
 * uses the most recent `sessions` that remain.
 */
export function buildBaseline(symbol: string, builtFor: TradingDate, bars: Bar[], sessions: number, barMinutes: 5 | 15 = BASELINE_BAR_MINUTES): Baseline {
  const nb = Math.ceil(SESSION_MINUTES / barMinutes);
  const byDay = new Map<TradingDate, number[]>();
  for (const b of bars) {
    const p = nyParts(b.t);
    const idx = Math.floor((p.minuteOfDay - OPEN_MINUTE) / barMinutes);
    if (p.date >= builtFor || idx < 0 || idx >= nb) continue;
    let day = byDay.get(p.date);
    if (!day) {
      const ses = sessionFor(p.date);
      if (ses.kind !== "open" || ses.early) continue;
      byDay.set(p.date, (day = new Array<number>(nb).fill(0)));
    }
    day[idx]! += b.v;
  }
  const dates = [...byDay.keys()].sort().reverse().slice(0, sessions);
  const cums = dates.map((d) => {
    let run = 0;
    return byDay.get(d)!.map((v) => (run += v));
  });
  const totals = cums.map((c) => c[nb - 1]!);
  const med = medianOf(totals.filter((t) => t > 0));
  const kept = cums.filter((c) => c[nb - 1]! > 0 && c[nb - 1]! <= med * OUTLIER_FACTOR && c[nb - 1]! >= med / OUTLIER_FACTOR);
  const avgCum = new Array<number>(nb).fill(0);
  for (const c of kept) for (let i = 0; i < nb; i++) avgCum[i]! += c[i]!;
  for (let i = 0; i < nb && kept.length; i++) avgCum[i] = avgCum[i]! / kept.length;
  const b: Baseline = {
    symbol, builtFor, barMinutes, sessions: kept.length, avgCum,
    avgFullDay: kept.length ? avgCum[nb - 1]! : 0, status: "OK",
  };
  if (!kept.length || !isPlausible(b)) b.status = "NO_BASELINE";
  return b;
}

/** Which stock to build next (FR-6.2): missing before stale, volume-rule stocks first, then by symbol. Null = nothing to do. */
export function pickNextBaseline(stocks: StockConfig[], baselines: Baseline[], date: TradingDate): string | null {
  const have = new Map(baselines.map((b) => [b.symbol, b]));
  const rank = (s: StockConfig): number | null => {
    const b = have.get(s.symbol);
    if (b && b.builtFor >= date) return null;
    return (b ? 2 : 0) + (s.volume ? 0 : 1);
  };
  let best: { sym: string; r: number } | null = null;
  for (const s of stocks) {
    if (!s.enabled) continue;
    const r = rank(s);
    if (r === null) continue;
    if (!best || r < best.r || (r === best.r && s.symbol < best.sym)) best = { sym: s.symbol, r };
  }
  return best?.sym ?? null;
}

/** "baselines 18/30" (FR-6.2). */
export function baselineProgress(stocks: StockConfig[], baselines: Baseline[], date: TradingDate): { done: number; total: number } {
  const done = new Set(baselines.filter((b) => b.builtFor >= date).map((b) => b.symbol));
  const en = stocks.filter((s) => s.enabled);
  return { done: en.filter((s) => done.has(s.symbol)).length, total: en.length };
}
