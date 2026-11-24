import { describe, expect, it } from "vitest";
import { baselineProgress, buildBaseline, isPlausible, pickNextBaseline } from "../../src/core/baseline";
import { scanGap, gapWindow } from "../../src/core/gapscan";
import { DEFAULT_SETTINGS } from "../../src/core/ports";
import type { Bar, Snapshot } from "../../src/core/ports";
import { avgCumAt, evaluatePrice, evaluateVolume, isNear, priceInsideBuffer, resolveThreshold } from "../../src/core/rules";
import { addDays, nyLocalToUtc } from "../../src/core/time";
import { flatBaseline, snap } from "./memory";

const base = { sessionOpenMs: 0, spikeHoldPct: 10 };
const T = 1_800_000_000_000;

describe("thresholds (I-1)", () => {
  it("dollar and percent of Previous Close", () => {
    expect(resolveThreshold({ mode: "dollar", value: 250 }, 100)).toBe(250);
    expect(resolveThreshold({ mode: "percent", value: 5 }, 100)).toBe(105);
    expect(resolveThreshold({ mode: "percent", value: -3.5 }, 200)).toBe(193);
    expect(resolveThreshold({ mode: "percent", value: 5 }, undefined)).toBeUndefined();
    expect(resolveThreshold(undefined, 100)).toBeUndefined();
  });
});

describe("price evidence (FR-3.3, FR-3.4)", () => {
  it("trade at or beyond the threshold crosses; inside does not", () => {
    expect(evaluatePrice("HIGH", 110, snap("A", 110, T), base).crossing).toEqual({ value: 110, touchedAtMs: undefined });
    expect(evaluatePrice("HIGH", 110, snap("A", 109.99, T), base).crossing).toBeNull();
    expect(evaluatePrice("LOW", 90, snap("A", 90, T), base).crossing?.value).toBe(90);
  });
  it("bar high/low crossing records the bar minute (I-10)", () => {
    const s = snap("A", 105, T, { prevHi: 111 });
    expect(evaluatePrice("HIGH", 110, s, base).crossing).toEqual({ value: 111, touchedAtMs: s.prevMinuteBar!.t });
    const s2 = snap("A", 105, T, { lo: 89 });
    expect(evaluatePrice("LOW", 90, s2, base).crossing?.touchedAtMs).toBe(s2.minuteBar!.t);
  });
  it("extended-hours / out-of-sequence trades are ignored", () => {
    expect(evaluatePrice("HIGH", 110, snap("A", 120, T, { conditions: ["T"], hi: 100, prevHi: 100 }), base).crossing).toBeNull();
    expect(evaluatePrice("HIGH", 110, snap("A", 120, T, { conditions: ["@", "Z"], hi: 100, prevHi: 100 }), base).crossing).toBeNull();
  });
  it("bars before the session open are ignored", () => {
    const s = snap("A", 105, T, { prevHi: 111 });
    expect(evaluatePrice("HIGH", 110, s, { ...base, sessionOpenMs: T }).crossing).toBeNull();
  });
  it("a spike >10% from the median of 5 closes is held, then confirmed by the next poll", () => {
    const closes = [100, 100, 101, 100, 99];
    const first = evaluatePrice("HIGH", 105, snap("A", 125, T), { ...base, recentCloses: closes });
    expect(first.crossing).toBeNull();
    expect(first.held).toBe(125);
    const second = evaluatePrice("HIGH", 105, snap("A", 124, T), { ...base, recentCloses: closes, heldPrice: 125 });
    expect(second.crossing?.value).toBe(124);
    const gone = evaluatePrice("HIGH", 105, snap("A", 106, T), { ...base, recentCloses: closes, heldPrice: 125 });
    expect(gone.crossing?.value).toBe(106); // a normal crossing is not held
    const dropped = evaluatePrice("HIGH", 105, snap("A", 100, T), { ...base, recentCloses: closes, heldPrice: 125 });
    expect(dropped).toMatchObject({ crossing: null, held: null });
  });
  it("re-arm buffer", () => {
    expect(priceInsideBuffer("HIGH", 109.7, 110, 0.2)).toBe(true);
    expect(priceInsideBuffer("HIGH", 109.9, 110, 0.2)).toBe(false);
    expect(priceInsideBuffer("LOW", 90.2, 90, 0.2)).toBe(true);
    expect(priceInsideBuffer("LOW", undefined, 90, 0.2)).toBe(false);
  });
});

describe("volume (FR-3.2, FR-6.4)", () => {
  const b = flatBaseline("A", 2000);
  const set = DEFAULT_SETTINGS;
  it("interpolates AvgCum inside a bucket", () => {
    expect(avgCumAt(b, 0)).toBe(0);
    expect(avgCumAt(b, 2.5)).toBe(5000);
    expect(avgCumAt(b, 5)).toBe(10_000);
    expect(avgCumAt(b, 7)).toBe(14_000);
    expect(avgCumAt(b, 9999)).toBe(b.avgFullDay);
  });
  it("crosses at multiple x AvgCum(t)", () => {
    expect(evaluateVolume(23_000, { mode: "multiple", value: 2 }, b, 6, set)).toMatchObject({ status: "BELOW", threshold: 24_000 });
    expect(evaluateVolume(24_000, { mode: "multiple", value: 2 }, b, 6, set).status).toBe("CROSSED");
    expect(evaluateVolume(50_000, { mode: "absolute", value: 50_000 }, null, 6, set).status).toBe("CROSSED");
  });
  it("guards: first N minutes, min AvgCum, min sessions, NO_BASELINE never alerts", () => {
    expect(evaluateVolume(999_999, { mode: "multiple", value: 2 }, b, 4, set).status).toBe("GUARD");
    expect(evaluateVolume(999_999, { mode: "multiple", value: 2 }, b, 6, { ...set, volumeMinAvgCum: 20_000 }).status).toBe("GUARD");
    expect(evaluateVolume(999_999, { mode: "multiple", value: 2 }, flatBaseline("A", 2000, "x", 9), 30, set).status).toBe("NO_BASELINE");
    expect(evaluateVolume(999_999, { mode: "multiple", value: 2 }, null, 30, set).status).toBe("NO_BASELINE");
    expect(evaluateVolume(999_999, { mode: "multiple", value: 2 }, { ...b, status: "NO_BASELINE" }, 30, set).status).toBe("NO_BASELINE");
    expect(evaluateVolume(1, { mode: "multiple", value: 2 }, b, 30, { ...set, volumeNoAlertFirstMin: 0, volumeMinAvgCum: 0, volumeMinSessions: 0 }).status).toBe("BELOW");
  });
});

describe("NEAR (FR-8.3)", () => {
  it("within 20% of the distance to a threshold", () => {
    expect(isNear(108.5, 100, 90, 110, 20)).toBe(true); // 1.5 from 110, span 10 -> 15%
    expect(isNear(105, 100, 90, 110, 20)).toBe(false);
    expect(isNear(91, 100, 90, 110, 20)).toBe(true);
    expect(isNear(111, 100, 90, 110, 20)).toBe(false); // crossed, not near
  });
});

describe("baseline build", () => {
  const sessions = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09"];
  const dayBars = (date: string, perBucket: number): Bar[] =>
    Array.from({ length: 78 }, (_, i) => ({ t: nyLocalToUtc(date, 9, 30) + i * 5 * 60_000, o: 1, h: 1, l: 1, c: 1, v: perBucket }));
  it("averages cumulative volume, skips early-close days, holidays and outliers", () => {
    const bars = [
      ...sessions.flatMap((d) => dayBars(d, 1000)),
      ...dayBars("2026-11-27", 1), // early close day: excluded
      ...dayBars("2026-11-26", 1), // holiday: excluded
      ...dayBars("2026-11-12", 100_000), // outlier
      ...dayBars("2026-11-13", 1000),
    ];
    const b = buildBaseline("A", "2026-11-30", bars, 20);
    expect(b.sessions).toBe(7);
    expect(b.status).toBe("OK");
    expect(b.avgCum[0]).toBe(1000);
    expect(b.avgCum[77]).toBe(78_000);
    expect(b.avgFullDay).toBe(78_000);
    expect(isPlausible(b)).toBe(true);
  });
  it("uses only the most recent N sessions and never today's bars", () => {
    const bars = [...sessions.flatMap((d) => dayBars(d, 1000)), ...dayBars("2026-11-30", 50_000)];
    expect(buildBaseline("A", "2026-11-30", bars, 3).sessions).toBe(3);
    expect(buildBaseline("A", "2026-11-30", bars, 20).avgFullDay).toBe(78_000);
  });
  it("no data or broken data -> NO_BASELINE", () => {
    expect(buildBaseline("A", "2026-11-30", [], 20).status).toBe("NO_BASELINE");
    expect(isPlausible({ ...flatBaseline("A", 1), avgCum: [5, 4, ...flatBaseline("A", 1).avgCum.slice(2)] })).toBe(false);
  });
  it("planner picks one stock: missing before stale, volume stocks first", () => {
    const stocks = [
      { symbol: "C", enabled: true }, { symbol: "B", enabled: true, volume: { mode: "multiple" as const, value: 2 } },
      { symbol: "A", enabled: true }, { symbol: "D", enabled: false },
    ];
    const today = "2026-11-30";
    expect(pickNextBaseline(stocks, [], today)).toBe("B");
    const have = [flatBaseline("B", 1, today)];
    expect(pickNextBaseline(stocks, have, today)).toBe("A");
    expect(pickNextBaseline(stocks, [...have, flatBaseline("A", 1, today), flatBaseline("C", 1, "2026-11-27")], today)).toBe("C"); // stale
    expect(pickNextBaseline(stocks, [...have, flatBaseline("A", 1, today), flatBaseline("C", 1, today)], today)).toBeNull();
    expect(baselineProgress(stocks, have, today)).toEqual({ done: 1, total: 3 });
    expect(addDays(today, 1)).toBe("2026-12-01");
  });
});

describe("gap scan unit (FR-9)", () => {
  const open = nyLocalToUtc("2026-11-30", 9, 30);
  const close = nyLocalToUtc("2026-11-30", 16);
  it("window only after >2 min, clipped to the session", () => {
    expect(gapWindow(open + 10 * 60_000, open + 12 * 60_000, open, close)).toBeNull();
    expect(gapWindow(open + 10 * 60_000, open + 16 * 60_000 + 20_000, open, close)).toEqual({ startMs: open + 10 * 60_000, endMs: open + 16 * 60_000 });
    expect(gapWindow(open - 3_600_000, open + 5 * 60_000, open, close)).toEqual({ startMs: open, endMs: open + 5 * 60_000 }); // clipped
    expect(gapWindow(null, open + 10_000, open, close)).toBeNull();
  });
  it("skips rules that are not ARMED; takes the first crossing bar", () => {
    const bar = (i: number, h: number): Bar => ({ t: open + i * 60_000, o: 100, h, l: 99, c: 100, v: 1 });
    const bars = { A: [bar(0, 100), bar(1, 111), bar(2, 112)] };
    const hit = scanGap([{ symbol: "A", rule: "HIGH", threshold: 110 }], bars, 10);
    expect(hit).toEqual([{ symbol: "A", rule: "HIGH", threshold: 110, barTimeMs: open + 60_000, price: 111 }]);
    const acked = { symbol: "A", date: "d", rule: "HIGH" as const, state: "ACKNOWLEDGED" as const, cycle: 1, remindersSent: 0, version: 3 };
    expect(scanGap([{ symbol: "A", rule: "HIGH", threshold: 110, state: acked }], bars, 10)).toEqual([]);
  });
  it("a one-bar spike is dropped, a confirmed one is kept", () => {
    const bar = (i: number, h: number): Bar => ({ t: open + i * 60_000, o: 100, h, l: 99, c: 100, v: 1 });
    const calm = [0, 1, 2, 3, 4].map((i) => bar(i, 100));
    const spike = { A: [...calm, bar(5, 130), bar(6, 100)] };
    expect(scanGap([{ symbol: "A", rule: "HIGH", threshold: 110 }], spike, 10)).toEqual([]);
    const real = { A: [...calm, bar(5, 130), bar(6, 128)] };
    expect(scanGap([{ symbol: "A", rule: "HIGH", threshold: 110 }], real, 10)[0]?.barTimeMs).toBe(open + 5 * 60_000);
  });
});

void (undefined as unknown as Snapshot);
