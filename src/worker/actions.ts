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
import type { RuleKind, RuleState, StockConfig } from "../core/ports";
import { drainOutbound } from "./outbox";
import { APP_VERSION, type Ctx } from "./env";
import type { Intent } from "./intents";
import { ApiError, MAX_STOCKS, changedRules, checkBand, validateStockInput, validateSymbol, wouldAlertNow } from "./validate";

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

export async function statusText(ctx: Ctx): Promise<string> {
  const now = ctx.now();
  const date = nyDate(now);
  const snap = await ctx.store.dashboardSnapshot(date);
  const unack = snap.rules.filter((r) => r.state === "TRIGGERED" || r.state === "REPEATING").length;
  const age = snap.lastPollMs === null ? "never" : `${Math.max(0, Math.round((now - snap.lastPollMs) / 1000))} s ago`;
  return [`Market Monitor v${APP_VERSION}`, `Last poll: ${age}`, `Stocks: ${snap.stocks.length}`, `Unacknowledged: ${unack}`].join("\n");
}

export const HELP_TEXT = [
  "/status",
  "/ack SYMBOL, /ackall",
  "/set SYMBOL high|low 250|5%|off",
  "/set SYMBOL volume 2x|500000|off",
  "(add the word confirm to accept an immediate alert)",
  "/mute SYMBOL [30m|2h|1d], /unmute [SYMBOL]",
  "/pause SYMBOL, /resume SYMBOL",
  "/test, /help",
].join("\n");

/** Runs a parsed Telegram command and returns the plain reply text. Errors become readable replies. */
export async function runIntent(ctx: Ctx, intent: Intent): Promise<string> {
  try {
    switch (intent.type) {
      case "help":
        return HELP_TEXT;
      case "invalid":
        return intent.message;
      case "status":
        return await statusText(ctx);
      case "test":
        await ctx.notifier.send({ type: "TEST_ALERT" });
        return "Test alert sent.";
      case "ackall": {
        const n = await applyAck(ctx, { all: true }, "ackall");
        return n ? `Acknowledged ${n} alert(s).` : "Nothing to acknowledge.";
      }
      case "ack": {
        const n = await applyAck(ctx, { symbol: intent.symbol }, "command");
        return n ? `Acknowledged ${intent.symbol} (${n} rule(s)).` : `No active alert for ${intent.symbol}.`;
      }
      case "mute":
        await setMute(ctx, intent.symbol, intent.minutes);
        return `${intent.symbol} muted for ${intent.minutes} min.`;
      case "unmute":
        if (intent.symbol) await setMute(ctx, intent.symbol, null);
        else for (const s of await ctx.store.listStocks()) if (s.mutedUntilMs) await setMute(ctx, s.symbol, null);
        return "Unmuted.";
      case "pause":
      case "resume": {
        const paused = intent.type === "pause";
        if (!intent.symbol) return `Usage: /${intent.type} SYMBOL`;
        await setPaused(ctx, intent.symbol, paused);
        return `${intent.symbol} ${paused ? "paused" : "resumed"}.`;
      }
      case "set": {
        const { stock } = await saveStock(ctx, { symbol: intent.symbol, [intent.field]: intent.value, confirm: intent.confirm }, { mode: "upsert" });
        const prevClose = (await ctx.store.getMarketStates(nyDate(ctx.now()))).find((m) => m.symbol === stock.symbol)?.prev?.close;
        const f = (t: { mode: string; value: number } | undefined): string => {
          if (!t) return "off";
          if (t.mode === "dollar") return `$${t.value}`;
          if (t.mode === "percent") return `${t.value}%${prevClose ? ` = $${(prevClose * (1 + t.value / 100)).toFixed(2)}` : ""}`;
          return t.mode === "multiple" ? `${t.value}x` : `${t.value} shares`;
        };
        return `${stock.symbol}: high ${f(stock.high)}, low ${f(stock.low)}, volume ${f(stock.volume)}`;
      }
    }
  } catch (e) {
    if (e instanceof ApiError) {
      return e.code === "CONFIRM_REQUIRED" ? "This will alert immediately. Repeat the command with the word confirm to save." : e.message;
    }
    return "Something went wrong on the server.";
  }
}
