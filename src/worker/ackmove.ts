/**
 * "Acknowledge and move threshold" (FR-4.7, DG-3 assumption): the crossed threshold moves further out by
 * 1%, 2% (of its own value) or to a typed value; HIGH goes up, LOW goes down.
 * Order: store the new threshold, log it (FR-2.5), acknowledge, then re-arm (core rearmAfterEdit).
 */
import { renderAckConfirm, moveBy } from "../adapters/render-glance";
import { f2 } from "../adapters/glance-fmt";
import { nyDate } from "../adapters/util";
import { isActive } from "../core/alerts";
import type { RuleState, ThresholdInput } from "../core/ports";
import { resolveThreshold } from "../core/rules";
import { applyAck, rearm, saveStock } from "./actions";
import type { Ctx } from "./env";
import { ApiError } from "./validate";

export type MoveHow = { pct: number } | { price: number };
export type MoveResult =
  | { ok: true; rule: "HIGH" | "LOW"; symbol: string; from: number; to: number; messageId?: number }
  | { ok: false; reason: string; kind: "STALE" | "INVALID" };

export const STALE_TEXT = "This alert is no longer active";

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

export async function ackAndMove(ctx: Ctx, symbol: string, rule: "HIGH" | "LOW", how: MoveHow, opts: { cycle?: number; messageId?: number } = {}): Promise<MoveResult> {
  const fallbackMessageId = opts.messageId;
  const now = ctx.now();
  const date = nyDate(now);
  const state = await ctx.store.getRuleState(date, symbol, rule);
  if (!state || !isActive(state) || (opts.cycle !== undefined && state.cycle !== opts.cycle)) return { ok: false, reason: STALE_TEXT, kind: "STALE" };

  const stock = (await ctx.store.listStocks()).find((s) => s.symbol === symbol);
  const input = rule === "HIGH" ? stock?.high : stock?.low;
  if (!stock || !input) return { ok: false, reason: `${symbol} has no ${rule} threshold`, kind: "INVALID" };
  const ms = (await ctx.store.getMarketStates(date)).find((m) => m.symbol === symbol);
  const prev = ms?.prev?.close;
  const current = resolveThreshold(input, prev);
  if (current === undefined) return { ok: false, reason: "Previous Close is not known yet", kind: "INVALID" };

  const to = "pct" in how ? moveBy(rule, current, how.pct) : round4(how.price);
  const last = ms?.last?.p;
  // The new level must be beyond the latest price, otherwise it would alert again at once.
  if (last !== undefined && (rule === "HIGH" ? to <= last : to >= last)) {
    return { ok: false, reason: `${rule} ${f2(to)} would alert at once (last ${f2(last)}). Pick a ${rule === "HIGH" ? "higher" : "lower"} value.`, kind: "INVALID" };
  }
  if (to === current) return { ok: false, reason: "That is the current value. Pick a different one.", kind: "INVALID" };
  if (to <= 0) return { ok: false, reason: "The new value must be above 0", kind: "INVALID" };
  const next: ThresholdInput = input.mode === "dollar" ? { mode: "dollar", value: to } : { mode: "percent", value: round4((to / (prev as number) - 1) * 100) };

  try {
    await saveStock(ctx, { symbol, [rule.toLowerCase()]: next, confirm: true }, { mode: "update" });
  } catch (e) {
    return { ok: false, reason: e instanceof ApiError ? e.message : "Could not save the new value", kind: "INVALID" };
  }
  await ctx.store
    .log([{ tMs: now, kind: "SETTINGS_CHANGE", symbol, rule, detail: { from: current, to, via: "ack+move", ...("pct" in how ? { pct: how.pct } : {}) } }])
    .catch(() => undefined);
  await applyAck(ctx, { symbol, rule, cycle: state.cycle }, "telegram");
  await rearm(ctx, date, symbol, [rule]);

  // Second edit adds the "moved" lines to the acknowledgement the outbox has just written.
  const messageId = state.lastMessageId ?? fallbackMessageId;
  if (messageId) {
    const acked: RuleState = { ...state, state: "ACKNOWLEDGED", ackMs: now };
    await ctx.telegram.editMessageText(messageId, renderAckConfirm(acked, now, { from: current, to })).catch(() => undefined);
  }
  return { ok: true, rule, symbol, from: current, to, messageId };
}
