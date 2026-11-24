/**
 * Rule evaluation (FR-3, FR-6.1/6.4, FR-8.3). Pure functions, no I/O.
 */
import type { Bar, Baseline, Settings, Snapshot, ThresholdInput, Trade, VolumeInput } from "./ports";

// ------------------------------------------------------------ thresholds (I-1)
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Dollar or percent-of-Previous-Close threshold -> dollars. undefined if it cannot be resolved yet. */
export function resolveThreshold(input: ThresholdInput | undefined, prevClose: number | undefined): number | undefined {
  if (!input) return undefined;
  if (input.mode === "dollar") return input.value;
  return prevClose === undefined ? undefined : round4(prevClose * (1 + input.value / 100));
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

// ------------------------------------------------------------ false-crossing filter (FR-3.4)
/** Provider condition codes (CTA) for extended-hours / out-of-sequence prints, plus normalised names an adapter may emit. */
export const FLAGGED_CONDITIONS: ReadonlySet<string> = new Set([
  "T", "U", "Z", // extended hours, extended hours sold out of sequence, sold out of sequence
  "EXTENDED", "CANCELED", "CORRECTED", "OUT_OF_SEQUENCE",
]);

export const isFlaggedTrade = (t: Trade): boolean => !!t.conditions?.some((c) => FLAGGED_CONDITIONS.has(c));

const pctFrom = (a: number, ref: number) => (Math.abs(a - ref) / ref) * 100;

/** True when the price is more than spikePct away from the median of the last 5 minute closes. Needs 5 closes. */
export function isSpike(price: number, recentCloses: number[] | undefined, spikePct: number): boolean {
  if (!recentCloses || recentCloses.length < 5) return false;
  const m = median(recentCloses.slice(-5));
  return m > 0 && pctFrom(price, m) > spikePct;
}

// ------------------------------------------------------------ price evidence (FR-3.3)
export interface PriceEval {
  crossing: { value: number; touchedAtMs?: number } | null;
  /** New heldPrice to store (spike awaiting confirmation) or null to clear. */
  held: number | null;
  /** Latest valid trade price, used for the re-arm check. */
  lastPrice?: number;
}

export interface PriceCtx {
  sessionOpenMs: number;
  recentCloses?: number[];
  spikeHoldPct: number;
  heldPrice?: number;
}

const crosses = (kind: "HIGH" | "LOW", price: number, thr: number) => (kind === "HIGH" ? price >= thr : price <= thr);

/**
 * Evidence = latest trade + high/low of the current and previous minute bars.
 * A bar-based crossing records the bar's minute (I-10). Spiky values are held
 * until a later poll shows a value within spikeHoldPct of the held one.
 */
export function evaluatePrice(kind: "HIGH" | "LOW", threshold: number, snap: Snapshot, ctx: PriceCtx): PriceEval {
  const cands: { price: number; barT?: number }[] = [];
  const trade = snap.latestTrade && !isFlaggedTrade(snap.latestTrade) ? snap.latestTrade : undefined;
  if (trade) cands.push({ price: trade.p });
  for (const b of [snap.prevMinuteBar, snap.minuteBar] as (Bar | undefined)[]) {
    if (b && b.t >= ctx.sessionOpenMs) cands.push({ price: kind === "HIGH" ? b.h : b.l, barT: b.t });
  }
  let held: number | null = null;
  for (const c of cands) {
    if (!crosses(kind, c.price, threshold)) continue;
    const spiky = isSpike(c.price, ctx.recentCloses, ctx.spikeHoldPct);
    const confirmed = ctx.heldPrice !== undefined && pctFrom(c.price, ctx.heldPrice) <= ctx.spikeHoldPct;
    if (!spiky || confirmed) return { crossing: { value: c.price, touchedAtMs: c.barT }, held: null, lastPrice: trade?.p };
    held ??= c.price;
  }
  return { crossing: null, held, lastPrice: trade?.p };
}

/** Has the price returned inside the band by the re-arm buffer? (I-5) */
export function priceInsideBuffer(kind: "HIGH" | "LOW", price: number | undefined, thr: number, bufferPct: number): boolean {
  if (price === undefined) return false;
  return kind === "HIGH" ? price <= thr * (1 - bufferPct / 100) : price >= thr * (1 + bufferPct / 100);
}

// ------------------------------------------------------------ volume (FR-3.2, FR-6)
/** AvgCum at `minutes` after the open, interpolated linearly inside a bucket. */
export function avgCumAt(b: Baseline, minutes: number): number {
  const n = b.avgCum.length;
  if (n === 0 || minutes <= 0) return 0;
  const i = Math.floor(minutes / b.barMinutes);
  if (i >= n) return b.avgCum[n - 1]!;
  const prev = i > 0 ? b.avgCum[i - 1]! : 0;
  return prev + (b.avgCum[i]! - prev) * ((minutes - i * b.barMinutes) / b.barMinutes);
}

export type VolumeStatus = "CROSSED" | "BELOW" | "GUARD" | "NO_BASELINE" | "NO_DATA";
export interface VolumeEval {
  status: VolumeStatus;
  threshold?: number;
  multiple?: number; // cum / AvgCum(t) (RVOL)
}

export function evaluateVolume(
  cum: number | undefined,
  cfg: VolumeInput,
  baseline: Baseline | null | undefined,
  minutesSinceOpen: number,
  s: Settings,
): VolumeEval {
  let threshold: number;
  let multiple: number | undefined;
  let guarded = minutesSinceOpen < s.volumeNoAlertFirstMin;
  if (cfg.mode === "absolute") {
    threshold = cfg.value;
  } else {
    if (!baseline || baseline.status !== "OK" || baseline.sessions < s.volumeMinSessions) return { status: "NO_BASELINE" };
    const avg = avgCumAt(baseline, minutesSinceOpen);
    if (avg < s.volumeMinAvgCum) guarded = true;
    threshold = cfg.value * avg;
    if (cum !== undefined && avg > 0) multiple = cum / avg;
  }
  if (cum === undefined) return { status: "NO_DATA", threshold };
  if (guarded) return { status: "GUARD", threshold, multiple };
  return { status: cum >= threshold ? "CROSSED" : "BELOW", threshold, multiple };
}

export const volumeInsideBuffer = (cum: number | undefined, thr: number, bufferPct: number): boolean =>
  cum !== undefined && cum < thr * (1 - bufferPct / 100);

// ------------------------------------------------------------ NEAR (FR-8.3)
/** NEAR = within nearPct% of the distance (Previous Close -> threshold) from a threshold, and not crossed. */
export function isNear(price: number, ref: number, low: number | undefined, high: number | undefined, nearPct: number): boolean {
  const near = (thr: number) => {
    const span = Math.abs(thr - ref);
    return span > 0 && Math.abs(thr - price) <= (nearPct / 100) * span;
  };
  if (high !== undefined && price < high && near(high)) return true;
  if (low !== undefined && price > low && near(low)) return true;
  return false;
}
