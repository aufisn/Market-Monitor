/**
 * Split warning (design step 7, ux/more-alerts-mockup.html "Split warning"). Pure: no I/O.
 *
 * A split of oldRate -> newRate shares multiplies share counts by f = newRate / oldRate and divides prices by f
 * (4-for-1: f = 4; 1-for-10 reverse split: f = 0.1). The app never changes the user's levels by itself:
 * only a stored `splitPlan` (the "Adjust on <day>" tap) converts them, before the open on the split day.
 * Percent levels and "x usual" volume need no change.
 */
import type { Bar, DailyRef, SplitInfo, SplitLevels, StockConfig, TradingDate, YearRange } from "./ports";
import { addDays, nyLocalToUtc } from "./time";

/** Days looked back (recent splits still inside the volume baseline) and ahead (announced splits). */
export const SPLIT_BACK_DAYS = 40;
export const SPLIT_AHEAD_DAYS = 90;

export const splitWindow = (date: TradingDate): { start: TradingDate; end: TradingDate } => ({ start: addDays(date, -SPLIT_BACK_DAYS), end: addDays(date, SPLIT_AHEAD_DAYS) });
export const splitFactor = (s: SplitInfo): number => s.newRate / s.oldRate;
export const validSplit = (s: SplitInfo): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(s.exDate) && s.oldRate > 0 && s.newRate > 0 && Number.isFinite(s.oldRate) && Number.isFinite(s.newRate) && s.oldRate !== s.newRate;
export const sameSplit = (a: SplitInfo | undefined, b: SplitInfo | undefined): boolean =>
  !!a && !!b && a.exDate === b.exDate && a.oldRate === b.oldRate && a.newRate === b.newRate;
/** "4-for-1", "1-for-10" (rates as given, trimmed of trailing zeros). */
export const splitRatioText = (s: SplitInfo): string => `${+s.newRate.toFixed(4)}-for-${+s.oldRate.toFixed(4)}`;

/** Counter ("meta" scope) set once a split was applied to a stock's levels. */
export const splitDoneKey = (symbol: string, exDate: TradingDate): string => `splitdone:${symbol}:${exDate}`;

/** The next split on or after `date` (the one to warn about), or undefined. */
export function upcomingSplit(splits: SplitInfo[] | undefined, date: TradingDate): SplitInfo | undefined {
  return (splits ?? []).filter((s) => s.exDate >= date).sort((a, b) => (a.exDate < b.exDate ? -1 : 1))[0];
}

/** Product of the factors of splits that took effect after `afterDate` and on or before `date`. */
function factorBetween(splits: SplitInfo[] | undefined, afterDate: TradingDate, date: TradingDate): number {
  let f = 1;
  for (const s of splits ?? []) if (s.exDate > afterDate && s.exDate <= date) f *= splitFactor(s);
  return f;
}

/**
 * Previous Close is fetched unadjusted ("raw"), so on a split day it is still in pre-split prices.
 * Converts it once (idempotent through splitFactor) so % levels and the day change stay right.
 */
export function adjustPrev(prev: DailyRef | undefined, splits: SplitInfo[] | undefined, date: TradingDate): DailyRef | undefined {
  if (!prev || prev.splitFactor !== undefined) return prev;
  const f = factorBetween(splits, prev.date, date);
  if (f === 1) return prev;
  return { ...prev, close: prev.close / f, high: prev.high / f, low: prev.low / f, volume: Math.round(prev.volume * f), splitFactor: f, rawClose: prev.close };
}

/**
 * The 52-week levels come from split-adjusted official bars, but on the split day the provider may not have
 * applied the split yet. Compares the range's last close with the raw and the converted Previous Close and
 * converts the range when it is still in pre-split prices. Idempotent.
 */
export function fixRangeForSplit(w: YearRange | undefined, prev: DailyRef | undefined, splits: SplitInfo[] | undefined, date: TradingDate): YearRange | undefined {
  if (!w || !prev || w.lastClose === undefined) return w;
  const raw = prev.rawClose ?? prev.close;
  const f = prev.splitFactor ?? factorBetween(splits, prev.date, date);
  if (f === 1) return w;
  if (Math.abs(w.lastClose - raw / f) <= Math.abs(w.lastClose - raw)) return w; // already adjusted
  const d = (x: number | undefined) => (x === undefined ? undefined : x / f);
  const out: YearRange = { ...w };
  for (const k of ["high", "low", "ma50", "ma200", "lastClose"] as const) {
    const v = d(w[k]);
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** Raw intraday bars before a split, converted to post-split units (volume baseline). */
export function scaleBarsForSplits(bars: Bar[], splits: SplitInfo[] | undefined, date: TradingDate): Bar[] {
  const live = (splits ?? []).filter((s) => s.exDate <= date).map((s) => ({ startMs: nyLocalToUtc(s.exDate, 0), f: splitFactor(s) }));
  if (!live.length) return bars;
  return bars.map((b) => {
    let f = 1;
    for (const s of live) if (b.t < s.startMs) f *= s.f;
    return f === 1 ? b : { t: b.t, o: b.o / f, h: b.h / f, l: b.l / f, c: b.c / f, v: Math.round(b.v * f) };
  });
}

const roundPrice = (p: number): number => (p >= 1 ? Math.round(p * 100) / 100 : Math.round(p * 10_000) / 10_000);

/** The levels a split changes: dollar LOW / HIGH and a share-count volume limit. */
export function splitLevels(s: StockConfig): SplitLevels {
  const out: SplitLevels = {};
  if (s.low?.mode === "dollar") out.low = s.low.value;
  if (s.high?.mode === "dollar") out.high = s.high.value;
  if (s.volume?.mode === "absolute") out.volume = s.volume.value;
  return out;
}

/** The same levels after the split (prices / f, shares x f). */
export function convertLevels(l: SplitLevels, split: SplitInfo): SplitLevels {
  const f = splitFactor(split);
  const out: SplitLevels = {};
  if (l.low !== undefined) out.low = roundPrice(l.low / f);
  if (l.high !== undefined) out.high = roundPrice(l.high / f);
  if (l.volume !== undefined) out.volume = Math.max(1, Math.round(l.volume * f));
  return out;
}

/** Applies a split to a stock's levels; the plan is removed. */
export function applySplit(s: StockConfig, split: SplitInfo): { stock: StockConfig; from: SplitLevels; to: SplitLevels } {
  const from = splitLevels(s);
  const to = convertLevels(from, split);
  const stock: StockConfig = { ...s };
  delete stock.splitPlan;
  if (to.low !== undefined) stock.low = { mode: "dollar", value: to.low };
  if (to.high !== undefined) stock.high = { mode: "dollar", value: to.high };
  if (to.volume !== undefined) stock.volume = { mode: "absolute", value: to.volume };
  return { stock, from, to };
}
