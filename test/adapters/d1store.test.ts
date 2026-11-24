import { describe, expect, it } from "vitest";
import { D1Store } from "../../src/adapters/d1store";
import type { RuleState } from "../../src/core/ports";
import { FakeD1 } from "./fake-d1";

const rs = (o: Partial<RuleState> = {}): RuleState => ({ date: "2026-11-24", symbol: "AAPL", rule: "HIGH", state: "TRIGGERED", cycle: 1, remindersSent: 0, version: 1, ...o });
const mk = () => { const d = new FakeD1(); let t = 1_000_000; return { d, s: new D1Store(d.asD1(), { now: () => t, cacheTtlMs: 0 }), tick: (ms: number) => { t += ms; } }; };

describe("D1Store", () => {
  it("lease: second holder blocked until expiry, same holder renews, release frees", async () => {
    const { s } = mk();
    expect(await s.acquireLease("run", "a", 1000, 50_000)).toBe(true);
    expect(await s.acquireLease("run", "b", 2000, 50_000)).toBe(false);
    expect(await s.acquireLease("run", "a", 3000, 50_000)).toBe(true);
    expect(await s.acquireLease("run", "b", 52_000, 50_000)).toBe(false);
    expect(await s.acquireLease("run", "b", 53_001, 50_000)).toBe(true);
    await s.releaseLease("run", "b");
    expect(await s.acquireLease("run", "c", 53_002, 50_000)).toBe(true);
  });

  it("claimAlertId is unique per (date,symbol,rule,cycle)", async () => {
    const { s } = mk();
    expect(await s.claimAlertId("2026-11-24", "AAPL", "HIGH", 1)).toBe(true);
    expect(await s.claimAlertId("2026-11-24", "AAPL", "HIGH", 1)).toBe(false);
    expect(await s.claimAlertId("2026-11-24", "AAPL", "HIGH", 2)).toBe(true);
  });

  it("putRuleState is optimistic", async () => {
    const { s } = mk();
    expect(await s.putRuleState(rs({ version: 1 }), 0)).toBe(true);
    expect(await s.putRuleState(rs({ version: 1 }), 0)).toBe(false); // already exists
    expect(await s.putRuleState(rs({ state: "ACKNOWLEDGED", version: 2 }), 1)).toBe(true);
    expect(await s.putRuleState(rs({ state: "REPEATING", version: 2 }), 1)).toBe(false); // stale
    const got = await s.getRuleState("2026-11-24", "AAPL", "HIGH");
    expect(got?.state).toBe("ACKNOWLEDGED");
    expect(got?.version).toBe(2);
  });

  it("queue dequeues by priority then id and marks sent", async () => {
    const { s } = mk();
    await s.enqueue({ type: "READY", date: "d", info: {} }, 3, 1);
    await s.enqueue({ type: "TEST_ALERT" }, 0, 2);
    await s.enqueue({ type: "OPS_NOTICE", code: "x", detail: "y" }, 3, 3);
    const b = await s.dequeueBatch(10);
    expect(b.map((x) => x.event.type)).toEqual(["TEST_ALERT", "READY", "OPS_NOTICE"]);
    await s.markSent(b[0]!.id);
    expect((await s.dequeueBatch(10)).length).toBe(2);
  });

  it("settings and stock changes keep a config log with previous value (FR-2.5)", async () => {
    const { s, d } = mk();
    await s.putStock({ symbol: "AAPL", enabled: true, high: { mode: "dollar", value: 200 } });
    await s.putStock({ symbol: "AAPL", enabled: true, high: { mode: "dollar", value: 210 } });
    await s.putStock({ symbol: "AAPL", enabled: true, high: { mode: "dollar", value: 210 } }); // unchanged: no write
    const log = d.rows("SELECT kind, prev, next FROM config_log ORDER BY id");
    expect(log).toHaveLength(2);
    expect(String(log[1]!.prev)).toContain("200");
    expect((await s.listStocks())[0]?.high).toEqual({ mode: "dollar", value: 210 });
  });

  it("market states: unchanged rows are not rewritten; one batch call", async () => {
    const { s, d } = mk();
    const m = { symbol: "AAPL", date: "2026-11-24", open: 1 };
    await s.putMarketStates([m]);
    const used = s.counter.used;
    await s.putMarketStates([m]);
    expect(s.counter.used).toBe(used);
    await s.putMarketStates([{ ...m, open: 2 }, { symbol: "MSFT", date: "2026-11-24" }]);
    expect(s.counter.used).toBe(used + 1);
    expect(d.rows("SELECT * FROM market_state")).toHaveLength(2);
  });

  it("counters, log, purge", async () => {
    const { s, d } = mk();
    await s.bumpCounters("2026-11-24", { a: 1, b: 2 });
    await s.bumpCounters("2026-11-24", { a: 4 });
    expect(await s.getCounters("2026-11-24")).toEqual({ a: 5, b: 2 });
    await s.log([{ tMs: 1, kind: "ERROR", detail: {} }, { tMs: Date.now(), kind: "ACK", symbol: "AAPL", detail: { x: 1 } }]);
    await s.purgeOld(Date.now());
    expect(d.rows("SELECT * FROM log")).toHaveLength(1);
  });
});
