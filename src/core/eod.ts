/**
 * End-of-day summary data (ux/improvements.md section 5). Pure: no I/O, no formatting.
 * The engine fetches; this file turns official daily bars + stored state into EodStock rows.
 */
import type { Bar, Baseline, EodAlert, EodStock, EodSummary, MarketState, RuleState, StockConfig, TradingDate } from "./ports";
import { MIN, addDays, nyLocalToUtc } from "./time";

/** The summary is built from this long after the close (16:20 ET on a normal day, 13:20 ET on an early-close day). */
export const EOD_AFTER_CLOSE_MS = 20 * MIN;
/** From here on missing official data is replaced by IEX values and the summary is sent anyway. */
export const EOD_FINAL_AFTER_CLOSE_MS = 55 * MIN;
/** From here a stock without an official bar no longer holds the summary back (it is listed as IEX). */
export const EOD_PARTIAL_AFTER_CLOSE_MS = 35 * MIN;
/** Stocks per message: the worst block (4 lines + 3 alert lines, 38 wide) keeps a message far below 4096 characters. */
export const EOD_STOCKS_PER_MESSAGE = 12;
/** Fewest past sessions for an "x usual" figure. */
export const EOD_MIN_HISTORY = 5;

/**
 * Request window for official daily bars.
 * Free plan: SIP is allowed only when `end` is >= 15 minutes old, so end = min(close + 5 min,
 * now - 15 min - 30 s). At the earliest build time (close + 20 min) that is close + 4.5 min,
 * after the closing auction; the day's bar is stamped at the day's midnight, before `end`.
 */
export function eodWindow(date: TradingDate, closeMs: number, nowMs: number, sessions: number): { startMs: number; endMs: number } {
  return {
    startMs: nyLocalToUtc(addDays(date, -Math.ceil(sessions * 1.5) - 10), 0),
    endMs: Math.min(closeMs + 5 * MIN, nowMs - 15 * MIN - 30_000),
  };
}

const barDate = (b: Bar): string => new Date(b.t).toISOString().slice(0, 10); // 04:00Z / 05:00Z = the New York date

/** Alerts of one stock today from the stored rule states (the latest cycle of each rule). */
export function alertsFor(symbol: string, rules: RuleState[], cfg: StockConfig | undefined): EodAlert[] {
  const out: EodAlert[] = [];
  for (const r of rules) {
    if (r.symbol !== symbol || r.cycle < 1 || r.t0Ms === undefined) continue;
    const a: EodAlert = { rule: r.rule, tMs: r.t0Ms, count: r.cycle, acked: r.ackMs !== undefined };
    if (r.rule === "VOLUME" && cfg?.volume?.mode === "multiple" && r.t0Value !== undefined && r.thresholdAtT0 && r.thresholdAtT0 > 0) {
      a.multiple = (r.t0Value * cfg.volume.value) / r.thresholdAtT0; // threshold = multiple x avg
    }
    out.push(a);
  }
  return out.sort((x, y) => x.tMs - y.tMs);
}

export interface EodInputs {
  date: TradingDate;
  stocks: StockConfig[]; // enabled stocks
  /** Official daily bars by symbol, or undefined when the request failed. */
  official?: Record<string, Bar[]>;
  states: Map<string, MarketState>;
  rules: RuleState[];
  baselines: Map<string, Baseline>;
  sessions: number; // settings.baselineSessions
}

export const hasOfficialToday = (bars: Bar[] | undefined, date: TradingDate): boolean => !!bars?.some((b) => barDate(b) === date);

export function buildEodStocks(i: EodInputs): EodStock[] {
  const rows = i.stocks.map((cfg): EodStock => {
    const sym = cfg.symbol;
    const st = i.states.get(sym);
    const bars = [...(i.official?.[sym] ?? [])].sort((a, b) => a.t - b.t);
    const today = bars.find((b) => barDate(b) === i.date);
    const alerts = alertsFor(sym, i.rules, cfg);
    const base = { symbol: sym, alertsOff: !!cfg.paused, alerts };
    // 52-week range after today: the stored range (before today) widened by today's high / low.
    const w = st?.w52;
    const range = (hi: number | undefined, lo: number | undefined): Partial<EodStock> => {
      if (w?.high === undefined || w.low === undefined) return {};
      const nh = hi !== undefined && hi > w.high;
      const nl = lo !== undefined && lo < w.low;
      return { w52High: nh ? hi : w.high, w52Low: nl ? lo : w.low, ...(nh ? { newHigh52: true } : {}), ...(nl ? { newLow52: true } : {}) };
    };
    if (today) {
      const past = bars.filter((b) => barDate(b) < i.date).slice(-i.sessions);
      // [UNVERIFIED-PHASE0] earlier 1Day bars are complete sessions; their volume is the official full-day volume.
      const avg = past.length >= EOD_MIN_HISTORY ? past.reduce((s, b) => s + b.v, 0) / past.length : undefined;
      const prevClose = past.length ? past[past.length - 1]!.c : st?.prev?.close; // stored prev.close is also SIP (previousDaily)
      return { ...base, source: "SIP", close: today.c, prevClose, open: today.o, low: today.l, high: today.h, volume: today.v, ...(avg !== undefined ? { avgVolume: avg } : {}), ...range(today.h, today.l) };
    }
    // Fallback: what the intraday (IEX) polling stored. Volume "usual" only from an IEX baseline.
    const b = i.baselines.get(sym);
    return {
      ...base, source: "IEX", close: st?.last?.p, prevClose: st?.prev?.close, open: st?.open, low: st?.dayLow, high: st?.dayHigh, volume: st?.cumVolume,
      ...(b && b.status === "OK" && b.avgFullDay > 0 ? { avgVolume: b.avgFullDay } : {}),
      ...range(st?.dayHigh, st?.dayLow),
    };
  });
  const first = (s: EodStock) => (s.alerts.length ? s.alerts[0]!.tMs : Infinity);
  return rows.sort((a, b) => (first(a) === first(b) ? (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0) : first(a) - first(b)));
}

/** Cut the ordered stocks into messages (first one carries the counts). */
export function chunkEod(stocks: EodStock[]): EodSummary[] {
  const footer: EodSummary["footer"] = stocks.every((x) => x.source === "IEX") ? "IEX" : stocks.some((x) => x.source === "IEX") ? "MIXED" : "SIP";
  const total = Math.max(1, Math.ceil(stocks.length / EOD_STOCKS_PER_MESSAGE));
  return Array.from({ length: total }, (_, i) => ({
    stocks: stocks.slice(i * EOD_STOCKS_PER_MESSAGE, (i + 1) * EOD_STOCKS_PER_MESSAGE),
    part: { n: i + 1, total },
    footer,
  }));
}
