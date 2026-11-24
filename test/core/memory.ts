/** In-memory ports for core tests: Store, Clock, MarketData (scripted), Notifier. */
import { DEFAULT_SETTINGS } from "../../src/core/ports";
import type {
  Bar, Baseline, Clock, DailyRef, LogEntry, MarketData, MarketState, Notifier, OutboundEvent, RuleKind, RuleState,
  Settings, Snapshot, StockConfig, Store, TradingDate,
} from "../../src/core/ports";
import { nyLocalToUtc, MIN } from "../../src/core/time";

const clone = <T>(x: T): T => structuredClone(x);

export class FakeClock implements Clock {
  constructor(public t = 0) {}
  nowMs() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

/** UTC ms of New York wall-clock "HH:MM[:SS]" on a date. */
export function et(date: TradingDate, hhmm: string): number {
  const [h, m, s] = hhmm.split(":").map(Number);
  return nyLocalToUtc(date, h!, m!) + (s ?? 0) * 1000;
}

export class MemStore implements Store {
  settings: Settings = { ...DEFAULT_SETTINGS };
  stocks = new Map<string, StockConfig>();
  leases = new Map<string, { holder: string; exp: number }>();
  market = new Map<string, MarketState>(); // key date|symbol
  baselines = new Map<string, Baseline>();
  rules = new Map<string, RuleState>(); // key date|symbol|rule
  alertIds = new Set<string>();
  lastPoll: number | null = null;
  queue: { id: number; event: OutboundEvent; priority: number; tMs: number; sent: boolean }[] = [];
  logs: LogEntry[] = [];
  counters = new Map<string, Record<string, number>>();
  nextId = 1;
  /** Test hooks to inject a concurrent action at a precise moment. */
  beforeGetRuleState?: () => Promise<void> | void;
  beforePutRuleState?: () => Promise<void> | void;

  async getSettings() { return clone(this.settings); }
  async putSettings(s: Settings) { this.settings = clone(s); }
  async listStocks() { return [...this.stocks.values()].map(clone); }
  async putStock(s: StockConfig) { this.stocks.set(s.symbol, clone(s)); }
  async deleteStock(sym: string) { this.stocks.delete(sym); }

  async acquireLease(name: string, holder: string, nowMs: number, ttlMs: number) {
    const l = this.leases.get(name);
    if (l && l.exp > nowMs && l.holder !== holder) return false;
    this.leases.set(name, { holder, exp: nowMs + ttlMs });
    return true;
  }
  async releaseLease(name: string, holder: string) {
    if (this.leases.get(name)?.holder === holder) this.leases.delete(name);
  }

  async getMarketStates(date: TradingDate) { return [...this.market.values()].filter((m) => m.date === date).map(clone); }
  async putMarketStates(states: MarketState[]) { for (const s of states) this.market.set(`${s.date}|${s.symbol}`, clone(s)); }
  async getBaseline(sym: string) { return clone(this.baselines.get(sym) ?? null); }
  async putBaseline(b: Baseline) { this.baselines.set(b.symbol, clone(b)); }
  async getBaselines() { return [...this.baselines.values()].map(clone); }

  async getRuleStates(date: TradingDate) { return [...this.rules.values()].filter((r) => r.date === date).map(clone); }
  async getRuleState(date: TradingDate, symbol: string, rule: RuleKind) {
    await this.beforeGetRuleState?.();
    return clone(this.rules.get(`${date}|${symbol}|${rule}`) ?? null);
  }
  async putRuleState(s: RuleState, expectedVersion: number) {
    await this.beforePutRuleState?.();
    const key = `${s.date}|${s.symbol}|${s.rule}`;
    const cur = this.rules.get(key);
    if ((cur?.version ?? 0) !== expectedVersion) return false;
    this.rules.set(key, { ...clone(s), version: expectedVersion + 1 });
    return true;
  }
  async claimAlertId(date: TradingDate, symbol: string, rule: RuleKind, cycle: number) {
    const k = `${date}|${symbol}|${rule}|${cycle}`;
    if (this.alertIds.has(k)) return false;
    this.alertIds.add(k);
    return true;
  }

  async getLastSuccessfulPollMs() { return this.lastPoll; }
  async setLastSuccessfulPollMs(ms: number) { this.lastPoll = ms; }

  async enqueue(event: OutboundEvent, priority: number, nowMs: number) {
    this.queue.push({ id: this.nextId++, event: clone(event), priority, tMs: nowMs, sent: false });
  }
  async dequeueBatch(limit: number) {
    return this.queue.filter((q) => !q.sent).sort((a, b) => a.priority - b.priority || a.id - b.id).slice(0, limit).map((q) => ({ id: q.id, event: clone(q.event) }));
  }
  async markSent(id: number) { const q = this.queue.find((x) => x.id === id); if (q) q.sent = true; }

  async log(entries: LogEntry[]) { this.logs.push(...clone(entries)); }
  async bumpCounters(date: TradingDate, deltas: Record<string, number>) {
    const c = this.counters.get(date) ?? {};
    for (const [k, v] of Object.entries(deltas)) c[k] = (c[k] ?? 0) + v;
    this.counters.set(date, c);
  }
  async getCounters(date: TradingDate) { return { ...(this.counters.get(date) ?? {}) }; }

  // ---- test conveniences
  events<T extends OutboundEvent["type"]>(type: T) {
    return this.queue.filter((q) => q.event.type === type).map((q) => q.event as Extract<OutboundEvent, { type: T }>);
  }
  count(type: OutboundEvent["type"]) { return this.queue.filter((q) => q.event.type === type).length; }
  rule(date: TradingDate, symbol: string, rule: RuleKind) { return this.rules.get(`${date}|${symbol}|${rule}`); }
  seedPrev(date: TradingDate, symbol: string, close: number) {
    const prev: DailyRef = { symbol, date: "2026-11-27", close, high: close * 1.02, low: close * 0.98, volume: 1_000_000 };
    this.market.set(`${date}|${symbol}`, { symbol, date, prev });
  }
}

/** Scripted market: tests set `snaps` before each tick; `bars1` serves the gap scan. */
export class FakeMarket implements MarketData {
  snaps: Record<string, Snapshot> = {};
  bars1: Record<string, Bar[]> = {};
  barsByTf: Record<string, Bar[]> = {};
  prevDaily: Record<string, DailyRef> = {};
  failSnapshots = 0;
  calls = { snapshots: 0, bars: 0, multi: 0, prev: 0 };

  async snapshots(symbols: string[]) {
    this.calls.snapshots++;
    if (this.failSnapshots > 0) { this.failSnapshots--; throw new Error("provider down"); }
    return Object.fromEntries(symbols.filter((s) => this.snaps[s]).map((s) => [s, this.snaps[s]!]));
  }
  async bars(symbol: string) { this.calls.bars++; return this.barsByTf[symbol] ?? []; }
  async minuteBarsMulti(symbols: string[], startMs: number, endMs: number) {
    this.calls.multi++;
    return Object.fromEntries(symbols.map((s) => [s, (this.bars1[s] ?? []).filter((b) => b.t >= startMs && b.t < endMs)]));
  }
  async previousDaily(symbol: string) { this.calls.prev++; return this.prevDaily[symbol] ?? null; }
}

export class FakeNotifier implements Notifier {
  sent: OutboundEvent[] = [];
  edits: { id: number; event: OutboundEvent }[] = [];
  deleted: number[] = [];
  async send(e: OutboundEvent) { this.sent.push(e); return this.sent.length; }
  async edit(id: number, event: OutboundEvent) { this.edits.push({ id, event }); }
  async delete(id: number) { this.deleted.push(id); }
}

/** Build a snapshot around a price at `nowMs`. */
export function snap(symbol: string, price: number, nowMs: number, o: { hi?: number; lo?: number; prevHi?: number; prevLo?: number; cum?: number; open?: number; conditions?: string[] } = {}): Snapshot {
  const minute = Math.floor(nowMs / MIN) * MIN;
  return {
    symbol,
    latestTrade: { t: nowMs, p: price, s: 100, conditions: o.conditions },
    minuteBar: { t: minute, o: price, h: o.hi ?? price, l: o.lo ?? price, c: price, v: 1000 },
    prevMinuteBar: { t: minute - MIN, o: price, h: o.prevHi ?? price, l: o.prevLo ?? price, c: price, v: 1000 },
    dailyBar: { t: 0, o: o.open ?? 100, h: o.hi ?? price, l: o.lo ?? price, c: price, v: o.cum ?? 0 },
  };
}

export const DAY1 = "2026-11-30"; // an ordinary Monday

export interface Rig { store: MemStore; market: FakeMarket; ports: { store: MemStore; market: FakeMarket }; }
/** One stock AAA (HIGH 110, LOW 90, Previous Close 100) unless told otherwise. */
export function rig(stocks: StockConfig[] = [{ symbol: "AAA", enabled: true, high: { mode: "dollar", value: 110 }, low: { mode: "dollar", value: 90 } }], date: TradingDate = DAY1, prevClose = 100): Rig {
  const store = new MemStore();
  const market = new FakeMarket();
  for (const s of stocks) { store.stocks.set(s.symbol, s); store.seedPrev(date, s.symbol, prevClose); }
  return { store, market, ports: { store, market } };
}

/** A flat baseline: `perMin` shares per minute, 5-minute buckets, 20 sessions. */
export function flatBaseline(symbol: string, perMin: number, date: TradingDate = DAY1, sessions = 20): Baseline {
  const avgCum = Array.from({ length: 78 }, (_, i) => (i + 1) * 5 * perMin);
  return { symbol, builtFor: date, barMinutes: 5, sessions, avgCum, avgFullDay: avgCum[77]!, status: "OK" };
}
