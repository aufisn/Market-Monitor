/**
 * Operations shared by the dashboard API and Telegram commands: save/delete a
 * stock (FR-2.4), acknowledge (FR-4.4), mute/pause, re-arm on edit (I-5).
 *
 * NOTE: the alert state machine belongs to src/core. These helpers only make
 * the minimal state changes the outside world can request (ack, re-arm) with
 * the optimistic version check, so a concurrent engine run never loses a write.
 */
import { AlpacaError } from "../adapters/alpaca";
import { nyDate } from "../adapters/util";
import { acknowledge, acknowledgeAll, isActive, rearmAfterEdit } from "../core/alerts";
import type { RuleKind, RuleState, SplitInfo, SplitLevels, StockConfig } from "../core/ports";
import { applySplit, sameSplit, splitDoneKey } from "../core/splits";
import { drainOutbound } from "./outbox";
import type { Ctx } from "./env";
import { ApiError, MAX_STOCKS, changedRules, checkBand, validateStockInput, validateSymbol, wouldAlertNow } from "./validate";

/**
 * The answer to a split warning (Telegram button or dashboard Review). adjust=true before the split day stores the
 * plan (levels convert before the open that day); on the split day itself it converts at once, only once.
 * adjust=false removes a stored plan. Never converts a split whose day has passed.
 */
export async function chooseSplit(
  ctx: Ctx, symbolInput: string, exDate: string, adjust: boolean,
): Promise<{ choice: "planned" | "applied" | "left"; split: SplitInfo; to?: SplitLevels }> {
  const symbol = validateSymbol(symbolInput);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exDate)) throw new ApiError(400, "INVALID_INPUT", "exDate: must be YYYY-MM-DD");
  const date = nyDate(ctx.now());
  const stock = (await ctx.store.listStocks()).find((s) => s.symbol === symbol);
  if (!stock) throw new ApiError(404, "NOT_FOUND", `${symbol} is not on the watchlist.`);
  const split = (await ctx.store.getMarketStates(date)).find((m) => m.symbol === symbol)?.splits?.find((s) => s.exDate === exDate);
  if (!split) throw new ApiError(409, "SPLIT_UNKNOWN", "This split is no longer listed. Nothing was changed.");
  if (!adjust) {
    if (stock.splitPlan) {
      const next = { ...stock };
      delete next.splitPlan;
      await ctx.store.putStock(next);
    }
    return { choice: "left", split };
  }
  if (exDate > date) {
    if (!sameSplit(stock.splitPlan, split)) await ctx.store.putStock({ ...stock, splitPlan: split });
    return { choice: "planned", split };
  }
  if (exDate < date) throw new ApiError(409, "SPLIT_PASSED", "The split day has passed. Change the levels by hand if needed.");
  const key = splitDoneKey(symbol, exDate);
  if ((await ctx.store.getCounters("meta"))[key]) throw new ApiError(409, "SPLIT_DONE", "The levels were already adjusted for this split.");
  const r = applySplit(stock, split);
  const patch: Record<string, unknown> = { symbol, confirm: true };
  if (r.to.low !== undefined) patch.low = { mode: "dollar", value: r.to.low };
  if (r.to.high !== undefined) patch.high = { mode: "dollar", value: r.to.high };
  if (r.to.volume !== undefined) patch.volume = { mode: "absolute", value: r.to.volume };
  await ctx.store.bumpCounters("meta", { [key]: 1 }); // marker first: never converts twice
  try {
    await saveStock(ctx, patch, { mode: "update" }); // a level change also clears a stored plan
  } catch (e) {
    await ctx.store.bumpCounters("meta", { [key]: -1 }).catch(() => undefined); // not converted: allow a retry
    throw e;
  }
  await ctx.store.log([{ tMs: ctx.now(), kind: "SETTINGS_CHANGE", symbol, detail: { what: "split_adjust", split, from: r.from, to: r.to } }]);
  return { choice: "applied", split, to: r.to };
}

export interface SaveOptions {
  mode: "create" | "update" | "upsert";
  confirm?: boolean;
}

export async function saveStock(ctx: Ctx, body: unknown, opts: SaveOptions): Promise<{ stock: StockConfig; rearmed: RuleKind[] }> {
  const raw = (body ?? {}) as Record<string, unknown>;
  const symbol = validateSymbol(raw.symbol);
  const stocks = await ctx.store.listStocks();
  const existing = stocks.find((s) => s.symbol === symbol);
  if (opts.mode === "create" && existing) throw new ApiError(409, "DUPLICATE", `${symbol} is already on the watchlist.`);
  if (opts.mode === "update" && !existing) throw new ApiError(404, "NOT_FOUND", `${symbol} is not on the watchlist.`);
  if (!existing && stocks.length >= MAX_STOCKS) throw new ApiError(422, "WATCHLIST_FULL", `The watchlist is limited to ${MAX_STOCKS} stocks.`);

  const { confirm, ...patch } = raw;
  const stock = validateStockInput(patch, existing);

  if (!existing) await verifySymbolExists(ctx, symbol);

  const date = nyDate(ctx.now());
  const ms = (await ctx.store.getMarketStates(date)).find((m) => m.symbol === symbol);
  const prev = ms?.prev?.close;
  checkBand(stock, prev);
  const changed = changedRules(existing, stock);
  if (stock.splitPlan && changed.some((r) => r === "HIGH" || r === "LOW" || r === "VOLUME")) delete stock.splitPlan;
  if (confirm !== true && changed.length > 0 && stock.enabled) {
    const hits = wouldAlertNow(stock, ms?.last?.p, prev).filter((r) => changed.includes(r));
    if (hits.length > 0) {
      throw new ApiError(409, "CONFIRM_REQUIRED", "This will alert immediately. Save?", { rules: hits, confirmWith: { confirm: true } });
    }
  }
  await ctx.store.putStock(stock);
  if (existing && changed.length > 0) await rearm(ctx, date, symbol, changed);
  return { stock, rearmed: existing ? changed : [] };
}

async function verifySymbolExists(ctx: Ctx, symbol: string): Promise<void> {
  try {
    const snaps = await ctx.market.snapshots([symbol]);
    if (!snaps[symbol]) throw new ApiError(422, "UNKNOWN_SYMBOL", `${symbol} was not found in the data source.`);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e instanceof AlpacaError) throw new ApiError(502, "DATA_SOURCE_UNAVAILABLE", "Cannot check the symbol with the data source right now. Try again in a minute.");
    throw e;
  }
}

export async function removeStock(ctx: Ctx, symbolInput: string): Promise<void> {
  const symbol = validateSymbol(symbolInput);
  const stocks = await ctx.store.listStocks();
  if (!stocks.some((s) => s.symbol === symbol)) throw new ApiError(404, "NOT_FOUND", `${symbol} is not on the watchlist.`);
  await ctx.store.deleteStock(symbol);
}

/** Editing a threshold re-arms its rule at once (I-5, FR-3.7): core rule, kept in one place. */
export async function rearm(ctx: Ctx, date: string, symbol: string, rules: RuleKind[]): Promise<void> {
  for (const rule of rules) await rearmAfterEdit(ctx.store, date, symbol, rule);
}

export interface AckSelector {
  symbol?: string;
  rule?: RuleKind;
  cycle?: number;
  all?: boolean;
}

/** Acknowledge through the core state machine, then send the queued ACK_CONFIRM edit. Returns how many rules were acknowledged. */
export async function applyAck(ctx: Ctx, sel: AckSelector, by: NonNullable<RuleState["ackBy"]>): Promise<number> {
  const now = ctx.now();
  const date = nyDate(now);
  let n = 0;
  if (sel.all) n = await acknowledgeAll(ctx.store, date, by, now);
  else {
    const states = await ctx.store.getRuleStates(date);
    for (const s of states) {
      if (!isActive(s) || s.symbol !== sel.symbol) continue;
      if (sel.rule && s.rule !== sel.rule) continue;
      if (sel.cycle !== undefined && s.cycle !== sel.cycle) continue;
      if (await acknowledge(ctx.store, date, s.symbol, s.rule, by, now, s)) n++;
    }
  }
  if (n > 0) await drainOutbound(ctx.store, ctx.notifier, date, now, 5).catch(() => undefined); // edits "Acknowledged" into the alert (FR-4.4)
  return n;
}

export async function setMute(ctx: Ctx, symbolInput: string, minutes: number | null): Promise<void> {
  const symbol = validateSymbol(symbolInput);
  const s = (await ctx.store.listStocks()).find((x) => x.symbol === symbol);
  if (!s) throw new ApiError(404, "NOT_FOUND", `${symbol} is not on the watchlist.`);
  const next = { ...s };
  if (minutes === null) delete next.mutedUntilMs;
  else next.mutedUntilMs = ctx.now() + minutes * 60_000;
  await ctx.store.putStock(next);
}

export async function setPaused(ctx: Ctx, symbolInput: string, paused: boolean): Promise<void> {
  const symbol = validateSymbol(symbolInput);
  const s = (await ctx.store.listStocks()).find((x) => x.symbol === symbol);
  if (!s) throw new ApiError(404, "NOT_FOUND", `${symbol} is not on the watchlist.`);
  await ctx.store.putStock({ ...s, paused });
}

export const PAUSED_ALL_KEY = "paused_all";

async function readPausedList(ctx: Ctx): Promise<string[] | null> {
  try {
    const raw = await ctx.store.getMeta(PAUSED_ALL_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

/**
 * Global pause / resume (all stocks). The list of stocks paused by the global pause only ever grows
 * until a resume, so pause, pause, resume still restores everything the global pause stopped.
 * Returns how many stocks changed.
 */
export async function setPausedAll(ctx: Ctx, paused: boolean): Promise<number> {
  const stocks = await ctx.store.listStocks();
  const list = await readPausedList(ctx);
  if (paused) {
    const todo = stocks.filter((s) => !s.paused);
    for (const s of todo) await ctx.store.putStock({ ...s, paused: true });
    const union = [...new Set([...(list ?? []), ...todo.map((s) => s.symbol)])];
    await ctx.store.setMeta(PAUSED_ALL_KEY, JSON.stringify(union));
    return todo.length;
  }
  const todo = stocks.filter((s) => s.paused && (list === null || list.includes(s.symbol)));
  for (const s of todo) await ctx.store.putStock({ ...s, paused: false });
  await ctx.store.setMeta(PAUSED_ALL_KEY, "");
  return todo.length;
}
