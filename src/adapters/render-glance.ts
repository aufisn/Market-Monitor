/**
 * Production renderer, DG-3 decision: Alternative A "Glance Line" (ux/alternatives.md).
 * Pure: OutboundEvent in, {text, buttons, silent} out. No I/O, no clock (the caller passes nowMs).
 *
 * Notification rule (marker in alternatives.md): first alerts, late alerts, reminders, the briefing,
 * unacknowledged-at-close, operational notices and the test alert notify; READY, SESSION ENDED and the
 * Details card are silent. Edits (acknowledge) never notify.
 *
 * Every dynamic value goes through escapeHtml; every line is at most 38 wide (emoji = 2).
 */
import { sessionFor } from "../core/calendar";
import type { Baseline, MarketState, OutboundEvent, RuleKind, RuleState, StockConfig } from "../core/ports";
import { avgCumAt, resolveThreshold } from "../core/rules";
import { MIN, nyLocalToUtc } from "../core/time";
import {
  encodeAck, encodeAckMove, encodeAckStock, encodeBriefDetails, encodeCancelChooser, encodeChooser, encodeDetails,
  encodeMute, encodeSeen, encodeTyped,
} from "./callbacks";
import {
  ICON, both, e, etOnly, f2, glanceWidth, minutesText, mult, mult1, num, pack, pctOf, priceDecimals, sgn, shortDate, sp, vol, wrapPlain,
} from "./glance-fmt";
import type { Button, Rendered } from "./telegram";

export interface GlanceCtx {
  nowMs: number;
  /** Already validated https URL, or undefined (button omitted). */
  dashboardUrl?: string;
  /** Watchlist and baselines: only needed for the briefing and the volume multiple. */
  stocks?: StockConfig[];
  baselines?: Baseline[];
}

const TG_LIMIT = 4000; // below Telegram's 4096 so a part never gets cut

// ------------------------------------------------------------ small pure helpers (also used by the webhook)
/** Ack + move maths (FR-4.7): HIGH goes up, LOW goes down, by pct percent of the threshold's own value. */
export function moveBy(rule: "HIGH" | "LOW", current: number, pct: number): number {
  const raw = current * (rule === "HIGH" ? 1 + pct / 100 : 1 - pct / 100);
  const q = 10 ** priceDecimals(Math.max(current, raw)); // 4 decimals below $1, else 2
  const rnd = (n: number) => Math.round(n * q) / q;
  const v = rnd(raw);
  if (rule === "HIGH" ? v > current : v < current) return v;
  return rnd(current + (rule === "HIGH" ? 1 : -1) / q); // a move must never round to "no change"
}

export interface VolFacts { cum?: number; avg?: number; multiple?: number }
/** Cumulative IEX volume against the baseline average at the same minute (RVOL). */
export function volumeFacts(baseline: Baseline | null | undefined, date: string, atMs: number, cum: number | undefined): VolFacts {
  const s = sessionFor(date);
  if (!baseline || baseline.status !== "OK" || s.kind !== "open" || cum === undefined) return { cum };
  const avg = avgCumAt(baseline, Math.max(0, (atMs - s.open) / MIN));
  return avg > 0 ? { cum, avg, multiple: cum / avg } : { cum };
}

const baselineOf = (ctx: GlanceCtx, symbol: string): Baseline | undefined => ctx.baselines?.find((b) => b.symbol === symbol);
const stockOf = (ctx: GlanceCtx, symbol: string): StockConfig | undefined => ctx.stocks?.find((s) => s.symbol === symbol);
const dash = (ctx: Pick<GlanceCtx, "dashboardUrl">): Button[] => (ctx.dashboardUrl ? [{ text: "📊 Dashboard", url: ctx.dashboardUrl }] : []);
const body = (lines: string[]): string => lines.join("\n");
const rname = (r: { symbol: string; rule: RuleKind }): string => `${e(r.symbol)} ${r.rule}`;

// ------------------------------------------------------------ keyboards
/** Acknowledge alone on row 1 so a night-time mis-tap lands on something harmless. */
export function alertKeyboard(r: Pick<RuleState, "symbol" | "rule" | "cycle">, ctx: Pick<GlanceCtx, "dashboardUrl">): Button[][] {
  const row2: Button[] = [{ text: "ℹ️ Details", data: encodeDetails(r.symbol, r.rule) }];
  if (r.rule !== "VOLUME") row2.push({ text: "↗ Ack + move", data: encodeChooser(r.symbol, r.rule, r.cycle) }); // v1: no move for VOLUME
  return [
    [{ text: "✅ Acknowledge", data: encodeAck(r.symbol, r.rule, r.cycle) }],
    row2,
    [{ text: "🔕 Mute 1h", data: encodeMute(r.symbol, 60) }, ...dash(ctx)],
  ];
}

/** Chooser shown after "Ack + move" (keyboard swap on the alert). */
export function chooserKeyboard(symbol: string, rule: "HIGH" | "LOW", current: number, cycle: number): Button[][] {
  const label = (p: number) => `${rule === "HIGH" ? "+" : "-"}${p}% → ${f2(moveBy(rule, current, p))}`;
  return [
    [{ text: label(1), data: encodeAckMove(symbol, rule, 1, cycle) }, { text: label(2), data: encodeAckMove(symbol, rule, 2, cycle) }],
    [{ text: "⌨ Type a value", data: encodeTyped(symbol, rule, cycle) }],
    [{ text: "← Cancel", data: encodeCancelChooser(symbol, rule) }],
  ];
}

/** ForceReply prompt for a typed Ack + move value. */
export function renderMovePrompt(symbol: string, rule: "HIGH" | "LOW", last: number | undefined): Rendered {
  const lines = [`⌨ Reply with the new ${e(symbol)} ${rule}:`, "a price (148.00) or a percent (+3%)"];
  if (last !== undefined) lines.push(`Must be ${rule === "HIGH" ? "above" : "below"} last ${f2(last)}.`);
  return { text: body(lines), forceReply: "148.00 or +3%" };
}

// ------------------------------------------------------------ alerts
function firstAlert(ev: Extract<OutboundEvent, { type: "FIRST_ALERT" }>, ctx: GlanceCtx): Rendered {
  const { rule: r, market: m } = ev;
  const t0 = r.t0Ms ?? ctx.nowMs;
  const lines: string[] = [];
  if (r.rule === "VOLUME") {
    const f = volumeFacts(baselineOf(ctx, r.symbol), r.date, t0, r.t0Value ?? m.cumVolume);
    lines.push(`🚨 NEW 📊 <b>${rname(r)}</b> ${f.multiple !== undefined ? mult1(f.multiple) : vol(f.cum)}`);
    lines.push(...pack([`IEX volume ${vol(f.cum)}`, f.avg !== undefined ? `avg ${vol(f.avg)}` : `limit ${vol(ev.threshold)}`]));
  } else {
    const px = r.t0Value ?? m.last?.p;
    lines.push(`🚨 NEW ${ICON[r.rule]} <b>${rname(r)}</b> ${num(px)}`);
    const f = volumeFacts(baselineOf(ctx, r.symbol), r.date, t0, m.cumVolume);
    const chg = px !== undefined && m.prev ? pctOf(px, m.prev.close) : undefined;
    lines.push(...pack([chg ?? "", f.multiple !== undefined ? `IEX vol ${mult1(f.multiple)}` : ""]));
  }
  lines.push(both(t0));
  return { text: body(lines), buttons: alertKeyboard(r, ctx) };
}

function lateAlert(ev: Extract<OutboundEvent, { type: "LATE_ALERT" }>, ctx: GlanceCtx): Rendered {
  const { rule: r } = ev;
  const found = r.t0Ms ?? ctx.nowMs;
  const shown = r.rule === "VOLUME" ? vol(ev.threshold) : num(ev.threshold);
  const lines = [`⏱ <b>LATE</b> ${ICON[r.rule]} <b>${rname(r)}</b> ${shown}`];
  if (r.rule === "VOLUME") lines.push(`Reached by ${etOnly(ev.barTimeMs)}`);
  else lines.push(...pack([`Touched ${etOnly(ev.barTimeMs)}`, `bar ${r.rule === "HIGH" ? "high" : "low"} ${num(ev.barPrice)}`]));
  lines.push(...pack([`Found ${etOnly(found)}`, "runs were missed"]));
  lines.push(both(ev.barTimeMs));
  return { text: body(lines), buttons: alertKeyboard(r, ctx) };
}

const levelText = (r: RuleState): string => (r.rule === "VOLUME" ? `≥ ${vol(r.thresholdAtT0)}` : num(r.thresholdAtT0));

function reminder(ev: Extract<OutboundEvent, { type: "REMINDER" }>, ctx: GlanceCtx): Rendered {
  const rules = [...ev.rules].sort((a, b) => (a.t0Ms ?? 0) - (b.t0Ms ?? 0)); // oldest first (FR-4.13)
  const first = rules[0] as RuleState;
  const sym = first.symbol;
  const open = (r: RuleState) => minutesText(ctx.nowMs - (r.t0Ms ?? ctx.nowMs));
  const px = ev.market.last?.p;
  const now = ["Now " + num(px), px !== undefined && ev.market.prev ? pctOf(px, ev.market.prev.close) : ""];
  const inside = ev.backInside ? ["Price now back inside your band"] : [];
  if (rules.length === 1) {
    const r = first;
    const lines = [
      `🔁 <b>REMINDER ${r.remindersSent}</b> · not a new alert`,
      ...pack([`${ICON[r.rule]} ${rname(r)} ${levelText(r)}`, `${open(r)} open`]),
      ...pack(now),
      ...inside,
      both(ctx.nowMs),
    ];
    return { text: body(lines), buttons: alertKeyboard(r, ctx) };
  }
  const lines = [`🔁 <b>REMINDERS</b> · not new alerts`, ...pack([`<b>${e(sym)}</b>`, ...now])];
  for (const r of rules) lines.push(...pack([`${ICON[r.rule]} ${r.rule} ${levelText(r)}`, `#${r.remindersSent}`, `${open(r)} open`]));
  lines.push(...inside, both(ctx.nowMs));
  const buttons: Button[][] = [
    ...rules.map((r): Button[] => [{ text: `✅ Ack ${r.rule}`, data: encodeAck(r.symbol, r.rule, r.cycle) }]),
    [{ text: `✅ Ack all ${sym}`, data: encodeAckStock(sym, rules) }],
    [{ text: "ℹ️ Details", data: encodeDetails(sym, first.rule) }, { text: "🔕 Mute 1h", data: encodeMute(sym, 60) }],
  ];
  if (ctx.dashboardUrl) buttons.push(dash(ctx));
  return { text: body(lines), buttons };
}

/** The edit that replaces an alert once it is acknowledged (FR-4.4): buttons removed. */
export function renderAckConfirm(r: RuleState, nowMs: number, moved?: { from: number; to: number }): Rendered {
  const lines = [`✅ <b>${rname(r)}</b> acknowledged`, `Acknowledged ${both(r.ackMs ?? nowMs)}`];
  if (moved && r.rule !== "VOLUME") {
    const pct = (moved.to / moved.from - 1) * 100;
    const p = Math.abs(pct) < 10 ? Math.round(pct * 100) / 100 : Math.round(pct * 10) / 10;
    lines.push(...pack([`${r.rule} moved ${f2(moved.from)} → ${f2(moved.to)}`, `(${p >= 0 ? "+" : "-"}${Math.abs(p)}%)`], " "));
    lines.push("Re-armed. Quiet until crossed again.");
  } else lines.push("No more reminders for this alert.");
  return { text: body(lines) };
}

// ------------------------------------------------------------ details card (FR-5.5), silent reply
export interface DetailsInput {
  rule: RuleState;
  market: MarketState;
  /** Dollar levels in force now. */
  high?: number;
  low?: number;
  /** Text of the volume limit, for example "2x average" or "500K shares". */
  volumeLimit?: string;
  volume?: VolFacts;
  nowMs: number;
  replyTo?: number;
}

export function renderDetails(d: DetailsInput): Rendered {
  const { rule: r, market: m } = d;
  const px = m.last?.p;
  const L: string[] = [`ℹ️ <b>${rname(r)}</b> · details`];
  L.push("<b>Price</b>");
  if (px !== undefined && m.prev) L.push(...pack([`Last ${f2(px)}`, `${sgn(px - m.prev.close, px)} (${pctOf(px, m.prev.close)})`]));
  else L.push(`Last ${num(px)}`);
  L.push(`Prev Close ${num(m.prev?.close)}`, `Opening (IEX) ${num(m.open)}`);
  if (m.lastPollMs !== undefined && d.nowMs - m.lastPollMs > 60_000) L.push(`Data ${Math.round((d.nowMs - m.lastPollMs) / 1000)} s old`);
  L.push("<b>Levels</b>");
  if (r.rule === "VOLUME") L.push(`VOLUME ≥ ${e(d.volumeLimit ?? vol(r.thresholdAtT0))}`);
  else L.push(...pack([`HIGH ${num(d.high)}`, `LOW ${num(d.low)}`]));
  if (r.t0Value !== undefined && r.rule !== "VOLUME") L.push(`Crossed at ${f2(r.t0Value)}`);
  L.push("<b>Volume</b>");
  const v = d.volume ?? {};
  L.push(...pack([`IEX volume ${vol(v.cum ?? m.cumVolume)}`, v.multiple !== undefined ? `${mult1(v.multiple)} avg` : ""]));
  L.push("<b>Time</b>");
  if (r.t0Ms !== undefined) L.push(`${r.late ? "Found" : "Crossed"} ${both(r.t0Ms)}`);
  if (r.touchedAtMs !== undefined) L.push(`Touched ${both(r.touchedAtMs)}`);
  if (r.state === "ACKNOWLEDGED") L.push(`Acknowledged ${both(r.ackMs ?? d.nowMs)}`);
  else if (r.state === "UNACKNOWLEDGED_AT_CLOSE") L.push("Unacknowledged at close");
  else if (r.state === "TRIGGERED" || r.state === "REPEATING") {
    L.push(...pack([`Unacknowledged ${minutesText(d.nowMs - (r.t0Ms ?? d.nowMs))}`, `alert #${r.cycle}`]));
    if (r.remindersSent > 0) L.push(`Reminder ${r.remindersSent} sent`);
  }
  return { text: body(L), silent: true, ...(d.replyTo !== undefined ? { replyTo: d.replyTo } : {}) };
}

// ------------------------------------------------------------ briefing (FR-7)
const gapOf = (s: MarketState): number => (s.open !== undefined && s.prev ? (s.open - s.prev.close) / s.prev.close : NaN);
const absGap = (s: MarketState): number => (Number.isNaN(gapOf(s)) ? -1 : Math.abs(gapOf(s)));

function crossedAtOpen(s: MarketState, cfg: StockConfig | undefined): { rule: "HIGH" | "LOW"; level: number } | undefined {
  if (!cfg || s.open === undefined) return undefined;
  const hi = resolveThreshold(cfg.high, s.prev?.close);
  const lo = resolveThreshold(cfg.low, s.prev?.close);
  if (hi !== undefined && s.open >= hi) return { rule: "HIGH", level: hi };
  if (lo !== undefined && s.open <= lo) return { rule: "LOW", level: lo };
  return undefined;
}

function briefHead(s: MarketState, cross: boolean): string {
  const g = gapOf(s);
  const warn = cross ? "⚠️ " : "";
  if (s.open === undefined) return `${warn}<b>${e(s.symbol)}</b> no opening price yet`;
  return `${warn}<b>${e(s.symbol)}</b> ${Number.isNaN(g) ? "" : sp(g * 100) + " "}Open(IEX) ${f2(s.open)}`;
}

function briefStock(s: MarketState, ctx: GlanceCtx, expanded: boolean): string[] {
  const cfg = stockOf(ctx, s.symbol);
  const cross = crossedAtOpen(s, cfg);
  const L: string[] = [briefHead(s, !!cross)];
  const p = s.prev;
  if (!p) {
    L.push("No Previous Close yet");
  } else if (!expanded) {
    L.push(...pack([`PC ${f2(p.close)}`, `yHigh ${f2(p.high)}`]));
    if (cross) L.push(`<b>${cross.rule} ${f2(cross.level)} crossed at open</b>`);
    return L;
  } else {
    L.push(...pack([`PC ${f2(p.close)}`, `yHigh ${f2(p.high)}`, `yLow ${f2(p.low)}`]));
    L.push(`Yesterday IEX volume ${vol(p.volume)}`);
  }
  if (!expanded) return L;
  const lo = resolveThreshold(cfg?.low, p?.close);
  const hi = resolveThreshold(cfg?.high, p?.close);
  const vs = (lvl: number) => (s.open !== undefined ? ` (${pctOf(lvl, s.open, 1)} vs open)` : "");
  if (lo !== undefined) L.push(`LOW ${f2(lo)}${vs(lo)}${cross?.rule === "LOW" ? " ⚠️" : ""}`);
  if (hi !== undefined) L.push(`HIGH ${f2(hi)}${vs(hi)}${cross?.rule === "HIGH" ? " ⚠️" : ""}`);
  const vc = cfg?.volume;
  const b = baselineOf(ctx, s.symbol);
  if (vc?.mode === "absolute") L.push(`Volume limit ${vol(vc.value)} shares`);
  else if (b && b.status === "OK") {
    const m = vc?.mode === "multiple" ? vc.value : 2;
    L.push(...pack([`IEX avg/day ${vol(b.avgFullDay)}`, `${mult(m)} = ${vol(b.avgFullDay * m)}`]));
    const session = sessionFor(s.date);
    const at = (h: number) => {
      const t = nyLocalToUtc(s.date, h);
      if (session.kind !== "open" || t <= session.open || t >= session.close) return undefined;
      return `${h}:00 ${vol(m * avgCumAt(b, (t - session.open) / MIN))}`;
    };
    const [t10, t11, t13] = [10, 11, 13].map(at);
    const l1 = [t10, t11].filter(Boolean).join(" · ");
    if (l1) L.push(`${mult(m)} IEX by ${l1}`);
    if (t13) L.push(`${mult(m)} IEX by ${t13}`);
  } else if (vc) L.push("No volume baseline yet");
  if (cross) L.push(`<b>${cross.rule} crossed at open - alert follows</b>`);
  return L;
}

function briefing(ev: Extract<OutboundEvent, { type: "BRIEFING" }>, ctx: GlanceCtx, expanded: boolean): Rendered[] {
  const session = sessionFor(ev.date);
  const closeLine = session.kind === "open" ? `${session.early ? "Early close" : "Close"} ${both(session.close)}` : "";
  const head = (n: number, total: number): string[] => [
    `☀️ <b>OPENING BRIEFING</b>${total > 1 ? ` (${n}/${total})` : ""}`,
    ...pack([shortDate(ev.date), both(ctx.nowMs)]),
    ...(closeLine ? [closeLine] : []),
    "Crossed first, then by gap · IEX",
    "PC = Previous Close",
  ];
  // FR-7.3: stocks already across a threshold first, then the rest by absolute gap, largest first.
  const crossed = (m: MarketState) => (crossedAtOpen(m, stockOf(ctx, m.symbol)) ? 1 : 0);
  const stocks = [...ev.stocks].sort((a, b) => crossed(b) - crossed(a) || absGap(b) - absGap(a));
  const blocks = stocks.map((s) => briefStock(s, ctx, expanded).join("\n"));
  const foot = expanded ? [] : ["<i>Tap Details for volume levels.</i>"];
  // Greedy split under the Telegram limit; each stock block stays whole.
  const parts: string[][] = [[]];
  let size = 0;
  const reserve = head(9, 9).join("\n").length + 60;
  for (const b of blocks) {
    if (size + b.length + 2 > TG_LIMIT - reserve && (parts[parts.length - 1] as string[]).length > 0) {
      parts.push([]);
      size = 0;
    }
    (parts[parts.length - 1] as string[]).push(b);
    size += b.length + 2;
  }
  const buttons: Button[][] = expanded ? [] : [[{ text: "ℹ️ Details", data: encodeBriefDetails() }, ...dash(ctx)]];
  return parts.map((blks, i) => {
    const last = i === parts.length - 1;
    const text = [head(i + 1, parts.length).join("\n"), ...blks, ...(last ? foot : [])].join("\n\n");
    const r: Rendered = { text };
    if (last && buttons.length) r.buttons = buttons;
    if (i > 0 || expanded) r.silent = true; // only the first message of the briefing makes a sound
    return r;
  });
}

// ------------------------------------------------------------ session messages
function unackAtClose(ev: Extract<OutboundEvent, { type: "UNACK_AT_CLOSE" }>, ctx: GlanceCtx): Rendered {
  const rules = [...ev.rules].sort((a, b) => (a.t0Ms ?? 0) - (b.t0Ms ?? 0));
  const s = sessionFor(ev.date);
  const L = ["🔕 <b>UNACKNOWLEDGED AT CLOSE</b>", `${rules.length} alert${rules.length === 1 ? "" : "s"} · no more reminders`];
  for (const r of rules) L.push(...pack([`${ICON[r.rule]} ${rname(r)}`, `since ${r.t0Ms !== undefined ? etOnly(r.t0Ms) : "?"}${r.late ? " (late)" : ""}`]));
  if (s.kind === "open") L.push(`Closed ${both(s.close)}`);
  L.push("They re-arm fresh at the next open.");
  return { text: body(L), buttons: [[{ text: "✅ Mark all seen", data: encodeSeen() }], ...(ctx.dashboardUrl ? [dash(ctx)] : [])] };
}

/** Edit after "Mark all seen". */
export function renderSeen(nowMs: number): Rendered {
  const mu = new Date(nowMs + 4 * 3_600_000);
  const hhmm = `${String(mu.getUTCHours()).padStart(2, "0")}:${String(mu.getUTCMinutes()).padStart(2, "0")}`;
  return { text: body(["🔕 <b>UNACKNOWLEDGED AT CLOSE</b>", `Marked as seen ${hhmm} Muscat`, "Nothing was sent after the close."]) };
}

const asNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 30) : []);

function ready(ev: Extract<OutboundEvent, { type: "READY" }>): Rendered {
  const i = ev.info;
  const s = sessionFor(ev.date);
  const n = asNum(i.stocksActive);
  const done = asNum(i.baselinesDone);
  const total = asNum(i.baselinesTotal);
  const left = asNum(i.calendarDaysLeft);
  const L = [`🟢 <b>READY</b> · ${shortDate(ev.date)}`];
  L.push(...pack([n !== undefined ? `${n} stock${n === 1 ? "" : "s"} active` : "", done !== undefined && total !== undefined ? `Baselines ${done}/${total}` : ""]));
  L.push(`Calendar ${left !== undefined && left <= 30 ? `OK · ${left} days left` : "OK"}`);
  const nb = asList(i.noBaseline);
  if (nb.length) L.push(...wrapPlain(`No baseline: ${nb.join(", ")}`));
  const mp = asList(i.missingPrevClose);
  if (mp.length) L.push(...wrapPlain(`No Prev Close: ${mp.join(", ")}`));
  if (s.kind === "open") L.push(`Open ${both(s.open)}`, `${s.early ? "Early close" : "Close"} ${both(s.close)}`);
  return { text: body(L), silent: true };
}

function sessionEnded(ev: Extract<OutboundEvent, { type: "SESSION_ENDED" }>): Rendered {
  const c = ev.counts;
  const alerts = (c.alerts ?? 0) + (c.lateAlerts ?? 0);
  const s = sessionFor(ev.date);
  const L = [`🏁 <b>SESSION ENDED</b> · ${shortDate(ev.date)}`];
  if (s.kind === "open") L.push(`Closed ${both(s.close)}`);
  L.push(...pack([`Alerts ${alerts}${c.lateAlerts ? ` (${c.lateAlerts} late)` : ""}`, `reminders ${c.reminders ?? 0}`]));
  L.push(...pack([`Acknowledged ${c.acks ?? 0}`, `open at close ${c.unacked ?? 0}`]));
  return { text: body(L), silent: true };
}

const GAP_NOTE = ["Alerts may be late, not lost.", "Gap scan runs when data returns."];
const OPS: Record<string, { title: string; sub: string; extra?: string[] }> = {
  DATA_ERROR: { title: "DATA PROBLEM", sub: "provider error", extra: GAP_NOTE },
  GAP_SCAN_ERROR: { title: "DATA PROBLEM", sub: "gap scan", extra: GAP_NOTE },
  BASELINE_ERROR: { title: "BASELINE PROBLEM", sub: "volume data" },
  CALENDAR_EXPIRED: { title: "CALENDAR EXPIRED", sub: "no alerts" },
  CALENDAR_EXPIRING: { title: "CALENDAR EXPIRING", sub: "update soon" },
  MISSING_SECRETS: { title: "SETUP PROBLEM", sub: "alerting stopped" },
  AUTH_FLOOD: { title: "LOGIN FLOOD", sub: "dashboard locked" },
};

function opsNotice(ev: Extract<OutboundEvent, { type: "OPS_NOTICE" }>, ctx: GlanceCtx): Rendered {
  const known = OPS[ev.code];
  const title = known?.title ?? ev.code.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim().slice(0, 28) ?? "NOTICE";
  const sub = known?.sub ?? "operational notice";
  const head = `⚠️ <b>${e(title || "NOTICE")}</b> · ${e(sub)}`;
  const L = glanceWidth(head) <= 38 ? [head] : [`⚠️ <b>${e(title)}</b>`, e(sub)];
  L.push(...wrapPlain(ev.detail));
  if (known?.extra) L.push(...known.extra);
  L.push(`Since ${both(ctx.nowMs)}`, "Next notice of this type: 30 min");
  return { text: body(L), buttons: ctx.dashboardUrl ? [dash(ctx)] : undefined };
}

function testAlert(ctx: GlanceCtx): Rendered {
  return {
    text: body(["🧪 <b>TEST ALERT</b> · not real", "Symbol TEST · nothing is wrong", "Tap Acknowledge to finish the test.", both(ctx.nowMs)]),
    buttons: [[{ text: "✅ Acknowledge", data: encodeAck("TEST", "HIGH", 0) }], ...(ctx.dashboardUrl ? [dash(ctx)] : [])],
  };
}

// ------------------------------------------------------------ test cycle (FR-13.1)
/** Reminder n of a running test: clearly TEST, notifying. */
export function renderTestReminder(n: number, nowMs: number, dashboardUrl?: string): Rendered {
  return {
    text: body(["🧪 <b>TEST REMINDER " + n + "</b> · not real", ...pack([`Reminder ${n} – test`, `unacknowledged ${n} min`]), "Nothing is wrong. Tap Acknowledge.", both(nowMs)]),
    buttons: [[{ text: "✅ Acknowledge", data: encodeAck("TEST", "HIGH", 0) }], ...(dashboardUrl ? [dash({ dashboardUrl })] : [])],
  };
}
/** The edit that closes a test when it is acknowledged. */
export const renderTestAck = (nowMs: number): Rendered => ({ text: body(["🧪 <b>TEST</b> acknowledged", `Acknowledged ${both(nowMs)}`, "Nothing real was affected."]) });
export const renderTestEnded = (nowMs: number): Rendered => ({ text: body(["🧪 <b>TEST ENDED</b>", "Test ended – no acknowledgment", "No more test reminders.", both(nowMs)]) });

// ------------------------------------------------------------ entry points
/** All messages for one event (only the briefing can be more than one). */
export function renderGlanceAll(ev: OutboundEvent, ctx: GlanceCtx): Rendered[] {
  switch (ev.type) {
    case "FIRST_ALERT": return [firstAlert(ev, ctx)];
    case "LATE_ALERT": return [lateAlert(ev, ctx)];
    case "REMINDER": return [reminder(ev, ctx)];
    case "ACK_CONFIRM": return [renderAckConfirm(ev.rule, ctx.nowMs)];
    case "BRIEFING": return briefing(ev, ctx, false);
    case "UNACK_AT_CLOSE": return [unackAtClose(ev, ctx)];
    case "READY": return [ready(ev)];
    case "SESSION_ENDED": return [sessionEnded(ev)];
    case "OPS_NOTICE": return [opsNotice(ev, ctx)];
    case "TEST_ALERT": return [testAlert(ctx)];
  }
}

/** First (or only) message of an event: the one used for edits and for sends of single messages. */
export const renderGlance = (ev: OutboundEvent, ctx: GlanceCtx): Rendered => renderGlanceAll(ev, ctx)[0] as Rendered;

/** Expanded briefing for the Details button (silent replies, split under the Telegram limit). */
export function renderBriefingDetails(ev: Extract<OutboundEvent, { type: "BRIEFING" }>, ctx: GlanceCtx): Rendered[] {
  return briefing(ev, ctx, true);
}
