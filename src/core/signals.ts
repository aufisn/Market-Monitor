/**
 * Design step 7 signals (ux/more-alerts-mockup.html): fast move, 50/200-day average crossings,
 * "trading stopped" (possible halt) and the market (SPY) note. Pure: no I/O.
 */
import type { MarketState, YearRange } from "./ports";
import { MIN } from "./time";

/** The market reference polled with every snapshot call (no extra request). */
export const MARKET_SYMBOL = "SPY";
/** A market move of at least this much (%) is added to alert messages. */
export const MARKET_NOTE_PCT = 1;

// ------------------------------------------------------------ minute prices (fast move)
const KEEP_MINUTES = 31;

/** Adds the latest price to its minute (newest last) and drops minutes older than 31. */
export function addMinutePrice(list: [number, number][] | undefined, tMs: number, price: number): [number, number][] {
  const minute = Math.floor(tMs / MIN) * MIN;
  const out = (list ?? []).filter(([t]) => t > minute - KEEP_MINUTES * MIN && t <= minute);
  const last = out[out.length - 1];
  if (last && last[0] === minute) out[out.length - 1] = [minute, price];
  else out.push([minute, price]);
  return out;
}

export interface FastEval {
  /** Set when the move reached pct: the price now and the reference (window high for a fall, low for a rise). */
  crossing: { value: number } | null;
  reference?: number;
  /** The move has shrunk below half of pct: the rule may re-arm. */
  inside: boolean;
}

/**
 * Fast move: within the last `minutes` (this minute included), has the price fallen pct % from the window's
 * high, or risen pct % from its low? Needs at least two minutes of prices.
 */
export function evaluateFast(prices: [number, number][] | undefined, nowMs: number, last: number | undefined, pct: number, minutes: number): FastEval {
  if (last === undefined || !(pct > 0)) return { crossing: null, inside: false };
  const from = Math.floor(nowMs / MIN) * MIN - minutes * MIN;
  const win = (prices ?? []).filter(([t]) => t >= from).map(([, p]) => p);
  if (win.length < 2) return { crossing: null, inside: false };
  const hi = Math.max(...win, last);
  const lo = Math.min(...win, last);
  const down = (hi - last) / hi;
  const up = (last - lo) / lo;
  const k = pct / 100;
  if (down >= k && down >= up) return { crossing: { value: last }, reference: hi, inside: false };
  if (up >= k) return { crossing: { value: last }, reference: lo, inside: false };
  return { crossing: null, inside: Math.max(down, up) < k / 2 };
}

/** Signed % move of a FAST alert from its stored values (price at T0 vs the window reference). */
export const fastMovePct = (value: number | undefined, reference: number | undefined): number | undefined =>
  value !== undefined && reference !== undefined && reference > 0 ? (value / reference - 1) * 100 : undefined;

// ------------------------------------------------------------ 50 / 200-day averages
/**
 * Which way an average crossing counts today: a stock that closed above its average is watched for a
 * fall below it ("LOW"); one that closed below is watched for a rise above it ("HIGH").
 */
export function averageSide(w: YearRange | undefined, which: "MA50" | "MA200"): { side: "HIGH" | "LOW"; level: number } | undefined {
  const level = which === "MA50" ? w?.ma50 : w?.ma200;
  if (level === undefined || w?.lastClose === undefined) return undefined;
  return { side: w.lastClose >= level ? "LOW" : "HIGH", level };
}

// ------------------------------------------------------------ trading stopped (possible halt)
export const HALT_MINUTES = 5;
/** Only stocks that normally trade every minute on IEX: at least this many IEX shares per minute so far today. */
export const HALT_MIN_SHARES_PER_MIN = 1000;
/** No notice in the first minutes of the session or the last minute before the close. */
const HALT_QUIET_AFTER_OPEN = 15 * MIN;

export type HaltStep = { kind: "HALT"; lastTradeMs: number; lastPrice?: number } | { kind: "RESUMED"; price: number; tMs: number } | null;

/**
 * feedAlive: another symbol (SPY) traded in the last 2 minutes, so a silent stock is not a data outage.
 * Returns what to send now; the caller records `haltLastTradeMs` on HALT and clears it on RESUMED.
 */
export function haltStep(ms: MarketState, nowMs: number, openMs: number, closeMs: number, feedAlive: boolean): HaltStep {
  const t = ms.last?.t;
  if (ms.haltLastTradeMs !== undefined) {
    return t !== undefined && t > ms.haltLastTradeMs && ms.last ? { kind: "RESUMED", price: ms.last.p, tMs: t } : null;
  }
  if (t === undefined || t < openMs || !feedAlive) return null;
  if (nowMs - openMs < HALT_QUIET_AFTER_OPEN || nowMs > closeMs - MIN) return null;
  if (nowMs - t < HALT_MINUTES * MIN) return null;
  const minutes = (t - openMs) / MIN;
  if (!(minutes > 0) || (ms.cumVolume ?? 0) / minutes < HALT_MIN_SHARES_PER_MIN) return null;
  return { kind: "HALT", lastTradeMs: t, lastPrice: ms.last?.p };
}

// ------------------------------------------------------------ market note
/** SPY's move today in %, only when it is at least MARKET_NOTE_PCT; else undefined. */
export function marketMove(spy: MarketState | undefined): number | undefined {
  const p = spy?.last?.p;
  const c = spy?.prev?.close;
  if (p === undefined || !c) return undefined;
  const pct = (p / c - 1) * 100;
  return Math.abs(pct) >= MARKET_NOTE_PCT ? pct : undefined;
}
