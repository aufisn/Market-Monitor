/** Inline-button actions (Glance Line): what each callback does. Returns the short text for answerCallbackQuery. */
import type { CallbackAction } from "../adapters/callbacks";
import { f2, vol } from "../adapters/glance-fmt";
import { renderSetCancelled, renderSetSaved } from "../adapters/render-commands";
import {
  alertKeyboard, chooserKeyboard, renderBriefingDetails, renderDetails, renderMovePrompt, renderSeen, volumeFacts,
} from "../adapters/render-glance";
import type { Rendered } from "../adapters/telegram";
import { nyDate } from "../adapters/util";
import { isActive } from "../core/alerts";
import type { RuleKind, ThresholdInput } from "../core/ports";
import { resolveThreshold } from "../core/rules";
import { MIN } from "../core/time";
import { ackAndMove, STALE_TEXT } from "./ackmove";
import { applyAck, saveStock, setMute } from "./actions";
import { pendingKey, volumeRuleText } from "./commands";
import type { Ctx } from "./env";
import { ApiError } from "./validate";

export const PENDING_MOVE_KEY = "pending_move";
const PENDING_TTL_MS = 10 * MIN;

export interface PendingMove { symbol: string; rule: "HIGH" | "LOW"; cycle?: number; promptId: number; messageId?: number; until: number }

export async function readPendingMove(ctx: Ctx): Promise<PendingMove | null> {
  try {
    const raw = await ctx.store.getMeta(PENDING_MOVE_KEY);
    const p = raw ? (JSON.parse(raw) as PendingMove) : null;
    return p && typeof p.promptId === "number" && p.until > ctx.now() ? p : null;
  } catch {
    return null;
  }
}

const stripKeyboard = (ctx: Ctx, id: number | undefined): Promise<void> => (id ? ctx.telegram.editMessageReplyMarkup(id, null).catch(() => undefined) : Promise.resolve());
const isPrice = (r: RuleKind): r is "HIGH" | "LOW" => r !== "VOLUME";

export async function handleButton(ctx: Ctx, action: CallbackAction, msgId: number | undefined): Promise<string> {
  const now = ctx.now();
  const date = nyDate(now);
  switch (action.type) {
    case "ack": {
      if (action.symbol === "TEST") {
        await stripKeyboard(ctx, msgId);
        return "Test acknowledged";
      }
      const done = await applyAck(ctx, { symbol: action.symbol, rule: action.rule, cycle: action.cycle }, "telegram");
      if (!done) await stripKeyboard(ctx, msgId); // stale keyboard
      return done ? "Acknowledged" : "Already acknowledged";
    }
    case "ackall": {
      const done = await applyAck(ctx, { all: true }, "ackall");
      return done ? `Acknowledged ${done}` : "Nothing to acknowledge";
    }
    case "ackstock": {
      // exactly the rules listed on that reminder, not every rule of the stock
      let done = 0;
      for (const r of action.rules) done += await applyAck(ctx, { symbol: action.symbol, rule: r.rule, cycle: r.cycle }, "telegram");
      if (!done) await stripKeyboard(ctx, msgId);
      return done ? `Acknowledged ${done}` : "Already acknowledged";
    }
    case "mute":
      await setMute(ctx, action.symbol, action.minutes);
      return `${action.symbol} muted ${action.minutes} min`;
    case "seen":
      if (msgId) await ctx.telegram.editMessageText(msgId, renderSeen(now)).catch(() => undefined);
      return "Marked as seen";
    case "details":
      return (await sendDetails(ctx, action.symbol, action.rule, msgId)) ? "Details sent" : "Alert no longer current";
    case "briefdetails": {
      const parts = await briefingDetails(ctx, date);
      for (const [i, p] of parts.entries()) await ctx.telegram.sendMessage({ ...p, silent: true, ...(i === 0 && msgId ? { replyTo: msgId } : {}) });
      return parts.length ? "Details sent" : "No briefing data";
    }
    case "chooser": {
      if (!isPrice(action.rule)) return "No move for volume alerts";
      const st = await ctx.store.getRuleState(date, action.symbol, action.rule);
      if (!st || !isActive(st) || st.cycle !== action.cycle) {
        await stripKeyboard(ctx, msgId);
        return STALE_TEXT;
      }
      const cur = await currentLevel(ctx, date, action.symbol, action.rule);
      if (cur === undefined) return "Threshold not available";
      if (msgId) await ctx.telegram.editMessageReplyMarkup(msgId, chooserKeyboard(action.symbol, action.rule, cur, st.cycle)).catch(() => undefined);
      return `Move ${action.rule} further out by:`;
    }
    case "cancelchooser": {
      const st = await ctx.store.getRuleState(date, action.symbol, action.rule);
      if (msgId) await ctx.telegram.editMessageReplyMarkup(msgId, st && isActive(st) ? alertKeyboard(st, ctx) : null).catch(() => undefined);
      return "Cancelled";
    }
    case "typed": {
      if (!isPrice(action.rule)) return "No move for volume alerts";
      const st = await ctx.store.getRuleState(date, action.symbol, action.rule);
      if (!st || !isActive(st) || st.cycle !== action.cycle) {
        await stripKeyboard(ctx, msgId);
        return STALE_TEXT;
      }
      const last = (await ctx.store.getMarketStates(date)).find((m) => m.symbol === action.symbol)?.last?.p;
      const promptId = await ctx.telegram.sendMessage(renderMovePrompt(action.symbol, action.rule, last));
      const p: PendingMove = { symbol: action.symbol, rule: action.rule, cycle: action.cycle, promptId, messageId: msgId, until: now + PENDING_TTL_MS };
      await ctx.store.setMeta(PENDING_MOVE_KEY, JSON.stringify(p));
      return "Reply with the new value";
    }
    case "ackmove": {
      if (!isPrice(action.rule)) return "No move for volume alerts";
      const r = await ackAndMove(ctx, action.symbol, action.rule, { pct: action.pct }, { cycle: action.cycle, messageId: msgId });
      if (!r.ok && r.kind === "STALE") await stripKeyboard(ctx, msgId);
      return r.ok ? `${action.rule} moved to ${f2(r.to)}` : r.reason.slice(0, 190);
    }
    case "saveset":
    case "cancelset": {
      const key = pendingKey(action.symbol, action.field);
      const label = action.field.toUpperCase();
      let pending: { value: unknown; until: number } | null = null;
      try {
        const raw = await ctx.store.getMeta(key);
        pending = raw ? (JSON.parse(raw) as { value: unknown; until: number }) : null;
      } catch { /* treated as expired */ }
      await ctx.store.setMeta(key, "");
      if (action.type === "cancelset") {
        if (msgId) await ctx.telegram.editMessageText(msgId, renderSetCancelled(action.symbol, label)).catch(() => undefined);
        return "Not changed";
      }
      if (!pending || pending.until < now) {
        await stripKeyboard(ctx, msgId);
        return "Expired. Send the /set command again.";
      }
      try {
        const { stock } = await saveStock(ctx, { symbol: action.symbol, [action.field]: pending.value, confirm: true }, { mode: "upsert" });
        const m = (await ctx.store.getMarketStates(date)).find((x) => x.symbol === action.symbol);
        const v = stock[action.field];
        const text = action.field === "volume" ? (volumeRuleText(stock.volume) ?? "off") : f2(resolveThreshold(v as ThresholdInput | undefined, m?.prev?.close) ?? 0);
        if (msgId) await ctx.telegram.editMessageText(msgId, renderSetSaved(action.symbol, label, text)).catch(() => undefined);
        return "Saved";
      } catch (e) {
        return e instanceof ApiError ? e.message.slice(0, 190) : "Error";
      }
    }
  }
}

async function currentLevel(ctx: Ctx, date: string, symbol: string, rule: "HIGH" | "LOW"): Promise<number | undefined> {
  const stock = (await ctx.store.listStocks()).find((s) => s.symbol === symbol);
  const prev = (await ctx.store.getMarketStates(date)).find((m) => m.symbol === symbol)?.prev?.close;
  return resolveThreshold(rule === "HIGH" ? stock?.high : stock?.low, prev);
}

/** Details button: the full FR-5.5 card as a silent reply to the alert. False when the rule has no state today. */
async function sendDetails(ctx: Ctx, symbol: string, rule: RuleKind, replyTo: number | undefined): Promise<boolean> {
  const now = ctx.now();
  const date = nyDate(now);
  const snap = await ctx.store.dashboardSnapshot(date);
  const st = snap.rules.find((r) => r.symbol === symbol && r.rule === rule);
  if (!st || st.state === "ARMED") return false;
  const m = snap.market.find((x) => x.symbol === symbol) ?? { symbol, date };
  const stock = snap.stocks.find((s) => s.symbol === symbol);
  const baseline = await ctx.store.getBaseline(symbol);
  const card: Rendered = renderDetails({
    rule: st, market: m, nowMs: now, replyTo,
    high: resolveThreshold(stock?.high, m.prev?.close),
    low: resolveThreshold(stock?.low, m.prev?.close),
    volumeLimit: volumeRuleText(stock?.volume) ?? (st.thresholdAtT0 !== undefined ? `${vol(st.thresholdAtT0)} shares` : undefined),
    volume: volumeFacts(baseline, date, m.lastPollMs ?? now, m.cumVolume),
  });
  await ctx.telegram.sendMessage(card);
  return true;
}

async function briefingDetails(ctx: Ctx, date: string): Promise<Rendered[]> {
  const [snap, baselines] = await Promise.all([ctx.store.dashboardSnapshot(date), ctx.store.getBaselines()]);
  const stocks = snap.market.filter((m) => snap.stocks.some((s) => s.symbol === m.symbol && s.enabled));
  if (!stocks.length) return [];
  return renderBriefingDetails({ type: "BRIEFING", date, stocks }, { nowMs: ctx.now(), dashboardUrl: ctx.dashboardUrl, stocks: snap.stocks, baselines });
}
