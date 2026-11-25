/**
 * Ports: the only way the portable core (src/core) talks to the outside world
 * (FR-14.4). Adapters in src/adapters implement these for Cloudflare / Alpaca /
 * Telegram; tests implement them in memory. No Cloudflare types here.
 *
 * All timestamps are UTC epoch milliseconds. TradingDate is the New York
 * calendar date "YYYY-MM-DD".
 */

export type TradingDate = string;
export type Symbol = string;
export type RuleKind = "HIGH" | "LOW" | "VOLUME" | "HIGH52" | "LOW52" | "FAST" | "MA50" | "MA200";
/** Which side of the price a price rule watches (HIGH52 / LOW52 are the 52-week levels). */
export const priceSide = (r: RuleKind): "HIGH" | "LOW" | undefined =>
  r === "HIGH" || r === "HIGH52" ? "HIGH" : r === "LOW" || r === "LOW52" ? "LOW" : undefined;

// ---------------------------------------------------------------- time
export interface Clock {
  nowMs(): number;
}

// ---------------------------------------------------------------- market data
export interface Bar {
  t: number; // bar start, epoch ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Trade {
  t: number;
  p: number;
  s: number; // size
  conditions?: string[]; // provider condition codes (FR-3.4 filtering)
}

export interface Snapshot {
  symbol: Symbol;
  latestTrade?: Trade;
  minuteBar?: Bar; // current (in-progress) minute
  prevMinuteBar?: Bar; // previous completed minute
  dailyBar?: Bar; // today so far: o = Opening (IEX), v = cumulative IEX volume
}

export interface DailyRef {
  symbol: Symbol;
  date: TradingDate; // the previous session's date
  close: number; // Previous Close (consolidated)
  high: number;
  low: number;
  volume: number;
}

export interface MarketData {
  /** One multi-symbol call per poll (PRD 5.2). */
  snapshots(symbols: Symbol[]): Promise<Record<Symbol, Snapshot>>;
  /** One-minute bars in [startMs, endMs) — gap scan (FR-9) and baseline (FR-6). */
  bars(symbol: Symbol, timeframe: "1Min" | "5Min" | "15Min", startMs: number, endMs: number): Promise<Bar[]>;
  /** Multi-symbol minute bars for the gap scan, one call. */
  minuteBarsMulti(symbols: Symbol[], startMs: number, endMs: number): Promise<Record<Symbol, Bar[]>>;
  /** Previous session's consolidated daily bar (FR-6.3). */
  previousDaily(symbol: Symbol, beforeDate: TradingDate): Promise<DailyRef | null>;
  /**
   * Optional (additive, end-of-day summary): official consolidated (SIP) 1Day bars for many symbols
   * in ONE call (the adapter may paginate), for bars with start in [startMs, endMs). The caller
   * keeps endMs at least 15 minutes in the past (free-plan SIP rule). Bars are oldest first.
   */
  officialDailyBars?(symbols: Symbol[], startMs: number, endMs: number, opts?: { splitAdjusted?: boolean }): Promise<Record<Symbol, Bar[]>>;
}

// ---------------------------------------------------------------- config
export type ThresholdInput =
  | { mode: "dollar"; value: number }
  | { mode: "percent"; value: number }; // % from Previous Close, signed

export interface FastInput {
  pct: number; // 0.5-50
  minutes: 5 | 10 | 15 | 30;
}

export type VolumeInput =
  | { mode: "multiple"; value: number } // x AvgCum(t), default 2.0
  | { mode: "absolute"; value: number }; // shares

export interface StockConfig {
  symbol: Symbol;
  enabled: boolean;
  high?: ThresholdInput;
  low?: ThresholdInput;
  volume?: VolumeInput;
  /** One switch for both 52-week alerts (HIGH52 and LOW52). */
  range52?: boolean;
  /** Fast move: the price moves `pct` % up or down within `minutes` (FAST). */
  fast?: FastInput;
  /** One switch for the 50- and 200-day average crossings (MA50, MA200). */
  averages?: boolean;
  /** "Trading stopped" notice: no trades for a while in market hours (information only, no rule state). */
  halt?: boolean;
  mutedUntilMs?: number;
  paused?: boolean;
  notes?: string;
  overrides?: Partial<Settings>;
}

export interface Settings {
  reminderIntervalMin: number; // 1-60, default 10
  autoClear: boolean; // default false (I-3)
  rearmBufferPricePct: number; // default 0.2
  rearmBufferVolumePct: number; // default 10
  volumeNoAlertFirstMin: number; // default 5 (FR-6.4)
  volumeMinAvgCum: number; // default 10000
  volumeMinSessions: number; // default 10
  baselineSessions: number; // 10-60, default 20
  nearPct: number; // default 20 (FR-8.3)
  reminderTidyUp: boolean; // default true (FR-4.12)
  spikeHoldPct: number; // default 10 (FR-3.4)
}

export const DEFAULT_SETTINGS: Settings = {
  reminderIntervalMin: 10,
  autoClear: false,
  rearmBufferPricePct: 0.2,
  rearmBufferVolumePct: 10,
  volumeNoAlertFirstMin: 5,
  volumeMinAvgCum: 10_000,
  volumeMinSessions: 10,
  baselineSessions: 20,
  nearPct: 20,
  reminderTidyUp: true,
  spikeHoldPct: 10,
};

// ---------------------------------------------------------------- alert state
export type AlertState =
  | "ARMED"
  | "TRIGGERED"
  | "REPEATING"
  | "ACKNOWLEDGED"
  | "UNACKNOWLEDGED_AT_CLOSE";

export interface RuleState {
  date: TradingDate;
  symbol: Symbol;
  rule: RuleKind;
  state: AlertState;
  cycle: number; // increments per new crossing; part of alert id (FR-4.10)
  t0Ms?: number;
  t0Value?: number; // price or volume at crossing
  thresholdAtT0?: number;
  touchedAtMs?: number; // set when crossing came from a bar high/low (I-10)
  late?: boolean; // FR-9.3
  remindersSent: number;
  nextReminderMs?: number;
  ackMs?: number;
  ackBy?: "telegram" | "dashboard" | "command" | "ackall";
  lastMessageId?: number; // Telegram message id of latest alert/reminder
  heldPrice?: number; // FR-3.4 spike hold awaiting confirmation
  version: number; // optimistic concurrency
}

export interface MarketState {
  symbol: Symbol;
  date: TradingDate;
  last?: Trade;
  open?: number;
  dayHigh?: number;
  dayLow?: number;
  cumVolume?: number;
  prev?: DailyRef;
  lastPollMs?: number;
  recentMinuteCloses?: number[]; // last 5, for the FR-3.4 median check
  w52?: YearRange;
  /** [minute start ms, last price in that minute], newest last, about 31 minutes (fast move). */
  minutePrices?: [number, number][];
  /** Set while a "trading stopped" notice is open: the time of the last trade before the stop. */
  haltLastTradeMs?: number;
  /** Only on the copy carried by an alert event: the market's (SPY) move today in %, when it is at least 1%. */
  marketMovePct?: number;
}

/**
 * 52-week range from official (SIP) split-adjusted daily bars of the 52 weeks before `date` (today excluded).
 * sessions = 0: no history (high/low missing). Fixed for the whole day.
 */
export interface YearRange {
  date: TradingDate; // the trading date it was built for
  sessions: number;
  high?: number;
  highDate?: TradingDate;
  low?: number;
  lowDate?: TradingDate;
  firstDate?: TradingDate; // oldest bar used (shows "since listing" when the stock is younger than a year)
  /** Simple averages of the last 50 / 200 official closes (missing with fewer sessions). */
  ma50?: number;
  ma200?: number;
  /** Close of the session before `date` (decides which way an average crossing counts). */
  lastClose?: number;
}

export interface Baseline {
  symbol: Symbol;
  builtFor: TradingDate;
  barMinutes: 5 | 15;
  sessions: number; // sessions actually used
  avgCum: number[]; // avgCum[i] = average cumulative volume at end of bucket i
  avgFullDay: number;
  status: "OK" | "BUILDING" | "NO_BASELINE";
}

export type LogKind =
  | "FIRST_ALERT"
  | "REMINDER"
  | "ACK"
  | "LATE_ALERT"
  | "SETTINGS_CHANGE"
  | "ERROR"
  | "SUPPRESSED"
  | "HEALTH";

export interface LogEntry {
  tMs: number;
  kind: LogKind;
  symbol?: Symbol;
  rule?: RuleKind;
  detail: Record<string, unknown>;
}

// ---------------------------------------------------------------- end-of-day summary
/** One alert that fired today (the latest cycle of that rule; `count` = cycles that day). */
export interface EodAlert {
  rule: RuleKind;
  tMs: number;
  count: number;
  acked: boolean;
  /** VOLUME rule in "multiple" mode: how many times the usual (IEX) volume it was at the crossing. */
  multiple?: number;
}
export interface EodStock {
  symbol: Symbol;
  /** Paused stock: still listed, marked "(alerts off)". */
  alertsOff: boolean;
  /** "SIP" = official consolidated numbers; "IEX" = fallback from the intraday data we stored. */
  source: "SIP" | "IEX";
  close?: number;
  prevClose?: number;
  open?: number;
  low?: number;
  high?: number;
  volume?: number;
  /** Average full-day volume over recent sessions, same source as `volume`. */
  avgVolume?: number;
  /** 52-week range before today, and whether today made a new 52-week high / low. */
  w52High?: number;
  w52Low?: number;
  newHigh52?: boolean;
  newLow52?: boolean;
  alerts: EodAlert[]; // oldest first
}
/** Stocks already in display order: alerted first (by first alert time), then A to Z. */
export interface EodSummary {
  stocks: EodStock[];
  /** Set when the summary was cut into several events (each its own queue item, so a retry never resends a part). */
  part?: { n: number; total: number };
  /** Price source over ALL parts, for the footer of the last part. */
  footer?: "SIP" | "IEX" | "MIXED";
}

// ---------------------------------------------------------------- outbound messages
/**
 * Core emits semantic events; the chosen UX (DG-3) turns them into text.
 * Do NOT format production text in core until DG-3 is decided.
 */
export type OutboundEvent =
  | { type: "FIRST_ALERT"; rule: RuleState; market: MarketState; threshold: number }
  | { type: "REMINDER"; rules: RuleState[]; market: MarketState; backInside: boolean }
  | { type: "LATE_ALERT"; rule: RuleState; market: MarketState; threshold: number; barTimeMs: number; barPrice: number }
  | { type: "ACK_CONFIRM"; rule: RuleState }
  | { type: "BRIEFING"; date: TradingDate; stocks: MarketState[] }
  | { type: "UNACK_AT_CLOSE"; date: TradingDate; rules: RuleState[] }
  | { type: "READY"; date: TradingDate; info: Record<string, unknown> }
  | { type: "SESSION_ENDED"; date: TradingDate; counts: Record<string, number>; eod?: EodSummary }
  | { type: "OPS_NOTICE"; code: string; detail: string }
  /** Information only: no trades for a while in market hours (possible halt), and trading again. */
  | { type: "HALT"; symbol: Symbol; lastPrice?: number; lastTradeMs: number; minutes: number }
  | { type: "RESUMED"; symbol: Symbol; price: number; tMs: number }
  | { type: "TEST_ALERT" };

/** Priority for the send queue (FR-5.4): lower sends first. */
export const EVENT_PRIORITY: Record<OutboundEvent["type"], number> = {
  FIRST_ALERT: 0,
  LATE_ALERT: 0,
  TEST_ALERT: 0,
  REMINDER: 1,
  ACK_CONFIRM: 1,
  UNACK_AT_CLOSE: 1,
  BRIEFING: 2,
  READY: 3,
  SESSION_ENDED: 3,
  OPS_NOTICE: 3,
  HALT: 0,
  RESUMED: 2,
};

export interface Notifier {
  /** Returns the Telegram message id, or throws. */
  send(event: OutboundEvent): Promise<number>;
  edit(messageId: number, event: OutboundEvent): Promise<void>;
  delete(messageId: number): Promise<void>;
}

// ---------------------------------------------------------------- storage
export interface Store {
  // config
  getSettings(): Promise<Settings>;
  putSettings(s: Settings): Promise<void>;
  listStocks(): Promise<StockConfig[]>;
  putStock(s: StockConfig): Promise<void>;
  deleteStock(symbol: Symbol): Promise<void>;

  // lock (FR-4.11) — returns true if acquired
  acquireLease(name: string, holder: string, nowMs: number, ttlMs: number): Promise<boolean>;
  releaseLease(name: string, holder: string): Promise<void>;

  // market + baseline
  getMarketStates(date: TradingDate): Promise<MarketState[]>;
  putMarketStates(states: MarketState[]): Promise<void>; // batched
  getBaseline(symbol: Symbol): Promise<Baseline | null>;
  putBaseline(b: Baseline): Promise<void>;
  /** Optional (additive): all baselines in ONE call; core falls back to getBaseline per symbol. */
  getBaselines?(): Promise<Baseline[]>;

  // alert states
  getRuleStates(date: TradingDate): Promise<RuleState[]>;
  getRuleState(date: TradingDate, symbol: Symbol, rule: RuleKind): Promise<RuleState | null>;
  /** Optimistic write: succeeds only if stored version === expectedVersion. */
  putRuleState(s: RuleState, expectedVersion: number): Promise<boolean>;
  /** FR-4.10 — insert alert id (date,symbol,rule,cycle); false if it already exists. */
  claimAlertId(date: TradingDate, symbol: Symbol, rule: RuleKind, cycle: number): Promise<boolean>;
  /** Optional batched forms (one round trip each); core falls back to the single versions. Results are in input order. */
  claimAlertIds?(ids: { date: TradingDate; symbol: Symbol; rule: RuleKind; cycle: number }[]): Promise<boolean[]>;
  putRuleStates?(items: { state: RuleState; expectedVersion: number }[]): Promise<boolean[]>;
  enqueueMany?(items: { event: OutboundEvent; priority: number; nowMs: number }[]): Promise<void>;

  // run bookkeeping (FR-9.1)
  getLastSuccessfulPollMs(): Promise<number | null>;
  setLastSuccessfulPollMs(ms: number): Promise<void>;

  // outbound queue (FR-5.8)
  enqueue(event: OutboundEvent, priority: number, nowMs: number): Promise<void>;
  dequeueBatch(limit: number): Promise<{ id: number; event: OutboundEvent }[]>;
  markSent(id: number): Promise<void>;

  // log (FR-11)
  log(entries: LogEntry[]): Promise<void>;

  // budget counters (FR-10.4)
  bumpCounters(date: TradingDate, deltas: Record<string, number>): Promise<void>;
  getCounters(date: TradingDate): Promise<Record<string, number>>;
}
