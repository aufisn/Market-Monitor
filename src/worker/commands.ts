/**
 * Telegram commands (FR-5.6, FR-11.3): a parsed Intent in, a rendered Glance Line reply out.
 * The alert state machine stays in src/core; this file only reads state and calls the shared actions.
 */
import { f2, num, pctOf, vol, both, etOnly } from "../adapters/glance-fmt";
import {
  card, renderHelp, renderOk, renderSetConfirm, renderSetDone, renderStatus, renderText, renderTicker, renderToday, renderWatchlist, renderWhy,
  type WatchRow,
} from "../adapters/render-commands";
import { volumeFacts } from "../adapters/render-glance";
import type { Rendered } from "../adapters/telegram";
import { nyDate } from "../adapters/util";
import { calendarStatus, nextOpen, sessionFor } from "../core/calendar";
import { isActive } from "../core/alerts";
import type { RuleKind, StockConfig, ThresholdInput, VolumeInput } from "../core/ports";
import { resolveThreshold } from "../core/rules";
import { nyLocalToUtc, MIN } from "../core/time";
import { applyAck, saveStock, setMute, setPaused, setPausedAll } from "./actions";
import { APP_VERSION, type Ctx } from "./env";
import type { Intent } from "./intents";
import { ApiError } from "./validate";
import { explainWhy, volumeRuleText } from "./why";
import { ackTestCycle, startTestCycle } from "./testcycle";

const PENDING_TTL_MS = 10 * MIN;

/** Runs a command; returns the reply, or null when nothing should be sent back. Errors become readable replies. */
export async function runCommand(ctx: Ctx, intent: Intent): Promise<Rendered | null> {
  try {
    switch (intent.type) {
      case "help": return renderHelp();
      case "invalid": return renderText(intent.message);
      case "status": return await status(ctx);
      case "watchlist": return await watchlist(ctx);
      case "ticker": return await ticker(ctx, intent.symbol);
      case "today": return await today(ctx);
      case "why": return await why(ctx, intent.symbol, intent.hour, intent.minute, intent.date);
      case "test":
        await startTestCycle(ctx);
        return null;
      case "ackall": {
        const n = await applyAck(ctx, { all: true }, "ackall");
        return renderText(n ? `✅ Acknowledged ${n} alert${n === 1 ? "" : "s"}.` : "Nothing to acknowledge.");
      }
      case "ack": {
        if (intent.symbol === "TEST") return (await ackTestCycle(ctx)) ? null : renderText("No test is running.");
        const n = await applyAck(ctx, { symbol: intent.symbol }, "command");
        return n ? renderOk(intent.symbol, "acknowledged", [`${n} rule${n === 1 ? "" : "s"} closed.`]) : renderText(`No active alert for ${intent.symbol}.`);
      }
      case "mute": {
        await setMute(ctx, intent.symbol, intent.minutes);
        return card(`🔕 <b>${intent.symbol}</b> muted ${muteText(intent.minutes)}`, [`Back at ${both(ctx.now() + intent.minutes * MIN)}`]);
      }
      case "unmute":
        if (intent.symbol) await setMute(ctx, intent.symbol, null);
        else for (const s of await ctx.store.listStocks()) if (s.mutedUntilMs) await setMute(ctx, s.symbol, null);
        return renderText(intent.symbol ? `🔔 ${intent.symbol} unmuted.` : "🔔 All stocks unmuted.");
      case "pause":
      case "resume":
        return await pauseResume(ctx, intent.type === "pause", intent.symbol);
      case "set": return await setCommand(ctx, intent);
    }
  } catch (e) {
    if (e instanceof ApiError) return card("⚠️ <b>NOT DONE</b>", [e.message]);
    return renderText("Something went wrong on the server.");
  }
}

const muteText = (min: number): string => (min % 1440 === 0 ? `${min / 1440} d` : min % 60 === 0 ? `${min / 60}h` : `${min} min`);

// ------------------------------------------------------------ pause / resume (per stock and global)
async function pauseResume(ctx: Ctx, pause: boolean, symbol?: string): Promise<Rendered> {
  if (symbol) {
    await setPaused(ctx, symbol, pause);
    return card(`${pause ? "⏸" : "▶️"} <b>${symbol}</b> ${pause ? "paused" : "resumed"}`, [pause ? "No alerts until /resume " + symbol : "Alerts are on again."]);
  }
  const n = await setPausedAll(ctx, pause);
  if (pause) return card("⏸ <b>ALL ALERTS PAUSED</b>", [`${n} stock${n === 1 ? "" : "s"} paused.`, "Send /resume to turn them on again."]);
  return card("▶️ <b>ALERTS RESUMED</b>", [n ? `${n} stock${n === 1 ? "" : "s"} resumed.` : "Nothing was paused."]);
}

// ------------------------------------------------------------ /status
async function status(ctx: Ctx): Promise<Rendered> {
  const now = ctx.now();
  const date = nyDate(now);
  const [snap, baselines] = await Promise.all([ctx.store.dashboardSnapshot(date), ctx.store.getBaselines()]);
  const session = sessionFor(date);
  const open = session.kind === "open" && now >= session.open && now < session.close;
  const active = snap.rules.filter(isActive);
  const next = active.map((r) => r.nextReminderMs).filter((x): x is number => x !== undefined).sort((a, b) => a - b)[0];
  const enabled = snap.stocks.filter((s) => s.enabled);
  const cal = calendarStatus(now);
  return renderStatus({
    version: APP_VERSION,
    nowMs: now,
    marketOpen: open,
    closeMs: session.kind === "open" ? session.close : undefined,
    nextOpenMs: nextOpen(now) ?? undefined,
    lastPollAgeSec: snap.lastPollMs === null ? null : Math.max(0, Math.round((now - snap.lastPollMs) / 1000)),
    unack: active.length,
    nextReminderMs: next,
    baselinesDone: baselines.filter((b) => b.status === "OK" && enabled.some((s) => s.symbol === b.symbol)).length,
    baselinesTotal: enabled.length,
    calendar: cal.expired ? "expired" : cal.warn ? "expiring" : "valid",
    sentToday: snap.counters.tg_sent ?? 0,
    failedToday: snap.counters.tg_failed ?? 0,
    pausedAll: enabled.length > 0 && enabled.every((s) => s.paused),
  });
}

// ------------------------------------------------------------ /watchlist, /ticker
async function watchlist(ctx: Ctx): Promise<Rendered> {
  const snap = await ctx.store.dashboardSnapshot(nyDate(ctx.now()));
  const now = ctx.now();
  const rows: WatchRow[] = snap.stocks.map((s) => {
    const m = snap.market.find((x) => x.symbol === s.symbol);
    return {
      symbol: s.symbol,
      last: m?.last?.p,
      high: resolveThreshold(s.high, m?.prev?.close),
      low: resolveThreshold(s.low, m?.prev?.close),
      alert: snap.rules.some((r) => r.symbol === s.symbol && isActive(r)),
      muted: (s.mutedUntilMs ?? 0) > now,
      paused: !!s.paused,
      enabled: s.enabled,
    };
  });
  return renderWatchlist(rows);
}

export { volumeRuleText };

async function ticker(ctx: Ctx, symbol: string): Promise<Rendered> {
  const now = ctx.now();
  const date = nyDate(now);
  const snap = await ctx.store.dashboardSnapshot(date);
  const s = snap.stocks.find((x) => x.symbol === symbol);
  if (!s) return renderText(`${symbol} is not on the watchlist.`);
  const m = snap.market.find((x) => x.symbol === symbol);
  const baseline = await ctx.store.getBaseline(symbol);
  const f = volumeFacts(baseline, date, m?.lastPollMs ?? now, m?.cumVolume);
  return renderTicker({
    symbol, nowMs: now, last: m?.last?.p, lastMs: m?.last ? m.lastPollMs : undefined, prevClose: m?.prev?.close, open: m?.open,
    high: resolveThreshold(s.high, m?.prev?.close), low: resolveThreshold(s.low, m?.prev?.close),
    volumeText: volumeRuleText(s.volume), cumVolume: m?.cumVolume, multiple: f.multiple,
    rules: snap.rules.filter((r) => r.symbol === symbol && r.state !== "ARMED").map((r) => ({ rule: r.rule, state: stateWords(r.state), since: r.t0Ms })),
    mutedUntilMs: s.mutedUntilMs, paused: !!s.paused, enabled: s.enabled, notes: s.notes,
  });
}

const stateWords = (s: string): string =>
  s === "TRIGGERED" ? "alert open" : s === "REPEATING" ? "reminding" : s === "ACKNOWLEDGED" ? "acknowledged" : s === "UNACKNOWLEDGED_AT_CLOSE" ? "unacknowledged at close" : "armed";

// ------------------------------------------------------------ /today
async function today(ctx: Ctx): Promise<Rendered> {
  const now = ctx.now();
  const date = nyDate(now);
  const start = nyLocalToUtc(date, 0);
  const [counters, rows] = await Promise.all([ctx.store.getCounters(date), ctx.store.queryLog({ limit: 200 })]);
  const label: Record<string, string> = { FIRST_ALERT: "alert", LATE_ALERT: "late alert", ACK: "acknowledged", ERROR: "error" };
  const events = rows
    .filter((r) => r.tMs >= start && label[r.kind])
    .reverse()
    .slice(-15)
    .map((r) => ({ tMs: r.tMs, text: `${r.symbol ?? ""} ${r.rule ?? ""} ${label[r.kind]}`.replace(/\s+/g, " ").trim() }));
  return renderToday({ date, counts: counters, events });
}

// ------------------------------------------------------------ /why (FR-11.3): shared with GET /api/why
async function why(ctx: Ctx, symbol: string, hour: number, minute: number, date?: string): Promise<Rendered> {
  const w = await explainWhy(ctx, symbol, date ?? nyDate(ctx.now()), hour, minute);
  if ("error" in w) return renderText(w.error);
  return renderWhy({ symbol, atMs: w.atMs, lines: w.lines });
}

// ------------------------------------------------------------ /set
const FIELD_RULE = { high: "HIGH", low: "LOW", volume: "VOLUME" } as const;
export const pendingKey = (symbol: string, field: string): string => `pset:${symbol}:${field}`;

async function setCommand(ctx: Ctx, intent: Extract<Intent, { type: "set" }>): Promise<Rendered> {
  const label = FIELD_RULE[intent.field];
  const date = nyDate(ctx.now());
  const before = (await ctx.store.listStocks()).find((s) => s.symbol === intent.symbol);
  const ms = (await ctx.store.getMarketStates(date)).find((m) => m.symbol === intent.symbol);
  const prev = ms?.prev?.close;
  const last = ms?.last?.p;
  try {
    const { stock, rearmed } = await saveStock(ctx, { symbol: intent.symbol, [intent.field]: intent.value, confirm: intent.confirm }, { mode: "upsert" });
    const wasInput = intent.field === "volume" ? before?.volume : before?.[intent.field];
    return setDone(stock, intent.field, label, before ? volumeOrLevel(wasInput, prev) : undefined, last, prev, !before || rearmed.includes(label), !before);
  } catch (e) {
    if (e instanceof ApiError && e.code === "CONFIRM_REQUIRED") {
      await ctx.store.setMeta(pendingKey(intent.symbol, intent.field), JSON.stringify({ value: intent.value, until: ctx.now() + PENDING_TTL_MS }));
      const input = intent.field === "volume" ? undefined : intent.value as ThresholdInput | null;
      const level = resolveThreshold(input ?? undefined, prev);
      return renderSetConfirm(intent.symbol, label as "HIGH" | "LOW", level ?? 0, last, intent.field);
    }
    throw e;
  }
}

function volumeOrLevel(v: ThresholdInput | VolumeInput | undefined, prev: number | undefined): string {
  if (!v) return "off";
  if (v.mode === "multiple") return `${v.value}x`;
  if (v.mode === "absolute") return `${vol(v.value)} shares`;
  const lvl = resolveThreshold(v, prev);
  return lvl === undefined ? `${v.value}%` : f2(lvl);
}

/** Reply for a saved /set (also used after the Save button). */
export function setDone(stock: StockConfig, field: "high" | "low" | "volume", label: string, was: string | undefined, last: number | undefined, prev: number | undefined, rearmed: boolean, added: boolean): Rendered {
  const v = stock[field];
  const setText = volumeOrLevel(v, prev);
  const lvl = field !== "volume" && v ? resolveThreshold(v as ThresholdInput, prev) : undefined;
  return renderSetDone({
    symbol: stock.symbol, label, setText,
    fromPrevClose: lvl !== undefined && prev ? { pct: pctOf(lvl, prev, 1), prevClose: prev } : undefined,
    was, last, rearmed, added,
  });
}
