/**
 * Shared text helpers for the "Glance Line" layout (DG-3, Alternative A).
 * Pure functions. Every line a renderer returns is at most MAX_LINE wide,
 * counting each emoji as 2 (the rule used by ux/check.mjs).
 */
import type { RuleKind } from "../core/ports";
import { formatEtMuscat } from "../core/time";
import { escapeHtml } from "./util";

export const MAX_LINE = 38;
export const e = escapeHtml;

export const ICON: Record<RuleKind, string> = { HIGH: "📈", LOW: "📉", VOLUME: "📊" };

const WIDE = "✅⏱⏰⛔❌⌨";

/** Visible width of one HTML line: tags removed, entities decoded, emoji = 2. */
export function glanceWidth(line: string): number {
  const plain = line
    .replace(/<\/?(b|i|code)>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  const cps = Array.from(plain);
  let w = 0;
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i] as string;
    const c = ch.codePointAt(0) as number;
    if (c === 0xfe0f || c === 0x200d) continue;
    w += c >= 0x1f000 || WIDE.includes(ch) || cps[i + 1] === "️" ? 2 : 1;
  }
  return w;
}

/** Longest line (visible width) of a message text. */
export const widest = (text: string): number => text.split("\n").reduce((m, l) => Math.max(m, glanceWidth(l)), 0);

/** Greedy packing of segments into lines that fit, joined by `sep`. Segments are HTML-safe already. */
export function pack(segs: string[], sep = " · "): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const s of segs) {
    if (!s) continue;
    const next = cur ? cur + sep + s : s;
    if (cur && glanceWidth(next) > MAX_LINE) {
      lines.push(cur);
      cur = s;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Word-wrap PLAIN text (not yet escaped) into escaped lines of at most `max` width. Long words are cut. */
export function wrapPlain(text: string, max = MAX_LINE): string[] {
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  const out: string[] = [];
  let cur = "";
  const push = () => { if (cur) out.push(e(cur)); cur = ""; };
  for (const word of clean.split(/\s+/).filter(Boolean)) {
    let w = word;
    while (Array.from(w).length > max) {
      push();
      const cut = Array.from(w);
      out.push(e(cut.slice(0, max).join("")));
      w = cut.slice(max).join("");
    }
    if (!w) continue;
    if (!cur) cur = w;
    else if (Array.from(cur + " " + w).length <= max) cur += " " + w;
    else { push(); cur = w; }
  }
  push();
  return out;
}

// ------------------------------------------------------------ numbers
/** Prices: 4 decimals below $1, 2 decimals from $1 up. */
export const priceDecimals = (n: number): number => (Math.abs(n) < 1 ? 4 : 2);
export const f2 = (n: number): string => n.toFixed(priceDecimals(n));
export const num = (n: number | undefined): string => (typeof n === "number" && Number.isFinite(n) ? f2(n) : "-");
/** Signed price change; `ref` (a price) decides the number of decimals. */
export const sgn = (n: number, ref: number = n): string => (n >= 0 ? "+" : "-") + Math.abs(n).toFixed(priceDecimals(ref));
export const sp = (n: number, d = 2): string => (n >= 0 ? "+" : "-") + Math.abs(n).toFixed(d) + "%";
export const pctOf = (x: number, base: number, d = 2): string => sp(((x - base) / base) * 100, d);
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Share counts: 6.10M, 13.6M, 850K, 420. */
export function vol(n: number | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "-";
  if (n >= 100_000) {
    const m = n / 1e6;
    return (m >= 10 ? m.toFixed(1) : m.toFixed(2)) + "M";
  }
  if (n >= 1000) return Math.round(n / 1000) + "K";
  return String(Math.round(n));
}

/** "2x", "1.5x" */
export const mult = (m: number): string => (Number.isInteger(m) ? String(m) : String(Math.round(m * 100) / 100)) + "x";
export const mult1 = (m: number): string => m.toFixed(1) + "x";

export function minutesText(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

// ------------------------------------------------------------ times
export const both = (ms: number): string => formatEtMuscat(ms);
/** "14:07 ET" */
export const etOnly = (ms: number): string => formatEtMuscat(ms).split(" / ")[0] as string;

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Mon 30 Nov" from a trading date YYYY-MM-DD. */
export function shortDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return e(date.slice(0, 12));
  const d = new Date(Date.UTC(+(m[1] as string), +(m[2] as string) - 1, +(m[3] as string)));
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

/** A dashboard link is used only when it is a plain https URL (never carries a secret). */
export function cleanDashboardUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (!s || s.length > 256 || /\s/.test(s) || !/^https:\/\/[^/?#@]+(\/[^?#]*)?$/i.test(s)) return undefined;
  return s;
}
