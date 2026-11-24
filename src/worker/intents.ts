/** Telegram text commands -> typed intents (FR-5.6). Pure, no I/O. */
import type { ThresholdInput, VolumeInput } from "../core/ports";
import { SYMBOL_RE } from "../adapters/callbacks";
import { isValidTradingDate } from "./dates";

export type Intent =
  | { type: "ack"; symbol: string }
  | { type: "ackall" }
  | { type: "status" }
  | { type: "set"; symbol: string; field: "high" | "low"; value: ThresholdInput | null; confirm: boolean }
  | { type: "set"; symbol: string; field: "volume"; value: VolumeInput | null; confirm: boolean }
  | { type: "mute"; symbol: string; minutes: number }
  | { type: "unmute"; symbol?: string }
  | { type: "pause"; symbol?: string }
  | { type: "resume"; symbol?: string }
  | { type: "ticker"; symbol: string }
  | { type: "watchlist" }
  | { type: "today" }
  | { type: "why"; symbol: string; hour: number; minute: number; date?: string }
  | { type: "test" }
  | { type: "help" }
  | { type: "invalid"; message: string };

const MAX_MUTE_MIN = 7 * 1440;

function sym(s: string | undefined): string | null {
  const u = s?.toUpperCase();
  return u && SYMBOL_RE.test(u) ? u : null;
}

export function parseDuration(s: string | undefined): number | null {
  if (!s) return 60;
  const m = /^(\d{1,4})(m|h|d)?$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "m").toLowerCase();
  const min = unit === "d" ? n * 1440 : unit === "h" ? n * 60 : n;
  return min > 0 && min <= MAX_MUTE_MIN ? min : null;
}

export function parseCommand(input: string): Intent | null {
  const t = input.trim().slice(0, 200);
  if (!t.startsWith("/")) return null;
  const parts = t.split(/\s+/);
  const cmd = (parts[0] ?? "").slice(1).split("@")[0]?.toLowerCase() ?? "";
  const a = parts.slice(1);
  switch (cmd) {
    case "start":
    case "help":
      return { type: "help" };
    case "status":
      return { type: "status" };
    case "test":
      return { type: "test" };
    case "ackall":
      return { type: "ackall" };
    case "watchlist":
      return { type: "watchlist" };
    case "today":
      return { type: "today" };
    case "ticker": {
      const s = sym(a[0]);
      return s ? { type: "ticker", symbol: s } : { type: "invalid", message: "Usage: /ticker SYMBOL" };
    }
    case "why": {
      const s = sym(a[0]);
      const t = /^(\d{1,2}):(\d{2})$/.exec(a[1] ?? "");
      const hour = t ? Number(t[1]) : NaN;
      const minute = t ? Number(t[2]) : NaN;
      if (!s || !t || hour > 23 || minute > 59 || a.length > 3) return { type: "invalid", message: "Usage: /why SYMBOL HH:MM [YYYY-MM-DD] (New York time)" };
      if (a[2] !== undefined && !isValidTradingDate(a[2])) return { type: "invalid", message: "Date must be a real day from 2026-01-01 to the end of the calendar, as YYYY-MM-DD." };
      return { type: "why", symbol: s, hour, minute, ...(a[2] ? { date: a[2] } : {}) };
    }
    case "ack": {
      const s = sym(a[0]);
      return s ? { type: "ack", symbol: s } : { type: "invalid", message: "Usage: /ack SYMBOL" };
    }
    case "pause":
    case "resume":
    case "unmute": {
      if (a[0] === undefined) return { type: cmd };
      const s = sym(a[0]);
      return s ? { type: cmd, symbol: s } : { type: "invalid", message: `Usage: /${cmd} [SYMBOL]` };
    }
    case "mute": {
      const s = sym(a[0]);
      const min = parseDuration(a[1]);
      if (!s || min === null) return { type: "invalid", message: "Usage: /mute SYMBOL [30m|2h|1d] (at most 7 days)" };
      return { type: "mute", symbol: s, minutes: min };
    }
    case "set":
      return parseSet(a);
    default:
      return { type: "invalid", message: "Unknown command. Send /help." };
  }
}

const USAGE = "Usage: /set SYMBOL high|low 250 or 5% or off, /set SYMBOL volume 2x or 500000 or off";

function parseSet(a: string[]): Intent {
  const s = sym(a[0]);
  const field = a[1]?.toLowerCase();
  const raw = a[2]?.toLowerCase();
  const confirm = a[3]?.toLowerCase() === "confirm";
  if (!s || !raw || (field !== "high" && field !== "low" && field !== "volume") || (a.length > 3 && !confirm) || a.length > 4) {
    return { type: "invalid", message: USAGE };
  }
  const clear = raw === "off" || raw === "none" || raw === "clear";
  if (field === "volume") {
    if (clear) return { type: "set", symbol: s, field, value: null, confirm };
    const mult = /^(\d+(?:\.\d+)?)x$/.exec(raw);
    if (mult) return { type: "set", symbol: s, field, value: { mode: "multiple", value: Number(mult[1]) }, confirm };
    if (/^\d{1,13}$/.test(raw)) return { type: "set", symbol: s, field, value: { mode: "absolute", value: Number(raw) }, confirm };
    return { type: "invalid", message: USAGE };
  }
  if (clear) return { type: "set", symbol: s, field, value: null, confirm };
  const pct = /^([+-]?\d+(?:\.\d+)?)%$/.exec(raw);
  if (pct) return { type: "set", symbol: s, field, value: { mode: "percent", value: Number(pct[1]) }, confirm };
  const dol = /^\$?(\d+(?:\.\d+)?)$/.exec(raw);
  if (dol) return { type: "set", symbol: s, field, value: { mode: "dollar", value: Number(dol[1]) }, confirm };
  return { type: "invalid", message: USAGE };
}

/** Typed value for "Ack + move": a price (148.00) or a percent further out (+3%). */
export function parseMoveInput(text: string): { price: number } | { pct: number } | null {
  const t = text.trim().replace(",", ".").slice(0, 20);
  const pct = /^\+?(\d+(?:\.\d+)?)%$/.exec(t);
  if (pct) {
    const v = Number(pct[1]);
    return v > 0 && v <= 100 ? { pct: v } : null;
  }
  const price = /^\$?(\d+(?:\.\d+)?)$/.exec(t);
  if (price) {
    const v = Number(price[1]);
    return v > 0 && v <= 1_000_000 ? { price: v } : null;
  }
  return null;
}
