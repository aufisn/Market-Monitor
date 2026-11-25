/** End-of-day summary: timing, SIP request window, retries, fallback, ordering, budget (ux/improvements.md section 5). */
import { describe, expect, it } from "vitest";
import { CALL_BUDGET, runTick } from "../../src/core/engine";
import { buildEodStocks } from "../../src/core/eod";
import type { Bar, RuleState, StockConfig } from "../../src/core/ports";
import { MIN, addDays } from "../../src/core/time";
import { DAY1, FakeMarket, MemStore, et } from "./memory";

const EARLY = "2026-11-27"; // closes 13:00
class SipMarket extends FakeMarket {
  official: Record<string, Bar[]> = {};
  fail = false;
  requests: { symbols: string[]; startMs: number; endMs: number; at: number }[] = [];
  nowRef = 0;
  async officialDailyBars(symbols: string[], startMs: number, endMs: number) {
    this.requests.push({ symbols, startMs, endMs, at: this.nowRef });
    if (this.fail) throw new Error("sip down");
    return Object.fromEntries(symbols.filter((s) => this.official[s]).map((s) => [s, this.official[s]!]));
  }
}
interface R { store: MemStore; market: SipMarket; ports: { store: MemStore; market: SipMarket } }

const dayBar = (date: string, c: number, v: number, o = c): Bar => ({ t: Date.parse(`${date}T05:00:00Z`), o, h: c + 1, l: c - 1, c, v });
/** `n` earlier sessions (volume 1M each, close 100) then today's bar. */
function series(date: string, today: Bar, n = 10): Bar[] {
  const past = Array.from({ length: n }, (_, i) => dayBar(addDays(date, -(n - i)), 100, 1_000_000));
  return [...past, today];
}
function sipRig(stocks: StockConfig[], date = DAY1): R {
  const store = new MemStore();
  const market = new SipMarket();
  for (const s of stocks) { store.stocks.set(s.symbol, s); store.seedPrev(date, s.symbol, 100); }
  return { store, market, ports: { store, market } };
}
const run = (r: R, t: number) => {
  r.market.nowRef = t;
  return runTick(r.ports, t);
};
const stocks = (): StockConfig[] => [
  { symbol: "TSLA", enabled: true, high: { mode: "dollar", value: 110 }, low: { mode: "dollar", value: 90 } },
  { symbol: "AAPL", enabled: true, high: { mode: "dollar", value: 110 } },
  { symbol: "AMZN", enabled: true, paused: true, high: { mode: "dollar", value: 110 } },
];
function feed(r: R, date: string, syms = ["TSLA", "AAPL", "AMZN"]) {
  for (const s of syms) r.market.official[s] = series(date, dayBar(date, 110, 2_000_000, 101));
}
const ended = (r: R) => r.store.events("SESSION_ENDED");

describe("end-of-day summary timing", () => {
  it("normal day: nothing before 16:20 ET, one summary at 16:20, never twice", async () => {
    const r = sipRig(stocks());
    feed(r, DAY1);
    for (const t of ["16:00", "16:05", "16:19:30"]) await run(r, et(DAY1, t));
    expect(ended(r)).toHaveLength(0);
    expect(r.market.requests).toHaveLength(0); // nothing fetched before the time
    await run(r, et(DAY1, "16:20"));
    expect(ended(r)).toHaveLength(1);
    expect(r.store.queue.find((q) => q.event.type === "SESSION_ENDED")!.tMs).toBe(et(DAY1, "16:20"));
    for (const t of ["16:21", "16:30", "16:45", "16:59"]) await run(r, et(DAY1, t));
    expect(ended(r)).toHaveLength(1);
    expect(r.market.requests).toHaveLength(1); // no market call once it is sent
    expect(ended(r)[0]!.eod!.stocks.every((s) => s.source === "SIP")).toBe(true);
  });
  it("early-close day: 13:20 ET", async () => {
    const r = sipRig(stocks(), EARLY);
    feed(r, EARLY);
    await run(r, et(EARLY, "13:19"));
    expect(ended(r)).toHaveLength(0);
    await run(r, et(EARLY, "13:20"));
    expect(ended(r)).toHaveLength(1);
    await run(r, et(EARLY, "13:21"));
    expect(ended(r)).toHaveLength(1);
  });
  it("20:20 UTC in summer and 21:20 UTC in winter are both inside the cron window 11-21 UTC", () => {
    expect(et("2026-07-01", "16:20")).toBe(Date.parse("2026-07-01T20:20:00Z"));
    expect(et(DAY1, "16:20")).toBe(Date.parse("2026-11-30T21:20:00Z"));
    expect(et(EARLY, "13:20")).toBe(Date.parse("2026-11-27T18:20:00Z"));
    expect(et(DAY1, "16:55")).toBe(Date.parse("2026-11-30T21:55:00Z")); // last retry still before 22:00 UTC
  });
});

describe("official data request", () => {
  it("SIP request end is at least 15 minutes old, after the close, one call for all stocks", async () => {
    for (const [date, hhmm, close] of [[DAY1, "16:20", "16:00"], [DAY1, "16:31", "16:00"], [EARLY, "13:20", "13:00"]] as const) {
      const r = sipRig(stocks(), date);
      feed(r, date);
      r.market.fail = hhmm === "16:31"; // a failed request is still recorded
      await run(r, et(date, hhmm));
      const q = r.market.requests[0]!;
      expect([...q.symbols].sort()).toEqual(["AAPL", "AMZN", "TSLA"]); // paused stock included
      expect(q.at - q.endMs).toBeGreaterThanOrEqual(15 * MIN);
      expect(q.endMs).toBeGreaterThan(et(date, close)); // after the closing auction
      expect(q.endMs).toBeLessThanOrEqual(et(date, close) + 5 * MIN);
      expect(q.startMs).toBeLessThan(et(date, close) - 28 * 86_400_000); // room for baselineSessions sessions
      expect(r.market.requests).toHaveLength(1);
    }
  });
  it("builds close, prev close, open, low, high, volume and the usual volume from the bars", async () => {
    const r = sipRig([stocks()[0]!]);
    r.market.official.TSLA = series(DAY1, { t: Date.parse(`${DAY1}T05:00:00Z`), o: 249.1, h: 250.4, l: 240.95, c: 241.8, v: 142_600_000 });
    r.market.official.TSLA![9] = dayBar(addDays(DAY1, -1), 251.6, 1_000_000);
    await run(r, et(DAY1, "16:20"));
    expect(ended(r)[0]!.eod!.stocks[0]).toMatchObject({ symbol: "TSLA", source: "SIP", close: 241.8, prevClose: 251.6, open: 249.1, low: 240.95, high: 250.4, volume: 142_600_000, avgVolume: 1_000_000 });
  });
  it("the usual volume uses only settings.baselineSessions past sessions and ignores today", async () => {
    const r = sipRig([stocks()[0]!]);
    r.store.settings.baselineSessions = 10;
    r.market.official.TSLA = series(DAY1, dayBar(DAY1, 110, 99_000_000), 25).map((b, i) => (i < 15 ? { ...b, v: 9_000_000 } : b)); // oldest 15 are outliers
    await run(r, et(DAY1, "16:20"));
    expect(ended(r)[0]!.eod!.stocks[0]!.avgVolume).toBe(1_000_000);
  });
});

describe("retry and fallback", () => {
  it("SIP failure: retried on later runs and sent as soon as it works", async () => {
    const r = sipRig(stocks());
    feed(r, DAY1);
    r.market.fail = true;
    for (const t of ["16:20", "16:21", "16:22"]) await run(r, et(DAY1, t));
    expect(ended(r)).toHaveLength(0);
    expect(r.market.requests).toHaveLength(3);
    r.market.fail = false;
    await run(r, et(DAY1, "16:23"));
    expect(ended(r)).toHaveLength(1);
    expect(ended(r)[0]!.eod!.stocks.every((s) => s.source === "SIP")).toBe(true);
  });
  it("still failing at close + 55 min: sent once with the IEX values we stored, marked IEX", async () => {
    const r = sipRig(stocks());
    r.store.market.set(`${DAY1}|TSLA`, { symbol: "TSLA", date: DAY1, last: { t: 1, p: 240, s: 1 }, open: 245, dayHigh: 250, dayLow: 238, cumVolume: 9_000_000, prev: { symbol: "TSLA", date: "2026-11-27", close: 250, high: 255, low: 245, volume: 1 } });
    r.market.fail = true;
    for (let m = 20; m < 60; m++) await run(r, et(DAY1, "16:00") + m * MIN);
    expect(ended(r)).toHaveLength(1);
    expect(r.store.queue.find((q) => q.event.type === "SESSION_ENDED")!.tMs).toBe(et(DAY1, "16:55"));
    const list = ended(r)[0]!.eod!.stocks;
    expect(list.find((s) => s.symbol === "TSLA")).toMatchObject({ source: "IEX", close: 240, prevClose: 250, open: 245, low: 238, high: 250, volume: 9_000_000 });
    const aapl = list.find((s) => s.symbol === "AAPL")!;
    expect(aapl.source).toBe("IEX");
    expect(aapl.close).toBeUndefined(); // missing values stay missing (rendered "n/a")
  });
  it("one symbol missing from the SIP answer: waits until close + 35, then sends the rest as SIP and that one as IEX", async () => {
    const r = sipRig(stocks());
    feed(r, DAY1, ["TSLA", "AMZN"]);
    await run(r, et(DAY1, "16:20"));
    await run(r, et(DAY1, "16:34"));
    expect(ended(r)).toHaveLength(0); // still waiting for completeness before close + 35
    await run(r, et(DAY1, "16:35"));
    expect(ended(r)).toHaveLength(1);
    const by = Object.fromEntries(ended(r)[0]!.eod!.stocks.map((s) => [s.symbol, s.source]));
    expect(by).toEqual({ TSLA: "SIP", AMZN: "SIP", AAPL: "IEX" });
  });
  it("no summary run after close + 60 min", async () => {
    const r = sipRig(stocks());
    feed(r, DAY1);
    expect((await run(r, et(DAY1, "17:00"))).status).toBe("idle");
    expect(ended(r)).toHaveLength(0);
  });
  it("a store failure while building never throws out of the run", async () => {
    const r = sipRig(stocks());
    feed(r, DAY1);
    r.store.getMarketStates = async () => { throw new Error("d1 down"); };
    await expect(run(r, et(DAY1, "16:20"))).resolves.toMatchObject({ status: "closing" });
    expect(ended(r)).toHaveLength(0);
  });
  it("a market without the SIP method sends the plain summary at 16:20 (no waiting)", async () => {
    const store = new MemStore();
    for (const s of stocks()) store.stocks.set(s.symbol, s);
    await runTick({ store, market: new FakeMarket() }, et(DAY1, "16:20"));
    expect(store.events("SESSION_ENDED")).toHaveLength(1);
  });
});

describe("alerts, order, counts and budget", () => {
  const rs = (symbol: string, rule: RuleState["rule"], t: number, o: Partial<RuleState> = {}): RuleState => ({
    date: DAY1, symbol, rule, state: "ACKNOWLEDGED", cycle: 1, t0Ms: t, remindersSent: 0, ackMs: t + MIN, version: 1, ...o,
  });
  it("alerted stocks first by first alert time, then A to Z; alerts-off stocks are flagged", async () => {
    const r = sipRig([...stocks(), { symbol: "MSFT", enabled: true }, { symbol: "OFF", enabled: false }]);
    feed(r, DAY1, ["TSLA", "AAPL", "AMZN", "MSFT"]);
    r.store.rules.set(`${DAY1}|TSLA|LOW`, rs("TSLA", "LOW", et(DAY1, "15:00")));
    r.store.rules.set(`${DAY1}|MSFT|HIGH`, rs("MSFT", "HIGH", et(DAY1, "10:42")));
    r.store.rules.set(`${DAY1}|MSFT|VOLUME`, rs("MSFT", "VOLUME", et(DAY1, "09:50"), { state: "UNACKNOWLEDGED_AT_CLOSE", ackMs: undefined }));
    await run(r, et(DAY1, "16:20"));
    const list = ended(r)[0]!.eod!.stocks;
    expect(list.map((s) => s.symbol)).toEqual(["MSFT", "TSLA", "AAPL", "AMZN"]); // OFF (disabled) is not listed
    expect(list.find((s) => s.symbol === "AMZN")!.alertsOff).toBe(true);
    expect(list[0]!.alerts.map((a) => [a.rule, a.acked])).toEqual([["VOLUME", false], ["HIGH", true]]); // oldest first
  });
  it("volume alert carries how many times the usual volume it was at", () => {
    const [s] = buildEodStocks({
      date: DAY1, stocks: [{ symbol: "NVDA", enabled: true, volume: { mode: "multiple", value: 2 } }], states: new Map(), baselines: new Map(), sessions: 20,
      rules: [rs("NVDA", "VOLUME", 1, { t0Value: 5_000_000, thresholdAtT0: 4_000_000 })],
    });
    expect(s!.alerts[0]!.multiple).toBeCloseTo(2.5);
  });
  it("the run that sends the summary stays well within the call budget; counts are kept", async () => {
    const r = sipRig(stocks());
    feed(r, DAY1);
    r.store.counters.set(DAY1, { alerts: 3, reminders: 5, acks: 3, closed: 1 });
    const s = await run(r, et(DAY1, "16:20"));
    expect(s.calls).toBeLessThanOrEqual(15);
    expect(s.calls).toBeLessThan(CALL_BUDGET);
    expect(ended(r)[0]!.counts).toMatchObject({ alerts: 3, reminders: 5, acks: 3 });
    const later = await run(r, et(DAY1, "16:21"));
    expect(later.calls).toBeLessThanOrEqual(5); // later runs: lease + counters only
  });
});

describe("QA fixes", () => {
  it("marker is written before the enqueue: a failing enqueue loses the summary, never doubles it", async () => {
    const r = sipRig(stocks());
    feed(r, DAY1);
    const enq = r.store.enqueueMany.bind(r.store);
    let fail = true;
    r.store.enqueueMany = async (items) => { if (fail) { fail = false; throw new Error("d1 hiccup"); } return enq(items); };
    await expect(run(r, et(DAY1, "16:20"))).rejects.toThrow();
    await run(r, et(DAY1, "16:21"));
    await run(r, et(DAY1, "16:22"));
    expect(ended(r)).toHaveLength(0);
  });
  it("a failing counters write (once) never gives two summaries", async () => {
    const r = sipRig(stocks());
    feed(r, DAY1);
    const bump = r.store.bumpCounters.bind(r.store);
    let fail = true;
    r.store.bumpCounters = async (d, x) => { if (fail && x.ended) { fail = false; throw new Error("d1 hiccup"); } return bump(d, x); };
    await expect(run(r, et(DAY1, "16:20"))).rejects.toThrow();
    for (const t of ["16:21", "16:22", "16:23"]) await run(r, et(DAY1, t));
    expect(ended(r).length).toBeLessThanOrEqual(1);
  });
  it("UNACK_AT_CLOSE marker is also written first (no double notice)", async () => {
    const r = sipRig(stocks());
    r.store.rules.set(`${DAY1}|TSLA|HIGH`, { date: DAY1, symbol: "TSLA", rule: "HIGH", state: "TRIGGERED", cycle: 1, t0Ms: et(DAY1, "15:00"), remindersSent: 0, version: 1 });
    const enq = r.store.enqueue.bind(r.store);
    let fail = true;
    r.store.enqueue = async (e, p, n) => { if (fail && e.type === "UNACK_AT_CLOSE") { fail = false; throw new Error("x"); } return enq(e, p, n); };
    await run(r, et(DAY1, "16:00")).catch(() => undefined);
    await run(r, et(DAY1, "16:01")).catch(() => undefined);
    expect(r.store.count("UNACK_AT_CLOSE")).toBeLessThanOrEqual(1);
  });
  it("after the summary is sent later runs only read the counters (no lease, no writes)", async () => {
    const r = sipRig(stocks());
    feed(r, DAY1);
    await run(r, et(DAY1, "16:20"));
    const s = await run(r, et(DAY1, "16:21"));
    expect(s).toMatchObject({ status: "closing", calls: 1, writes: 0 });
    expect(r.store.leases.size).toBe(0);
  });
  it("long lists become separate queue items in order, one batched enqueue, counts on every part", async () => {
    const many = Array.from({ length: 30 }, (_, i): StockConfig => ({ symbol: `S${String(i).padStart(2, "0")}`, enabled: true, high: { mode: "dollar", value: 110 } }));
    const r = sipRig(many);
    feed(r, DAY1, many.map((s) => s.symbol));
    const s = await run(r, et(DAY1, "16:20"));
    const evs = ended(r);
    expect(evs.map((e) => e.eod!.part)).toEqual([{ n: 1, total: 3 }, { n: 2, total: 3 }, { n: 3, total: 3 }]);
    expect(evs.flatMap((e) => e.eod!.stocks.map((x) => x.symbol))).toEqual(many.map((x) => x.symbol));
    expect(evs.every((e) => e.eod!.footer === "SIP")).toBe(true);
    expect(s.calls).toBeLessThan(20);
  });
  it("SIP failure: one OPS_NOTICE and one log line per trading date, not per run", async () => {
    const r = sipRig(stocks());
    feed(r, DAY1);
    r.market.fail = true;
    for (let m = 20; m < 30; m++) await run(r, et(DAY1, "16:00") + m * MIN);
    const n = r.store.queue.filter((q) => q.event.type === "OPS_NOTICE" && q.event.code === "EOD_SIP_UNAVAILABLE");
    expect(n).toHaveLength(1);
    expect(r.store.logs.filter((l) => l.detail.what === "eod_sip_failed")).toHaveLength(1);
    expect(ended(r)).toHaveLength(0);
  });
});
