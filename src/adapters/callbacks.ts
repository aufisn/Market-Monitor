/**
 * Callback-data encoding for inline buttons (Telegram limit: 64 bytes).
 * The production renderer (after DG-3) must use encode*; the webhook uses decodeCallback.
 *
 *   a|SYM|RULE|CYCLE     acknowledge one rule
 *   A                    acknowledge all
 *   m|SYM|MINUTES        mute a stock
 *   t|SYM|RULE|PCT       acknowledge and move the crossed threshold by PCT percent (P1)
 */
import type { RuleKind } from "../core/ports";

export type CallbackAction =
  | { type: "ack"; symbol: string; rule: RuleKind; cycle: number }
  | { type: "ackall" }
  | { type: "mute"; symbol: string; minutes: number }
  | { type: "ackmove"; symbol: string; rule: RuleKind; pct: number };

export const SYMBOL_RE = /^[A-Z][A-Z0-9]{0,4}([.-][A-Z])?$/;
const RULES = new Set(["HIGH", "LOW", "VOLUME"]);

export const encodeAck = (symbol: string, rule: RuleKind, cycle: number): string => `a|${symbol}|${rule}|${cycle}`;
export const encodeAckAll = (): string => "A";
export const encodeMute = (symbol: string, minutes: number): string => `m|${symbol}|${minutes}`;
export const encodeAckMove = (symbol: string, rule: RuleKind, pct: number): string => `t|${symbol}|${rule}|${pct}`;

export function decodeCallback(data: unknown): CallbackAction | null {
  if (typeof data !== "string" || data.length > 64) return null;
  const p = data.split("|");
  const kind = p[0];
  if (kind === "A" && p.length === 1) return { type: "ackall" };
  const sym = p[1];
  if (!sym || !SYMBOL_RE.test(sym)) return null;
  if (kind === "a" && p.length === 4) {
    const rule = p[2] as string, cycle = Number(p[3]);
    if (RULES.has(rule) && Number.isInteger(cycle) && cycle >= 0) return { type: "ack", symbol: sym, rule: rule as RuleKind, cycle };
  }
  if (kind === "m" && p.length === 3) {
    const minutes = Number(p[2]);
    if (Number.isInteger(minutes) && minutes > 0 && minutes <= 1440) return { type: "mute", symbol: sym, minutes };
  }
  if (kind === "t" && p.length === 4) {
    const rule = p[2] as string, pct = Number(p[3]);
    if (RULES.has(rule) && Number.isFinite(pct) && Math.abs(pct) <= 100) return { type: "ackmove", symbol: sym, rule: rule as RuleKind, pct };
  }
  return null;
}
