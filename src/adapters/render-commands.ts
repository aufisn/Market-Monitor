/**
 * Glance Line replies to Telegram commands and button flows (FR-5.6, FR-11.3).
 * Pure. Free text arrives as PLAIN strings and is escaped and word-wrapped here.
 */
import { nyDate } from "../core/time";
import { encodeCancelSet, encodeSaveSet, type SetField } from "./callbacks";
import { both, e, etOnly, f2, num, pack, pctOf, shortDate, vol, wrapPlain } from "./glance-fmt";
import type { Button, Rendered } from "./telegram";

/** A card: HTML head line (already safe) plus plain body lines. */
export function card(head: string, plain: string[], extra: { buttons?: Button[][]; silent?: boolean } = {}): Rendered {
  const lines = [head, ...plain.flatMap((l) => wrapPlain(l))];
  return { text: lines.join("\n"), ...(extra.buttons ? { buttons: extra.buttons } : {}), ...(extra.silent ? { silent: true } : {}) };
}

/** Plain message (usage hints, errors). */
export const renderText = (text: string): Rendered => ({ text: wrapPlain(text).join("\n") });

export const renderOk = (symbol: string, what: string, more: string[] = []): Rendered => card(`✅ <b>${e(symbol)}</b> ${e(what)}`, more);

// ------------------------------------------------------------ /help
export const HELP_LINES = [
  "/status · health, next reminder",
  "/watchlist · one line per stock",
  "/ticker NVDA · full card",
  "/today · alerts and acks so far",
  "/why NVDA 10:22 · why (no) alert",
  "/set NVDA high 148 (or low, 5%)",
  "/set NVDA volume 2x (or off)",
  "/ack NVDA · /ackall",
  "/mute NVDA 2h · /unmute [NVDA]",
  "/pause [NVDA] · /resume [NVDA]",
  "/test · send a test alert",
];
export const renderHelp = (): Rendered => ({ text: ["❓ <b>COMMANDS</b>", ...HELP_LINES.map(e)].join("\n") });

// ------------------------------------------------------------ /status
export interface StatusData {
  version: string;
  nowMs: number;
  marketOpen: boolean;
  closeMs?: number;
  nextOpenMs?: number;
  lastPollAgeSec: number | null;
  unack: number;
  nextReminderMs?: number;
  baselinesDone: number;
  baselinesTotal: number;
  calendar: "valid" | "expiring" | "expired";
  sentToday: number;
  failedToday: number;
  pausedAll: boolean;
}

export function renderStatus(d: StatusData): Rendered {
  const L = [`<b>STATUS</b> · v${e(d.version)}`];
  if (d.marketOpen) L.push(`Market OPEN${d.closeMs ? ` · closes ${etOnly(d.closeMs)}` : ""}`);
  else {
    const dow = d.nextOpenMs ? shortDate(nyDate(d.nextOpenMs)).split(" ")[0] : "";
    L.push(`Market CLOSED${d.nextOpenMs ? ` · opens ${dow} ${etOnly(d.nextOpenMs)}` : ""}`);
  }
  const age = d.lastPollAgeSec;
  if (age === null) L.push("Data · no poll yet");
  else {
    const state = !d.marketOpen ? "idle" : age > 90 ? "STALE" : "LIVE";
    L.push(`Data ${state} · last poll ${age < 120 ? `${age} s` : `${Math.round(age / 60)} min`} ago`);
  }
  if (d.pausedAll) L.push("⏸ <b>Alerts PAUSED</b> · /resume");
  L.push(`Unacknowledged: ${d.unack}`);
  if (d.nextReminderMs !== undefined) L.push(`Next reminder ${both(d.nextReminderMs)}`);
  L.push(...pack([`Baselines ${d.baselinesDone}/${d.baselinesTotal}`, `calendar ${d.calendar}`]));
  L.push(...pack([`Sent today ${d.sentToday}`, `failed ${d.failedToday}`]));
  return { text: L.join("\n") };
}

// ------------------------------------------------------------ /watchlist
export interface WatchRow {
  symbol: string;
  last?: number;
  high?: number;
  low?: number;
  alert: boolean;
  muted: boolean;
  paused: boolean;
  enabled: boolean;
}

export function renderWatchlist(rows: WatchRow[]): Rendered {
  if (rows.length === 0) return { text: "📋 <b>WATCHLIST</b> · empty\nAdd one: /set NVDA high 148" };
  const L = [`📋 <b>WATCHLIST</b> · ${rows.length} stock${rows.length === 1 ? "" : "s"}`];
  for (const r of rows) {
    const flags = [r.alert ? "🚨" : "", r.muted ? "🔕" : "", r.paused ? "⏸" : "", r.enabled ? "" : "off"].filter(Boolean).join(" ");
    L.push(...pack([`<b>${e(r.symbol)}</b> ${num(r.last)}`, r.low !== undefined ? `L ${f2(r.low)}` : "", r.high !== undefined ? `H ${f2(r.high)}` : "", flags]));
  }
  return { text: L.join("\n") };
}

// ------------------------------------------------------------ /ticker
export interface TickerData {
  symbol: string;
  nowMs: number;
  last?: number;
  lastMs?: number;
  prevClose?: number;
  open?: number;
  high?: number;
  low?: number;
  volumeText?: string;
  cumVolume?: number;
  multiple?: number;
  rules: { rule: string; state: string; since?: number }[];
  mutedUntilMs?: number;
  paused: boolean;
  enabled: boolean;
  notes?: string;
}

export function renderTicker(d: TickerData): Rendered {
  const L = [`🔎 <b>${e(d.symbol)}</b>${d.enabled ? "" : " · off"}${d.paused ? " · paused" : ""}`];
  if (d.last !== undefined && d.prevClose !== undefined) L.push(...pack([`Last ${f2(d.last)}`, pctOf(d.last, d.prevClose)]));
  else L.push(`Last ${num(d.last)}`);
  L.push(`Prev Close ${num(d.prevClose)}`, `Opening (IEX) ${num(d.open)}`);
  L.push(...pack([`HIGH ${num(d.high)}`, `LOW ${num(d.low)}`]));
  if (d.volumeText) L.push(...wrapPlain(`Volume rule ${d.volumeText}`));
  L.push(...pack([`IEX volume ${vol(d.cumVolume)}`, d.multiple !== undefined ? `${d.multiple.toFixed(1)}x avg` : ""]));
  for (const r of d.rules) L.push(...wrapPlain(`${r.rule} ${r.state}${r.since !== undefined ? ` since ${etOnly(r.since)}` : ""}`));
  if (d.mutedUntilMs !== undefined && d.mutedUntilMs > d.nowMs) L.push(`🔕 Muted until ${etOnly(d.mutedUntilMs)}`);
  if (d.lastMs !== undefined) L.push(`Price at ${both(d.lastMs)}`);
  if (d.notes) L.push(...wrapPlain(`Note: ${d.notes}`));
  return { text: L.join("\n") };
}

// ------------------------------------------------------------ /today
export interface TodayData {
  date: string;
  counts: Record<string, number>;
  events: { tMs: number; text: string }[];
}

export function renderToday(d: TodayData): Rendered {
  const c = d.counts;
  const L = [`🗓 <b>TODAY</b> · ${shortDate(d.date)}`];
  L.push(...pack([`Alerts ${(c.alerts ?? 0) + (c.lateAlerts ?? 0)}`, `reminders ${c.reminders ?? 0}`]));
  L.push(...pack([`Acknowledged ${c.acks ?? 0}`, `open at close ${c.unacked ?? 0}`]));
  if (d.events.length === 0) L.push("Nothing has happened yet.");
  for (const ev of d.events) L.push(...wrapPlain(`${etOnly(ev.tMs).slice(0, 5)} ${ev.text}`));
  return { text: L.join("\n") };
}

// ------------------------------------------------------------ /why
export interface WhyData {
  symbol: string;
  atMs: number;
  /** Plain-text sentences, already built from the log, the config history and the rule state. */
  lines: string[];
}

export function renderWhy(d: WhyData): Rendered {
  return card(`🔍 <b>WHY ${e(d.symbol)}</b> · ${e(etOnly(d.atMs))}`, d.lines);
}

// ------------------------------------------------------------ /set
export interface SetDone {
  symbol: string;
  label: string; // HIGH, LOW or VOLUME
  setText: string; // "148.00", "2x", "off"
  fromPrevClose?: { pct: string; prevClose: number };
  was?: string;
  last?: number;
  rearmed: boolean;
  added?: boolean;
}

export function renderSetDone(d: SetDone): Rendered {
  const L = [`✅ <b>${e(d.symbol)} ${e(d.label)}</b> ${d.setText === "off" ? "turned off" : `set to ${e(d.setText)}`}`];
  if (d.fromPrevClose) L.push(`${d.fromPrevClose.pct} from Prev Close ${f2(d.fromPrevClose.prevClose)}`);
  const was = [d.was !== undefined ? `Was ${d.was}` : "", d.last !== undefined ? `last ${f2(d.last)}` : ""];
  L.push(...pack(was));
  if (d.added) L.push("Added to the watchlist.");
  L.push(d.rearmed ? "Re-armed now." : "No change.");
  return { text: L.join("\n") };
}

export function renderSetConfirm(symbol: string, rule: "HIGH" | "LOW", level: number, last: number | undefined, field: SetField): Rendered {
  const L = [`⚠️ <b>${e(symbol)} ${rule} ${f2(level)}</b>`];
  if (last !== undefined) L.push(`Last ${f2(last)} is already ${rule === "HIGH" ? "above" : "below"} it.`);
  L.push("<b>This will alert immediately. Save?</b>");
  return {
    text: L.join("\n"),
    buttons: [[{ text: "✅ Save and alert", data: encodeSaveSet(symbol, field) }], [{ text: "← Cancel", data: encodeCancelSet(symbol, field) }]],
  };
}

export const renderSetSaved = (symbol: string, label: string, levelText: string): Rendered => ({
  text: [`✅ <b>${e(symbol)} ${e(label)}</b> saved: ${e(levelText)}`, "Alert follows at the next poll."].join("\n"),
});

export const renderSetCancelled = (symbol: string, label: string): Rendered => ({ text: `← <b>${e(symbol)} ${e(label)}</b> not changed` });
