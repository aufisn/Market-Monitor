import { describe, expect, it } from "vitest";
import { runTick } from "../../src/core/engine";
import type { Ports } from "../../src/core/engine";
import { MIN } from "../../src/core/time";
import { addMinutePrice, averageSide, evaluateFast, haltStep, marketMove } from "../../src/core/signals";
import { buildYearRange } from "../../src/core/yearrange";
import { DAY1, et, rig, snap } from "./memory";
import type { Rig } from "./memory";

const D = DAY1;
const at = (hhmm: string) => et(D, hhmm);
const tick = (r: Rig, t: number) => runTick(r.ports as Ports, t);
const set = (r: Rig, sym: string, price: number, t: number, o: Parameters<typeof snap>[3] = {}) => (r.market.snaps[sym] = snap(sym, price, t, o));

describe("fast move", () => {
  it("minute prices keep one price per minute for 31 minutes", () => {
    let l: [number, number][] = [];
    for (let i = 0; i < 40; i++) l = addMinutePrice(l, at("10:00") + i * MIN + 5000, 100 + i);
    l = addMinutePrice(l, at("10:39:50"), 1);
    expect(l).toHaveLength(31);
    expect(l[l.length - 1]).toEqual([at("10:39"), 1]);
  });
  it("detects a fall from the window high or a rise from its low, and re-arms below half", () => {
    const p: [number, number][] = [[at("10:00"), 100], [at("10:05"), 101], [at("10:10"), 99]];
    expect(evaluateFast(p, at("10:12"), 97.9, 3, 15)).toMatchObject({ crossing: { value: 97.9 }, reference: 101 });
    expect(evaluateFast(p, at("10:12"), 102, 3, 15)).toMatchObject({ crossing: { value: 102 }, reference: 99 });
    expect(evaluateFast(p, at("10:12"), 100, 3, 15)).toMatchObject({ crossing: null, inside: true });
    expect(evaluateFast(p, at("10:30"), 97.9, 3, 15).crossing).toBeNull(); // 10:05 high is outside the window
    expect(evaluateFast([], at("10:12"), 50, 3, 15).crossing).toBeNull();
  });
  it("engine: alerts once with the window reference, quiet afterwards", async () => {
    const r = rig([{ symbol: "AAA", enabled: true, fast: { pct: 3, minutes: 15 } }]);
    for (let i = 0; i < 5; i++) { set(r, "AAA", 100, at("10:00") + i * MIN); await tick(r, at("10:00") + i * MIN); }
    set(r, "AAA", 96.8, at("10:05")); await tick(r, at("10:05"));
    const ev = r.store.events("FIRST_ALERT");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ rule: { rule: "FAST", t0Value: 96.8, thresholdAtT0: 100 } });
    set(r, "AAA", 96.5, at("10:06")); await tick(r, at("10:06"));
    expect(r.store.events("FIRST_ALERT")).toHaveLength(1);
  });
});

describe("50 / 200-day averages", () => {
  it("averages come from the official closes before today; the side follows the last close", () => {
    const bars = Array.from({ length: 220 }, (_, i) => ({ t: Date.parse("2026-01-02T05:00:00Z") + i * 86_400_000, o: 1, h: 2, l: 0.5, c: i < 170 ? 90 : 110, v: 1 }));
    const w = buildYearRange(D, bars);
    expect(w.ma50).toBe(110);
    expect(w.ma200).toBe((20 * 90 + 50 * 110 + 130 * 90) / 200);
    expect(w.lastClose).toBe(110);
    expect(averageSide(w, "MA200")).toEqual({ side: "LOW", level: w.ma200 });
    expect(averageSide({ ...w, lastClose: 80 }, "MA50")).toEqual({ side: "HIGH", level: 110 });
  });
  it("engine: alerts below the 200-day and above the 50-day, only with the switch on", async () => {
    const r = rig([{ symbol: "AAA", enabled: true, averages: true }, { symbol: "BBB", enabled: true, high: { mode: "dollar", value: 500 } }]);
    const w52 = { date: D, sessions: 250, high: 130, low: 70, ma50: 105, ma200: 95, lastClose: 100 };
    for (const s of ["AAA", "BBB"]) r.store.market.set(`${D}|${s}`, { ...r.store.market.get(`${D}|${s}`)!, w52 });
    set(r, "BBB", 90, at("10:00"));
    set(r, "AAA", 100, at("10:00")); await tick(r, at("10:00"));
    expect(r.store.events("FIRST_ALERT")).toHaveLength(0);
    set(r, "AAA", 94.9, at("10:01")); await tick(r, at("10:01"));
    set(r, "AAA", 105.2, at("10:02")); await tick(r, at("10:02"));
    expect(r.store.events("FIRST_ALERT").map((e) => e.rule.rule)).toEqual(["MA200", "MA50"]);
  });
});

describe("trading stopped", () => {
  const liquid = { cum: 200_000 };
  it("haltStep: needs a live feed, a liquid stock and 5 quiet minutes; resumes on a newer trade", () => {
    const ms = { symbol: "AAA", date: D, last: { t: at("10:00"), p: 100, s: 1 }, cumVolume: 200_000 };
    const open = at("09:30"), close = at("16:00");
    expect(haltStep(ms, at("10:04:59"), open, close, true)).toBeNull();
    expect(haltStep(ms, at("10:05"), open, close, false)).toBeNull();
    expect(haltStep({ ...ms, cumVolume: 1000 }, at("10:05"), open, close, true)).toBeNull();
    expect(haltStep(ms, at("10:05"), open, close, true)).toEqual({ kind: "HALT", lastTradeMs: at("10:00"), lastPrice: 100 });
    expect(haltStep({ ...ms, haltLastTradeMs: at("10:00") }, at("10:09"), open, close, true)).toBeNull();
    expect(haltStep({ ...ms, haltLastTradeMs: at("09:58") }, at("10:09"), open, close, true)).toEqual({ kind: "RESUMED", price: 100, tMs: at("10:00") });
  });
  it("engine: one HALT notice, then RESUMED when it trades again; SPY rides along in the same call", async () => {
    const r = rig([{ symbol: "AAA", enabled: true, halt: true, high: { mode: "dollar", value: 500 } }]);
    set(r, "AAA", 100, at("10:00"), liquid); set(r, "SPY", 600, at("10:00")); await tick(r, at("10:00"));
    for (const t of ["10:06", "10:07"]) { set(r, "SPY", 600, at(t)); await tick(r, at(t)); } // AAA snapshot still shows the 10:00 trade
    expect(r.store.events("HALT")).toEqual([{ type: "HALT", symbol: "AAA", lastTradeMs: at("10:00"), lastPrice: 100, minutes: 6 }]);
    set(r, "AAA", 99, at("10:08"), liquid); set(r, "SPY", 600, at("10:08")); await tick(r, at("10:08"));
    expect(r.store.events("RESUMED")).toEqual([{ type: "RESUMED", symbol: "AAA", price: 99, tMs: at("10:08") }]);
    expect(r.market.calls.snapshots).toBe(4);
  });
  it("no notice when the whole feed is silent (data problem, not a halt)", async () => {
    const r = rig([{ symbol: "AAA", enabled: true, halt: true, high: { mode: "dollar", value: 500 } }]);
    set(r, "AAA", 100, at("10:00"), liquid); set(r, "SPY", 600, at("10:00")); await tick(r, at("10:00"));
    await tick(r, at("10:07"));
    expect(r.store.events("HALT")).toHaveLength(0);
  });
});

describe("market note (SPY)", () => {
  it("is attached to an alert only when SPY moved at least 1%", async () => {
    expect(marketMove({ symbol: "SPY", date: D, last: { t: 1, p: 395, s: 1 }, prev: { symbol: "SPY", date: D, close: 400, high: 0, low: 0, volume: 0 } })).toBeCloseTo(-1.25);
    expect(marketMove({ symbol: "SPY", date: D, last: { t: 1, p: 398, s: 1 }, prev: { symbol: "SPY", date: D, close: 400, high: 0, low: 0, volume: 0 } })).toBeUndefined();
    const r = rig();
    r.store.seedPrev(D, "SPY", 400);
    set(r, "SPY", 392, at("10:00"));
    set(r, "AAA", 111, at("10:00")); await tick(r, at("10:00"));
    expect(r.store.events("FIRST_ALERT")[0]!.market.marketMovePct).toBeCloseTo(-2);
    expect(r.store.market.get(`${D}|AAA`)?.marketMovePct).toBeUndefined(); // only on the event copy
  });
});
