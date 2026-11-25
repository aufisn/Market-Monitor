/**
 * Callback-data encoding for inline buttons (Telegram limit: 64 bytes).
 * The renderer must use encode*; the webhook uses decodeCallback.
 *
 *   a|SYM|RULE|CYCLE     acknowledge one rule
 *   A                    acknowledge all rules of all stocks
 *   k|SYM|RULE:CYCLE,..  acknowledge exactly the listed rules of one stock (combined reminder)
 *   m|SYM|MINUTES        mute a stock
 *   t|SYM|RULE|PCT|CYC   acknowledge and move the crossed threshold by PCT percent (FR-4.7)
 *   x|SYM|RULE|CYC       open the Ack + move chooser (keyboard swap)
 *   y|SYM|RULE|CYC       ask for a typed Ack + move value (ForceReply)
 *   c|SYM|RULE           cancel the chooser (restore the normal keyboard)
 *   d|SYM|RULE           Details: full card as a silent reply
 *   D                    Details of the Opening Briefing
 *   E                    "Mark all seen" on Unacknowledged at close
 *   v|SYM|FIELD          save a pending /set that would alert at once
 *   z|SYM|FIELD          cancel that pending /set
 */
import type { RuleKind } from "../core/ports";

export type SetField = "high" | "low" | "volume";

export type CallbackAction =
  | { type: "ack"; symbol: string; rule: RuleKind; cycle: number }
  | { type: "ackall" }
  | { type: "ackstock"; symbol: string; rules: { rule: RuleKind; cycle: number }[] }
  | { type: "mute"; symbol: string; minutes: number }
  | { type: "ackmove"; symbol: string; rule: RuleKind; pct: number; cycle: number }
  | { type: "chooser"; symbol: string; rule: RuleKind; cycle: number }
  | { type: "typed"; symbol: string; rule: RuleKind; cycle: number }
  | { type: "cancelchooser"; symbol: string; rule: RuleKind }
  | { type: "details"; symbol: string; rule: RuleKind }
  | { type: "briefdetails" }
  | { type: "seen" }
  | { type: "saveset"; symbol: string; field: SetField }
  | { type: "cancelset"; symbol: string; field: SetField };

export const SYMBOL_RE = /^[A-Z][A-Z0-9]{0,4}([.-][A-Z])?$/;
const RULES = new Set(["HIGH", "LOW", "VOLUME", "HIGH52", "LOW52", "FAST", "MA50", "MA200"]);
const FIELDS = new Set(["high", "low", "volume"]);

export const encodeAck = (symbol: string, rule: RuleKind, cycle: number): string => `a|${symbol}|${rule}|${cycle}`;
export const encodeAckAll = (): string => "A";
export const encodeAckStock = (symbol: string, rules: { rule: RuleKind; cycle: number }[]): string => `k|${symbol}|${rules.map((r) => `${r.rule}:${r.cycle}`).join(",")}`;
export const encodeMute = (symbol: string, minutes: number): string => `m|${symbol}|${minutes}`;
export const encodeAckMove = (symbol: string, rule: RuleKind, pct: number, cycle: number): string => `t|${symbol}|${rule}|${pct}|${cycle}`;
export const encodeChooser = (symbol: string, rule: RuleKind, cycle: number): string => `x|${symbol}|${rule}|${cycle}`;
export const encodeTyped = (symbol: string, rule: RuleKind, cycle: number): string => `y|${symbol}|${rule}|${cycle}`;
export const encodeCancelChooser = (symbol: string, rule: RuleKind): string => `c|${symbol}|${rule}`;
export const encodeDetails = (symbol: string, rule: RuleKind): string => `d|${symbol}|${rule}`;
export const encodeBriefDetails = (): string => "D";
export const encodeSeen = (): string => "E";
export const encodeSaveSet = (symbol: string, field: SetField): string => `v|${symbol}|${field}`;
export const encodeCancelSet = (symbol: string, field: SetField): string => `z|${symbol}|${field}`;

export function decodeCallback(data: unknown): CallbackAction | null {
  if (typeof data !== "string" || data.length > 64) return null;
  const p = data.split("|");
  const kind = p[0];
  if (kind === "A" && p.length === 1) return { type: "ackall" };
  if (kind === "D" && p.length === 1) return { type: "briefdetails" };
  if (kind === "E" && p.length === 1) return { type: "seen" };
  const sym = p[1];
  if (!sym || !SYMBOL_RE.test(sym)) return null;
  const rule = p[2] as string;
  if (kind === "k" && p.length === 3) {
    const rules: { rule: RuleKind; cycle: number }[] = [];
    for (const part of (p[2] as string).split(",")) {
      const [r, c] = part.split(":");
      const cycle = Number(c);
      if (!r || !RULES.has(r) || !Number.isInteger(cycle) || cycle < 0) return null;
      rules.push({ rule: r as RuleKind, cycle });
    }
    return rules.length && rules.length <= 3 ? { type: "ackstock", symbol: sym, rules } : null;
  }
  if (kind === "a" && p.length === 4) {
    const cycle = Number(p[3]);
    if (RULES.has(rule) && Number.isInteger(cycle) && cycle >= 0) return { type: "ack", symbol: sym, rule: rule as RuleKind, cycle };
  }
  if (kind === "m" && p.length === 3) {
    const minutes = Number(p[2]);
    if (Number.isInteger(minutes) && minutes > 0 && minutes <= 1440) return { type: "mute", symbol: sym, minutes };
  }
  if (kind === "t" && p.length === 5) {
    const pct = Number(p[3]);
    const cycle = Number(p[4]);
    if (RULES.has(rule) && Number.isFinite(pct) && pct > 0 && pct <= 100 && Number.isInteger(cycle) && cycle >= 0) return { type: "ackmove", symbol: sym, rule: rule as RuleKind, pct, cycle };
  }
  if ((kind === "x" || kind === "y") && p.length === 4 && RULES.has(rule)) {
    const cycle = Number(p[3]);
    if (Number.isInteger(cycle) && cycle >= 0) return { type: kind === "x" ? "chooser" : "typed", symbol: sym, rule: rule as RuleKind, cycle };
  }
  if (p.length === 3 && RULES.has(rule)) {
    const r = rule as RuleKind;
    if (kind === "c") return { type: "cancelchooser", symbol: sym, rule: r };
    if (kind === "d") return { type: "details", symbol: sym, rule: r };
  }
  if (p.length === 3 && FIELDS.has(rule)) {
    if (kind === "v") return { type: "saveset", symbol: sym, field: rule as SetField };
    if (kind === "z") return { type: "cancelset", symbol: sym, field: rule as SetField };
  }
  return null;
}
