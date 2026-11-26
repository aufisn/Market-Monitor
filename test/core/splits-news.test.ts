import { describe, expect, it } from "vitest";
import { runPreOpen, runTick } from "../../src/core/engine";
import type { Ports } from "../../src/core/engine";
import { NEWS_GAP_MS, foldNews } from "../../src/core/news";
import type { NewsHeadline, SplitInfo, StockConfig, YearRange } from "../../src/core/ports";
import { adjustPrev, applySplit, convertLevels, fixRangeForSplit, scaleBarsForSplits, splitRatioText, upcomingSplit } from "../../src/core/splits";
import { MIN, nyLocalToUtc } from "../../src/core/time";
import { DAY1, FakeMarket, et, rig, snap } from "./memory";

const D = DAY1; // Mon 30 Nov 2026
const FWD: SplitInfo = { exDate: "2026-12-07", oldRate: 1, newRate: 4 };
const TODAY: SplitInfo = { exDate: D, oldRate: 1, newRate: 4 };
const REV: SplitInfo = { exDate: "2026-12-07", oldRate: 10, newRate: 1 };

class SplitNewsMarket extends FakeMarket {
  splitList: Record<string, SplitInfo[]> = {};
  headlines: NewsHeadline[] = [];
  splitCalls = 0;
  newsCalls: { symbols: string[]; sinceMs: number }[] = [];
  async splits(symbols: string[]) {
    this.splitCalls++;
    return Object.fromEntries(symbols.filter((s) => this.splitList[s]).map((s) => [s, this.splitList[s]!]));
  }
  async news(symbols: string[], sinceMs: number) {
    this.newsCalls.push({ symbols, sinceMs });
    return this.headlines.filter((h) => h.tMs > sinceMs);
  }
}
function rigX(stocks?: StockConfig[]) {
  const r = rig(stocks);
  const market = new SplitNewsMarket();
  return { store: r.store, market, ports: { store: r.store, market } as unknown as Ports };
}

describe("split maths", () => {
  it("4-for-1 divides prices and multiplies shares; 1-for-10 does the reverse", () => {
    expect(splitRatioText(FWD)).toBe("4-for-1");
    expect(splitRatioText(REV)).toBe("1-for-10");
    expect(convertLevels({ low: 130, high: 160, volume: 100_000 }, FWD)).toEqual({ low: 32.5, high: 40, volume: 400_000 });
    expect(convertLevels({ low: 1.5, high: 2 }, REV)).toEqual({ low: 15, high: 20 });
  });
  it("only dollar levels and share counts change; % and x usual stay", () => {
    const s: StockConfig = { symbol: "AAA", enabled: true, low: { mode: "percent", value: -5 }, high: { mode: "dollar", value: 160 }, volume: { mode: "multiple", value: 2 }, splitPlan: FWD };
    const r = applySplit(s, FWD);
    expect(r.stock).toEqual({ symbol: "AAA", enabled: true, low: { mode: "percent", value: -5 }, high: { mode: "dollar", value: 40 }, volume: { mode: "multiple", value: 2 } });
    expect(r.from).toEqual({ high: 160 });
    expect(r.to).toEqual({ high: 40 });
  });
  it("bad provider ratios convert nothing", () => {
    const s: StockConfig = { symbol: "AAA", enabled: true, high: { mode: "dollar", value: 160 }, volume: { mode: "absolute", value: 5e11 } };
    for (const bad of [{ ...FWD, newRate: 1e12 }, { ...FWD, oldRate: 1e9 }, { ...FWD, newRate: Number.NaN }]) expect(applySplit(s, bad).to).toEqual({ high: 160, volume: 5e11 });
    expect(applySplit(s, { ...FWD, newRate: 10 }).to).toEqual({ high: 160, volume: 5e11 }); // volume would pass 1e12
  });
  it("upcomingSplit picks the nearest split on or after today", () => {
    expect(upcomingSplit([{ ...FWD, exDate: "2026-11-01" }, FWD, { ...FWD, exDate: "2027-01-04" }], D)).toEqual(FWD);
    expect(upcomingSplit([{ ...FWD, exDate: "2026-11-01" }], D)).toBeUndefined();
  });
  it("Previous Close is converted once on the split day", () => {
    const prev = { symbol: "AAA", date: "2026-11-27", close: 100, high: 104, low: 96, volume: 1_000 };
    const a = adjustPrev(prev, [TODAY], D)!;
    expect(a).toMatchObject({ close: 25, high: 26, low: 24, volume: 4_000, splitFactor: 4, rawClose: 100 });
    expect(adjustPrev(a, [TODAY], D)).toBe(a); // idempotent
    expect(adjustPrev(prev, [FWD], D)).toBe(prev); // not yet
    expect(adjustPrev({ ...prev, date: D }, [TODAY], "2026-12-01")).toEqual({ ...prev, date: D }); // the day after: prev is already post-split
  });
  it("the 52-week range is converted only while it is still in pre-split prices", () => {
    const prev = adjustPrev({ symbol: "AAA", date: "2026-11-27", close: 100, high: 100, low: 100, volume: 1 }, [TODAY], D);
    const raw: YearRange = { date: D, sessions: 250, high: 160, low: 80, ma50: 100, ma200: 90, lastClose: 100 };
    expect(fixRangeForSplit(raw, prev, [TODAY], D)).toMatchObject({ high: 40, low: 20, ma50: 25, ma200: 22.5, lastClose: 25 });
    const done: YearRange = { ...raw, high: 40, low: 20, ma50: 25, ma200: 22.5, lastClose: 25 };
    expect(fixRangeForSplit(done, prev, [TODAY], D)).toBe(done);
  });
  it("intraday bars before a split are put in today's share count", () => {
    const before = { t: nyLocalToUtc("2026-11-27", 10), o: 100, h: 100, l: 100, c: 100, v: 1000 };
    const after = { t: nyLocalToUtc(D, 10), o: 25, h: 25, l: 25, c: 25, v: 4000 };
    const out = scaleBarsForSplits([before, after], [TODAY], D);
    expect(out[0]).toMatchObject({ c: 25, v: 4000 });
    expect(out[1]).toBe(after);
    expect(scaleBarsForSplits([before], [FWD], D)[0]).toBe(before); // future split: nothing yet
  });
});

describe("split warning before the open", () => {
  const t = (hhmm: string) => et(D, hhmm);
  it("one call a day, one warning per split, with the current dollar levels", async () => {
    const r = rigX();
    r.market.splitList = { AAA: [FWD] };
    await runPreOpen(r.ports, t("07:10"));
    await runPreOpen(r.ports, t("07:11"));
    expect(r.market.splitCalls).toBe(1);
    const ev = r.store.events("SPLIT");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ symbol: "AAA", split: FWD, levels: { low: 90, high: 110 } });
    const ms = (await r.store.getMarketStates(D)).find((m) => m.symbol === "AAA");
    expect(ms?.splits).toEqual([FWD]);
    // The next day the split is still listed, but the warning is never repeated.
    const r2 = r;
    r2.store.seedPrev("2026-12-01", "AAA", 100);
    await runPreOpen(r2.ports, et("2026-12-01", "07:10"));
    expect(r2.store.count("SPLIT")).toBe(1);
  });
  it("no warning when the user already chose to adjust; the levels convert on the split day", async () => {
    const r = rigX([{ symbol: "AAA", enabled: true, high: { mode: "dollar", value: 110 }, low: { mode: "dollar", value: 90 }, volume: { mode: "absolute", value: 50_000 }, splitPlan: TODAY }]);
    r.market.splitList = { AAA: [TODAY] };
    await runPreOpen(r.ports, t("07:10"));
    expect(r.store.count("SPLIT")).toBe(0);
    const s = (await r.store.listStocks())[0]!;
    expect(s).toMatchObject({ high: { mode: "dollar", value: 27.5 }, low: { mode: "dollar", value: 22.5 }, volume: { mode: "absolute", value: 200_000 } });
    expect(s.splitPlan).toBeUndefined();
    expect(r.store.events("SPLIT_APPLIED")[0]).toMatchObject({ from: { low: 90, high: 110, volume: 50_000 }, to: { low: 22.5, high: 27.5, volume: 200_000 } });
    expect((await r.store.getMarketStates(D))[0]!.prev).toMatchObject({ close: 25, splitFactor: 4 });
    // A later run neither converts again nor sends a warning for today's split.
    await runPreOpen(r.ports, t("07:11"));
    expect(r.store.count("SPLIT")).toBe(0);
    expect(r.store.count("SPLIT_APPLIED")).toBe(1);
    expect((await r.store.listStocks())[0]!.high).toEqual({ mode: "dollar", value: 27.5 });
  });
  it("a plan already converted by an Adjust now tap is not converted again", async () => {
    const r = rigX([{ symbol: "AAA", enabled: true, high: { mode: "dollar", value: 27.5 }, splitPlan: TODAY }]);
    r.market.splitList = { AAA: [TODAY] };
    await r.store.bumpCounters("meta", { [`splitdone:AAA:${D}`]: 1 });
    await runPreOpen(r.ports, t("07:10"));
    const s = (await r.store.listStocks())[0]!;
    expect(s.high).toEqual({ mode: "dollar", value: 27.5 });
    expect(s.splitPlan).toBeUndefined();
    expect(r.store.count("SPLIT_APPLIED")).toBe(0);
    expect(r.store.count("SPLIT")).toBe(0);
  });
  it("a plan whose split is no longer listed is dropped without any change", async () => {
    const r = rigX([{ symbol: "AAA", enabled: true, high: { mode: "dollar", value: 110 }, splitPlan: TODAY }]);
    r.market.splitList = {};
    await runPreOpen(r.ports, t("07:10"));
    const s = (await r.store.listStocks())[0]!;
    expect(s.high).toEqual({ mode: "dollar", value: 110 });
    expect(s.splitPlan).toBeUndefined();
    expect(r.store.logs.some((l) => l.detail.what === "split_plan_dropped")).toBe(true);
  });
  it("a failed split request is retried on the next run", async () => {
    const r = rigX();
    let fail = true;
    r.market.splits = async () => { r.market.splitCalls++; if (fail) { fail = false; throw new Error("down"); } return { AAA: [FWD] }; };
    await runPreOpen(r.ports, t("07:10"));
    expect(r.store.count("SPLIT")).toBe(0);
    await runPreOpen(r.ports, t("07:11"));
    expect(r.market.splitCalls).toBe(2);
    expect(r.store.count("SPLIT")).toBe(1);
  });
});

describe("news headlines", () => {
  const h = (id: number, tMs: number, sym = "AAA"): NewsHeadline => ({ id, tMs, headline: `Headline ${id}`, source: "benzinga", symbols: [sym], url: `https://example.com/${id}` });
  it("folds: first headline goes at once, later ones wait for the 15-minute gap and come together", () => {
    const t0 = et(D, "10:00");
    let r = foldNews(undefined, "AAA", [h(1, t0 - MIN)], t0, t0 - 15 * MIN);
    expect(r.send?.items.map((x) => x.id)).toEqual([1]);
    r = foldNews(r.state, "AAA", [h(2, t0 + 2 * MIN), h(1, t0 - MIN)], t0 + 3 * MIN, 0);
    expect(r.send).toBeUndefined();
    expect(r.state.pending?.map((x) => x.id)).toEqual([2]);
    r = foldNews(r.state, "AAA", [h(3, t0 + 5 * MIN), h(4, t0 + 6 * MIN), h(5, t0 + 7 * MIN), h(9, t0 + 7 * MIN, "BBB")], t0 + 8 * MIN, 0);
    expect(r.state.pending?.map((x) => x.id)).toEqual([5, 4, 3]);
    expect(r.state.more).toBe(1);
    r = foldNews(r.state, "AAA", undefined, t0 + NEWS_GAP_MS, 0);
    expect(r.send).toEqual({ items: expect.any(Array), more: 1 });
    expect(r.send!.items.map((x) => x.id)).toEqual([5, 4, 3]);
    expect(r.state.pending).toBeUndefined();
  });
  it("engine: one call for the list on every second run, a silent NEWS event, muted stocks get none", async () => {
    const r = rigX([
      { symbol: "AAA", enabled: true, high: { mode: "dollar", value: 110 }, news: true },
      { symbol: "BBB", enabled: true, high: { mode: "dollar", value: 110 }, news: true, mutedUntilMs: et(D, "12:00") },
      { symbol: "CCC", enabled: true, high: { mode: "dollar", value: 110 } },
    ]);
    const t0 = et(D, "10:00");
    for (const s of ["AAA", "BBB", "CCC"]) r.market.snaps[s] = snap(s, 100, t0);
    r.market.headlines = [h(1, t0 - 5 * MIN), h(2, t0 - 4 * MIN, "BBB")];
    await runTick(r.ports, t0);
    expect(r.market.newsCalls).toHaveLength(1);
    expect(r.market.newsCalls[0]!.symbols).toEqual(["AAA"]);
    expect(r.market.newsCalls[0]!.sinceMs).toBe(t0 - 15 * MIN);
    expect(r.store.events("NEWS")).toEqual([expect.objectContaining({ symbol: "AAA", more: 0 })]);
    for (const s of ["AAA", "BBB", "CCC"]) r.market.snaps[s] = snap(s, 100, t0 + MIN);
    await runTick(r.ports, t0 + MIN); // odd minute: no call
    expect(r.market.newsCalls).toHaveLength(1);
    r.market.headlines.push(h(3, t0 + MIN));
    for (const s of ["AAA", "BBB", "CCC"]) r.market.snaps[s] = snap(s, 100, t0 + 2 * MIN);
    await runTick(r.ports, t0 + 2 * MIN);
    expect(r.market.newsCalls[1]!.sinceMs).toBe(t0 - 5 * MIN); // from the newest headline seen
    expect(r.store.count("NEWS")).toBe(1); // waits for the 15-minute gap
    for (const s of ["AAA", "BBB", "CCC"]) r.market.snaps[s] = snap(s, 100, t0 + 15 * MIN);
    await runTick(r.ports, t0 + 15 * MIN);
    expect(r.store.events("NEWS")[1]!.items.map((x) => x.id)).toEqual([3]);
  });
  it("at most five news messages per run; the rest go on the next run", async () => {
    const syms = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"];
    const r = rigX(syms.map((symbol) => ({ symbol, enabled: true, high: { mode: "dollar", value: 110 }, news: true })));
    const t0 = et(D, "10:00");
    for (const s of syms) r.market.snaps[s] = snap(s, 100, t0);
    r.market.headlines = [{ id: 1, tMs: t0 - MIN, headline: "Sector news", source: "x", symbols: syms }];
    await runTick(r.ports, t0);
    expect(r.store.count("NEWS")).toBe(5);
    for (const s of syms) r.market.snaps[s] = snap(s, 100, t0 + MIN);
    await runTick(r.ports, t0 + MIN);
    expect(r.store.count("NEWS")).toBe(8);
    expect(new Set(r.store.events("NEWS").map((e) => e.symbol)).size).toBe(8);
  });
  it("a failing news request never stops alerts", async () => {
    const r = rigX([{ symbol: "AAA", enabled: true, high: { mode: "dollar", value: 110 }, news: true }]);
    r.market.news = async () => { throw new Error("down"); };
    const t0 = et(D, "10:00");
    r.market.snaps.AAA = snap("AAA", 111, t0);
    const s = await runTick(r.ports, t0);
    expect(s.status).toBe("ok");
    expect(r.store.count("FIRST_ALERT")).toBe(1);
  });
});
