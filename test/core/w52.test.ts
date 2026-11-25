import { describe, expect, it } from "vitest";
import { runPreOpen, runTick } from "../../src/core/engine";
import type { Ports } from "../../src/core/engine";
import { buildEodStocks } from "../../src/core/eod";
import type { Bar, StockConfig } from "../../src/core/ports";
import { addDays, nyLocalToUtc } from "../../src/core/time";
import { buildYearRange, yearWindow } from "../../src/core/yearrange";
import { DAY1, et, rig, snap } from "./memory";
import type { Rig } from "./memory";

const D = DAY1;
const day = (date: string, h: number, l: number): Bar => ({ t: nyLocalToUtc(date, 0), o: (h + l) / 2, h, l, c: (h + l) / 2, v: 1000 });
/** A year of daily bars: high 120 on one day, low 80 on another, 100 +/- 5 otherwise. */
function year(date = D): Bar[] {
  const out: Bar[] = [];
  for (let i = 360; i >= 1; i--) {
    const d = addDays(date, -i);
    out.push(i === 100 ? day(d, 120, 98) : i === 200 ? day(d, 102, 80) : day(d, 105, 95));
  }
  return out;
}
const STOCK: StockConfig = { symbol: "AAA", enabled: true, range52: true };

function withOfficial(r: Rig, bars: Record<string, Bar[]>) {
  const calls: { syms: string[]; opts?: { splitAdjusted?: boolean } }[] = [];
  Object.assign(r.market, {
    officialDailyBars: async (syms: string[], s: number, e: number, opts?: { splitAdjusted?: boolean }) => {
      calls.push({ syms, opts });
      return Object.fromEntries(syms.map((x) => [x, (bars[x] ?? []).filter((b) => b.t >= s && b.t < e)]));
    },
  });
  return calls;
}
const go = (r: Rig, t: number, price: number, sym = "AAA") => {
  r.market.snaps[sym] = snap(sym, price, t);
  return runTick(r.ports as Ports, t);
};

describe("52-week range", () => {
  it("is the highest high and lowest low of the 52 weeks before the date, today excluded", () => {
    const bars = [...year(), day(D, 200, 1)];
    const w = buildYearRange(D, bars);
    expect(w).toMatchObject({ date: D, sessions: 360, high: 120, highDate: addDays(D, -100), low: 80, lowDate: addDays(D, -200) });
    expect(yearWindow(D).endMs).toBe(nyLocalToUtc(D, 0));
    expect(buildYearRange(D, [])).toEqual({ date: D, sessions: 0 });
  });

  it("is loaded before the open with split-adjusted official bars, once per day", async () => {
    const r = rig([STOCK]);
    const calls = withOfficial(r, { AAA: year() });
    await runPreOpen(r.ports as Ports, et(D, "08:00"));
    await runPreOpen(r.ports as Ports, et(D, "08:01"));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts).toEqual({ splitAdjusted: true });
    expect(r.store.market.get(`${D}|AAA`)?.w52).toMatchObject({ high: 120, low: 80 });
  });

  it("alerts only above the 52-week high or below the 52-week low, only with the switch on", async () => {
    const r = rig([STOCK, { symbol: "BBB", enabled: true, high: { mode: "dollar", value: 500 } }]);
    withOfficial(r, { AAA: year(), BBB: year() });
    await runPreOpen(r.ports as Ports, et(D, "08:00"));
    r.market.snaps.BBB = snap("BBB", 130, et(D, "10:00"));
    await go(r, et(D, "10:00"), 120); // equal to the old high: not a new high
    expect(r.store.events("FIRST_ALERT")).toHaveLength(0);
    r.market.snaps.BBB = snap("BBB", 130, et(D, "10:01"));
    await go(r, et(D, "10:01"), 120.01);
    const ev = r.store.events("FIRST_ALERT");
    expect(ev).toHaveLength(1); // BBB at 130 is above its 52-week high too, but its switch is off
    expect(ev[0]).toMatchObject({ rule: { symbol: "AAA", rule: "HIGH52", t0Value: 120.01 } });
    await go(r, et(D, "10:02"), 79.5);
    expect(r.store.events("FIRST_ALERT")[1]).toMatchObject({ rule: { rule: "LOW52" } });
  });

  it("a stock added during the day gets its range on the next poll", async () => {
    const r = rig([STOCK]);
    const calls = withOfficial(r, { AAA: year() });
    await go(r, et(D, "11:00"), 100);
    expect(calls).toHaveLength(1);
    await go(r, et(D, "11:01"), 121);
    expect(calls).toHaveLength(1);
    expect(r.store.events("FIRST_ALERT")[0]).toMatchObject({ rule: { rule: "HIGH52" } });
  });

  it("the gap scan finds a 52-week crossing in missed minutes", async () => {
    const r = rig([STOCK]);
    withOfficial(r, { AAA: year() });
    await go(r, et(D, "10:00"), 100);
    r.market.bars1.AAA = [{ t: et(D, "10:03"), o: 100, h: 125, l: 100, c: 101, v: 10 }];
    await go(r, et(D, "10:10"), 101);
    expect(r.store.events("LATE_ALERT")[0]).toMatchObject({ rule: { rule: "HIGH52" }, barTimeMs: et(D, "10:03") });
  });

  it("the end-of-day summary widens the range by today and marks a new high", () => {
    const states = new Map([["AAA", { symbol: "AAA", date: D, w52: buildYearRange(D, year()) }]]);
    const official = { AAA: [day(addDays(D, -1), 101, 99), day(D, 123, 101)] };
    const [s] = buildEodStocks({ date: D, stocks: [STOCK], official, states, rules: [], baselines: new Map(), sessions: 20 });
    expect(s).toMatchObject({ w52High: 123, w52Low: 80, newHigh52: true });
    expect(s!.newLow52).toBeUndefined();
  });
});
