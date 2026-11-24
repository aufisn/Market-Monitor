import { describe, expect, it } from "vitest";
import { AlpacaError, AlpacaMarketData } from "../../src/adapters/alpaca";
import { fakeFetch, jsonRes } from "./fake-d1";

const NOW = Date.parse("2026-11-24T15:00:30Z");
const mk = (f: typeof fetch, extra = {}) => new AlpacaMarketData({ keyId: "KID", secretKey: "SEC", fetch: f, now: () => NOW, sleep: async () => {}, ...extra });
const bar = (t: string, c = 10, v = 100) => ({ t, o: c, h: c + 1, l: c - 1, c, v, n: 3, vw: c });

describe("alpaca snapshots", () => {
  it("maps trade, minute bar and daily bar, sends iex feed and key headers", async () => {
    const f = fakeFetch({
      "/v2/stocks/snapshots": () => jsonRes({
        AAPL: {
          latestTrade: { t: "2026-11-24T15:00:29.123456789Z", p: 101.5, s: 20, c: ["@", "F"] },
          minuteBar: bar("2026-11-24T15:00:00Z", 101),
          dailyBar: bar("2026-11-24T05:00:00Z", 100, 5000),
          prevDailyBar: bar("2026-11-23T05:00:00Z"),
        },
      }),
    });
    const r = await mk(f).snapshots(["AAPL", "ZZZZ"]);
    expect(r.AAPL?.latestTrade).toEqual({ t: Date.parse("2026-11-24T15:00:29.123Z"), p: 101.5, s: 20, conditions: ["@", "F"] });
    expect(r.AAPL?.minuteBar?.c).toBe(101);
    expect(r.AAPL?.dailyBar).toMatchObject({ o: 100, v: 5000 });
    expect(r.ZZZZ).toBeUndefined();
    const call = f.calls[0]!;
    expect(call.url).toContain("feed=iex");
    expect((call.init?.headers as Record<string, string>)["APCA-API-KEY-ID"]).toBe("KID");
    expect(call.url).not.toContain("SEC");
  });

  it("drops a yesterday dailyBar and carries minuteBar over as prevMinuteBar", async () => {
    let n = 0;
    const f = fakeFetch({
      "/v2/stocks/snapshots": () => jsonRes({ AAPL: { minuteBar: bar(n++ === 0 ? "2026-11-24T15:00:00Z" : "2026-11-24T15:01:00Z", n), dailyBar: bar("2026-11-23T05:00:00Z") } }),
    });
    const a = mk(f);
    const r1 = await a.snapshots(["AAPL"]);
    expect(r1.AAPL?.dailyBar).toBeUndefined();
    expect(r1.AAPL?.prevMinuteBar).toBeUndefined();
    const r2 = await a.snapshots(["AAPL"]);
    expect(r2.AAPL?.prevMinuteBar?.t).toBe(Date.parse("2026-11-24T15:00:00Z"));
    expect(r2.AAPL?.minuteBar?.t).toBe(Date.parse("2026-11-24T15:01:00Z"));
  });
});

describe("alpaca bars", () => {
  it("follows next_page_token and merges symbols", async () => {
    const pages = [
      jsonRes({ bars: { A: [bar("2026-11-24T14:30:00Z")] }, next_page_token: "tok1" }),
      jsonRes({ bars: { A: [bar("2026-11-24T14:31:00Z")], B: [bar("2026-11-24T14:30:00Z")] }, next_page_token: null }),
    ];
    const f = fakeFetch({ "/v2/stocks/bars": () => pages.shift()! });
    const r = await mk(f).minuteBarsMulti(["A", "B"], Date.parse("2026-11-24T14:30:00Z"), Date.parse("2026-11-24T14:35:00Z"));
    expect(r.A).toHaveLength(2);
    expect(r.B).toHaveLength(1);
    expect(f.calls[1]!.url).toContain("page_token=tok1");
    expect(f.calls[0]!.url).toContain("feed=iex");
  });

  it("previousDaily uses sip for a past day and reads the date", async () => {
    const f = fakeFetch({ "/v2/stocks/bars": () => jsonRes({ bars: { A: [bar("2026-11-23T05:00:00Z", 50, 1234)] } }) });
    const d = await mk(f).previousDaily("A", "2026-11-24");
    expect(d).toEqual({ symbol: "A", date: "2026-11-23", close: 50, high: 51, low: 49, volume: 1234 });
    expect(f.calls[0]!.url).toContain("feed=sip");
  });
});

describe("alpaca errors (FR-3.9)", () => {
  it("retries once on 500 then succeeds", async () => {
    const f = fakeFetch({ "/v2/stocks/snapshots": [() => new Response("x", { status: 503 }), () => jsonRes({ A: { latestTrade: { t: "2026-11-24T15:00:00Z", p: 1, s: 1 } } })] });
    const r = await mk(f).snapshots(["A"]);
    expect(r.A?.latestTrade?.p).toBe(1);
    expect(f.calls).toHaveLength(2);
  });
  it("retries once on 429 with Retry-After, then types the error", async () => {
    const f = fakeFetch({ "/v2/stocks/snapshots": () => new Response("{}", { status: 429, headers: { "retry-after": "1" } }) });
    const err = await mk(f).snapshots(["A"]).catch((e) => e);
    expect(err).toBeInstanceOf(AlpacaError);
    expect(err.kind).toBe("RATE_LIMIT");
    expect(f.calls).toHaveLength(2);
  });
  it("does not retry 401/403 and never leaks the key", async () => {
    const f = fakeFetch({ "/v2/stocks/snapshots": () => new Response("{}", { status: 401 }) });
    const err = await mk(f).snapshots(["A"]).catch((e) => e);
    expect(err.kind).toBe("AUTH");
    expect(f.calls).toHaveLength(1);
    expect(String(err.message)).not.toMatch(/SEC|KID/);
  });
  it("types timeouts after one retry", async () => {
    const f = (async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }) as unknown as typeof fetch;
    const err = await mk(f).snapshots(["A"]).catch((e) => e);
    expect(err.kind).toBe("TIMEOUT");
  });
});
