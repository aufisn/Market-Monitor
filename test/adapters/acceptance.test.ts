/** Acceptance tests that need the adapters: AT-13, AT-17, AT-18, AT-19 (fakes only, no network). */
import { describe, expect, it } from "vitest";
import { D1Store } from "../../src/adapters/d1store";
import { GlanceNotifier } from "../../src/adapters/glance-notifier";
import { renderBriefingDetails, renderGlance, renderGlanceAll } from "../../src/adapters/render-glance";
import { TelegramApi } from "../../src/adapters/telegram";
import { runTick } from "../../src/core/engine";
import type { OutboundEvent, RuleState, StockConfig } from "../../src/core/ports";
import { EVENT_PRIORITY } from "../../src/core/ports";
import type { Env } from "../../src/worker/env";
import { drainOutbound } from "../../src/worker/outbox";
import { runScheduledJob } from "../../src/worker/scheduled";
import { DAY1, et, flatBaseline, rig, snap } from "../core/memory";
import { FakeD1, fakeFetch, jsonRes } from "./fake-d1";

const D = DAY1;
const at = (hhmm: string) => et(D, hhmm);

describe("AT-13 opening briefing within 90 s of the open, with every required field", () => {
  it("is queued by 09:31:30 and shows PC, Opening, yesterday's High and the 2x volume reference for every enabled stock", async () => {
    const stocks: StockConfig[] = ["AAA", "BBB", "CCC"].map((symbol) => ({
      symbol, enabled: true, high: { mode: "dollar", value: 110 }, low: { mode: "dollar", value: 90 }, volume: { mode: "multiple", value: 2 },
    }));
    const r = rig(stocks);
    for (const s of stocks) r.store.baselines.set(s.symbol, flatBaseline(s.symbol, 2000));
    const open = at("09:30");
    let briefingAt: number | undefined;
    for (let t = open + 15_000; t <= open + 90_000 && briefingAt === undefined; t += 15_000) {
      for (const s of stocks) r.market.snaps[s.symbol] = snap(s.symbol, 101, t, { open: 101, cum: 5000 });
      await runTick(r.ports, t);
      if (r.store.count("BRIEFING") > 0) briefingAt = r.store.queue.find((q) => q.event.type === "BRIEFING")!.tMs;
    }
    expect(briefingAt).toBeDefined();
    expect(briefingAt! - open).toBeLessThanOrEqual(90_000);
    const ev = r.store.events("BRIEFING")[0]!;
    expect(ev.stocks.map((s) => s.symbol).sort()).toEqual(["AAA", "BBB", "CCC"]);
    const ctx = { nowMs: briefingAt!, stocks, baselines: [...r.store.baselines.values()] };
    const collapsed = renderGlanceAll(ev, ctx).map((p) => p.text).join("\n");
    const expanded = renderBriefingDetails(ev, ctx).map((p) => p.text).join("\n");
    for (const s of stocks) {
      const block = (txt: string) => txt.split("\n\n").find((b) => b.includes(`<b>${s.symbol}</b>`))!;
      expect(block(collapsed)).toMatch(/Open\(IEX\) 101\.00/);
      expect(block(collapsed)).toMatch(/PC 100\.00 · yHigh 102\.00/); // Previous Close and yesterday's High
      expect(block(expanded)).toMatch(/Yesterday IEX volume 1\.00M/);
      expect(block(expanded)).toMatch(/IEX avg\/day .*2x = /); // the 2x average volume reference
      expect(block(expanded)).toMatch(/2x IEX by 10:00 .*11:00 /);
    }
  });
});

// ---------------------------------------------------------------- AT-17
class CountingD1 extends FakeD1 {
  n = 0;
  override prepare(sql: string): ReturnType<FakeD1["prepare"]> {
    const s = super.prepare(sql) as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const m of ["run", "all", "first"] as const) {
      const orig = s[m]!.bind(s);
      s[m] = (...a: unknown[]) => { this.n++; return orig(...a); };
    }
    return s as unknown as ReturnType<FakeD1["prepare"]>;
  }
  override async batch(stmts: never[]) {
    const before = this.n;
    const r = await super.batch(stmts);
    this.n = before + 1; // a batch is one round trip
    return r;
  }
}

async function at17(crossers: number, d1Limit: number) {
  {
    const d = new CountingD1();
    const symbols = Array.from({ length: 30 }, (_, i) => `S${i}`);
    const dateStr = "2026-11-25";
    for (const s of symbols) {
      await d.prepare("INSERT INTO stocks VALUES (?,1,?,0)").bind(s, JSON.stringify({ symbol: s, enabled: true, high: { mode: "dollar", value: 110 }, low: { mode: "dollar", value: 90 } })).run();
      await d.prepare("INSERT INTO market_state VALUES (?,?,?,0)").bind(dateStr, s, JSON.stringify({ symbol: s, date: dateStr, prev: { symbol: s, date: "2026-11-24", close: 100, high: 101, low: 99, volume: 1e6 } })).run();
    }
    let NOW = Date.parse("2026-11-25T15:00:00Z");
    const f = fakeFetch({
      "api.telegram.org": () => jsonRes({ ok: true, result: { message_id: 9 } }),
      "/v2/stocks/snapshots": () => {
        const iso = new Date(NOW - 1000).toISOString();
        const minute = new Date(Math.floor(NOW / 60_000) * 60_000).toISOString();
        const bar = { t: minute, o: 111, h: 111, l: 111, c: 111, v: 100 };
        return jsonRes(Object.fromEntries(symbols.map((s, i) => { const p = i < crossers ? 111 : 100; const b = { ...bar, o: p, h: p, l: p, c: p }; return [s, { latestTrade: { t: iso, p, s: 10 }, minuteBar: b, dailyBar: { ...b, t: "2026-11-25T05:00:00Z", o: 100, v: 5000 } }]; })));
      },
      "/v2/stocks/bars": () => jsonRes({ bars: {} }),
    });
    const env: Env = {
      DB: d.asD1(), ASSETS: { fetch: async () => new Response("a") } as unknown as Fetcher, ALPACA_KEY_ID: "k", ALPACA_SECRET_KEY: "s",
      TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "42", TELEGRAM_WEBHOOK_SECRET: "w".repeat(20), DASHBOARD_ACCESS_CODE: "c".repeat(40),
    };
    let worstFetch = 0;
    let worstD1 = 0;
    for (let i = 0; i < 12; i++) {
      f.calls.length = 0;
      d.n = 0;
      await runScheduledJob(env, { fetch: f, now: () => NOW, sleep: async () => {}, pollIntervalMs: 0 });
      worstFetch = Math.max(worstFetch, f.calls.length);
      worstD1 = Math.max(worstD1, d.n);
      expect(f.calls.length, `run ${i} outbound`).toBeLessThanOrEqual(45);
      expect(d.n, `run ${i} D1`).toBeLessThanOrEqual(d1Limit);
      NOW += 60_000;
    }
    expect(worstFetch).toBeGreaterThan(0);
    expect(d.rows("SELECT * FROM alert_ids")).toHaveLength(crossers); // every alert fired exactly once
    expect(d.rows("SELECT * FROM log WHERE kind='REMINDER'").length).toBeGreaterThan(0); // reminders ran inside the same loop
    return worstD1;
  }
}

describe("AT-17 calls per run stay within 45 for 30 stocks across a full tick loop", () => {
  it("8 of 30 stocks alert, then remind: outbound calls and D1 round trips each <= 45 in all 12 runs", async () => {
    await at17(8, 45);
  });
  it("worst case, all 30 cross in one poll: outbound <= 45; D1 round trips <= 45", async () => {
    await at17(30, 45);
  });
});

// ---------------------------------------------------------------- AT-18
describe("AT-18 Telegram rate limit and outage: queued, sent later in priority order, none lost", () => {
  it("429 then network outage keep everything queued; recovery sends alerts first, then reminders, briefing, READY", async () => {
    const d = new FakeD1();
    let NOW = Date.parse("2026-11-30T15:00:00Z");
    const store = new D1Store(d.asD1(), { now: () => NOW, cacheTtlMs: 0 });
    let mode: "limit" | "down" | "up" = "limit";
    const texts: string[] = [];
    const f = fakeFetch({
      "api.telegram.org": (_u, init) => {
        if (mode === "limit") return jsonRes({ ok: false, parameters: { retry_after: 120 } }, 429);
        if (mode === "down") throw new TypeError("network down");
        texts.push(String(JSON.parse(String(init?.body)).text));
        return jsonRes({ ok: true, result: { message_id: texts.length } });
      },
    });
    const api = new TelegramApi({ token: "T", chatId: "42", fetch: f, sleep: async () => {}, now: () => NOW, minSendGapMs: 0 });
    const notifier = new GlanceNotifier(api, { now: () => NOW });
    const rule = (symbol: string, n = 0): RuleState => ({ date: D, symbol, rule: "HIGH", state: "TRIGGERED", cycle: 1, remindersSent: n, version: 1, t0Ms: NOW - 600_000, thresholdAtT0: 100 });
    const events: OutboundEvent[] = [
      { type: "READY", date: D, info: { stocksActive: 2 } },
      { type: "REMINDER", rules: [rule("BBB", 1)], market: { symbol: "BBB", date: D }, backInside: false },
      { type: "BRIEFING", date: D, stocks: [{ symbol: "AAA", date: D, open: 101 }] },
      { type: "FIRST_ALERT", rule: rule("AAA"), market: { symbol: "AAA", date: D, last: { t: 1, p: 101, s: 1 } }, threshold: 100 },
      { type: "FIRST_ALERT", rule: rule("CCC"), market: { symbol: "CCC", date: D, last: { t: 1, p: 101, s: 1 } }, threshold: 100 },
    ];
    for (const e of events) await store.enqueue(e, EVENT_PRIORITY[e.type], NOW);

    const limited = await drainOutbound(store, notifier, D, NOW, 3);
    expect(limited).toMatchObject({ sent: 0, stoppedOn: "RATE_LIMIT" });
    mode = "down";
    expect(await drainOutbound(store, notifier, D, NOW, 3)).toMatchObject({ sent: 0, stoppedOn: "NETWORK" });
    expect(d.rows("SELECT * FROM outbound_queue WHERE sent_ms IS NULL")).toHaveLength(5); // nothing lost, nothing sent

    mode = "up";
    NOW += 60_000;
    for (let i = 0; i < 4; i++) await drainOutbound(store, notifier, D, NOW, 3);
    expect(d.rows("SELECT * FROM outbound_queue WHERE sent_ms IS NULL")).toHaveLength(0);
    expect(texts).toHaveLength(5);
    const kinds = texts.map((t) => (t.includes("NEW") ? "alert" : t.includes("REMINDER") ? "reminder" : t.includes("BRIEFING") ? "briefing" : "ready"));
    expect(kinds).toEqual(["alert", "alert", "reminder", "briefing", "ready"]);
  });
});

// ---------------------------------------------------------------- AT-19
describe("AT-19 a 2-minute provider outage: NO DATA, one notice, gap scan on recovery", () => {
  it("polls fail, one DATA PROBLEM notice, the last-poll time stays old, and the recovery run raises a LATE alert for the missed spike", async () => {
    const r = rig([{ symbol: "AAA", enabled: true, high: { mode: "dollar", value: 105 } }]);
    const go = async (t: number, price: number) => {
      r.market.snaps.AAA = snap("AAA", price, t);
      return runTick(r.ports, t);
    };
    expect((await go(at("10:00"), 100)).status).toBe("ok");
    r.market.failSnapshots = 99;
    const statuses: string[] = [];
    for (const t of ["10:00:30", "10:01:00", "10:01:30", "10:02:00"]) statuses.push((await go(at(t), 100)).status);
    expect(statuses).toEqual(["data_error", "data_error", "data_error", "data_error"]);
    // NO DATA: the last successful poll is still 10:00, so the dashboard shows the age and no fresh price
    expect(r.store.lastPoll).toBe(at("10:00"));
    expect(at("10:02:00") - r.store.lastPoll!).toBeGreaterThanOrEqual(120_000);
    const notices = r.store.events("OPS_NOTICE").filter((e) => e.code === "DATA_ERROR");
    expect(notices).toHaveLength(1);
    expect(renderGlance(notices[0]!, { nowMs: at("10:02:00") }).text).toContain("DATA PROBLEM");
    expect(r.store.count("FIRST_ALERT")).toBe(0);

    // recovery: the price spiked to 108 at 10:01 and is back at 100; the gap scan finds it
    r.market.failSnapshots = 0;
    r.market.bars1.AAA = [
      { t: at("10:00"), o: 100, h: 100, l: 99, c: 100, v: 10 },
      { t: at("10:01"), o: 100, h: 108, l: 100, c: 100, v: 10 },
    ];
    expect((await go(at("10:02:30"), 100)).status).toBe("ok");
    const late = r.store.events("LATE_ALERT");
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ barTimeMs: at("10:01"), barPrice: 108, threshold: 105 });
    expect(r.store.events("OPS_NOTICE").filter((e) => e.code === "DATA_ERROR")).toHaveLength(1); // still one notice
    expect(r.store.lastPoll).toBe(at("10:02:30"));
  });
});
