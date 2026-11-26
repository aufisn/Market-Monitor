/**
 * 52-week range (HIGH52 / LOW52 alerts and the card range). Pure: the engine fetches the bars.
 * Source: official (SIP) daily bars, split-adjusted, of the 52 weeks before the trading date (today excluded).
 * The levels stay fixed for the whole day; the next day's range includes today.
 */
import type { Bar, MarketState, StockConfig, TradingDate, YearRange } from "./ports";
import { addDays, nyLocalToUtc } from "./time";

/** Stocks whose range is fetched per run: before the open, and (for late additions) during the session. */
export const W52_PER_RUN_PRE_OPEN = 10;
export const W52_PER_RUN_SESSION = 3;

/** A new 52-week high has to trade above the old one (a touch is not a new high). */
const STRICT = 1e-9;
export const high52Threshold = (w: YearRange | undefined): number | undefined => (w?.high !== undefined ? w.high * (1 + STRICT) : undefined);
export const low52Threshold = (w: YearRange | undefined): number | undefined => (w?.low !== undefined ? w.low * (1 - STRICT) : undefined);

/** Request window: from 52 weeks before `date` up to the start of `date` (New York midnight, long past by the open). */
export function yearWindow(date: TradingDate): { startMs: number; endMs: number } {
  return { startMs: nyLocalToUtc(addDays(date, -364), 0), endMs: nyLocalToUtc(date, 0) };
}

const barDate = (b: Bar): string => new Date(b.t).toISOString().slice(0, 10); // 04:00Z / 05:00Z = the New York date

export function buildYearRange(date: TradingDate, bars: Bar[] | undefined): YearRange {
  const r: YearRange = { date, sessions: 0 };
  const closes = [...(bars ?? [])].filter((b) => barDate(b) < date && b.c > 0).sort((a, b) => a.t - b.t).map((b) => b.c);
  const avg = (n: number) => (closes.length >= n ? closes.slice(-n).reduce((s, c) => s + c, 0) / n : undefined);
  const ma50 = avg(50);
  const ma200 = avg(200);
  if (ma50 !== undefined) r.ma50 = ma50;
  if (ma200 !== undefined) r.ma200 = ma200;
  if (closes.length) r.lastClose = closes[closes.length - 1]!;
  for (const b of bars ?? []) {
    const d = barDate(b);
    if (d >= date || !(b.h > 0) || !(b.l > 0)) continue;
    r.sessions++;
    if (r.firstDate === undefined || d < r.firstDate) r.firstDate = d;
    if (r.high === undefined || b.h > r.high) {
      r.high = b.h;
      r.highDate = d;
    }
    if (r.low === undefined || b.l < r.low) {
      r.low = b.l;
      r.lowDate = d;
    }
  }
  return r;
}

/** Stocks that still need today's range (every enabled stock: the card shows the range even with the switch off). */
export function needYearRange(stocks: StockConfig[], states: Map<string, MarketState>, date: TradingDate, limit: number): StockConfig[] {
  // A range without lastClose was stored by an older version (no 50/200-day averages): rebuild it.
  const stale = (w: MarketState["w52"]) => w?.date !== date || (w.sessions > 0 && w.lastClose === undefined);
  return stocks.filter((s) => stale(states.get(s.symbol)?.w52)).slice(0, Math.max(0, limit));
}
