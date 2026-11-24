/**
 * Missed-run catch-up (FR-9). Price rules only: cumulative volume cannot be
 * missed (it only grows), so the normal poll after a gap catches a volume crossing.
 */
import type { Bar, RuleKind, RuleState } from "./ports";
import { isSpike } from "./rules";
import { MIN } from "./time";

export const GAP_AFTER_MS = 2 * MIN;

/** Session-clipped window [startMs, endMs) of whole minutes to scan, or null if no gap (FR-9.2, FR-9.4). */
export function gapWindow(lastPollMs: number | null, nowMs: number, openMs: number, closeMs: number): { startMs: number; endMs: number } | null {
  const last = lastPollMs !== null && lastPollMs >= openMs ? lastPollMs : openMs;
  if (nowMs - last <= GAP_AFTER_MS) return null;
  const startMs = Math.max(Math.floor(last / MIN) * MIN, openMs);
  const endMs = Math.min(Math.floor(nowMs / MIN) * MIN, closeMs); // the running minute is covered by the live snapshot
  return endMs > startMs ? { startMs, endMs } : null;
}

export interface GapRule {
  symbol: string;
  rule: "HIGH" | "LOW";
  threshold: number;
  state?: RuleState; // missing = never evaluated = ARMED
}
export interface LateHit {
  symbol: string;
  rule: RuleKind;
  threshold: number;
  barTimeMs: number;
  price: number;
}

/**
 * First bar per rule whose high/low crossed. Rules not ARMED are skipped (already alerted / acknowledged).
 * A spiky bar (FR-3.4) counts only if the next bar also crosses within the spike band.
 */
export function scanGap(rules: GapRule[], bars: Record<string, Bar[]>, spikeHoldPct: number, seedCloses: Record<string, number[]> = {}): LateHit[] {
  const hits: LateHit[] = [];
  for (const r of rules) {
    if (r.state && r.state.state !== "ARMED") continue;
    const list = [...(bars[r.symbol] ?? [])].sort((a, b) => a.t - b.t);
    const val = (b: Bar) => (r.rule === "HIGH" ? b.h : b.l);
    const crossed = (b: Bar) => (r.rule === "HIGH" ? b.h >= r.threshold : b.l <= r.threshold);
    const closes = [...(seedCloses[r.symbol] ?? [])];
    for (let i = 0; i < list.length; i++) {
      const b = list[i]!;
      if (crossed(b)) {
        const next = list[i + 1];
        const spiky = isSpike(val(b), closes, spikeHoldPct);
        const confirmed = !!next && crossed(next) && Math.abs(val(next) - val(b)) / val(b) * 100 <= spikeHoldPct;
        if (!spiky || confirmed) {
          hits.push({ symbol: r.symbol, rule: r.rule, threshold: r.threshold, barTimeMs: b.t, price: val(b) });
          break;
        }
      }
      closes.push(b.c);
    }
  }
  return hits;
}
