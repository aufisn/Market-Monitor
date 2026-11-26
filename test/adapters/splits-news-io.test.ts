/** Split warning and news headlines at the edges: Alpaca parsing, Telegram texts and buttons, API and button flows. */
import { beforeEach, describe, expect, it } from "vitest";
import { AlpacaMarketData } from "../../src/adapters/alpaca";
import { decodeCallback, encodeSplit } from "../../src/adapters/callbacks";
import { cleanLinkUrl, glanceWidth } from "../../src/adapters/glance-fmt";
import { renderGlance, renderSplitChoice } from "../../src/adapters/render-glance";
import type { OutboundEvent } from "../../src/core/ports";
import type { Env } from "../../src/worker/env";
import { handleFetch } from "../../src/worker/index";
import { et } from "../core/memory";
import { FakeD1, fakeFetch, jsonRes } from "./fake-d1";

const D = "2026-11-30";
const lines = (t: string) => t.split("\n");

describe("alpaca: splits and news", () => {
  const mk = (f: typeof fetch) => new AlpacaMarketData({ keyId: "KID", secretKey: "SEC", fetch: f, now: () => 0, sleep: async () => {} });
  it("splits: one call, forward and reverse, only the watchlist and valid rates", async () => {
    const f = fakeFetch({
      "/v1/corporate-actions": () => jsonRes({ corporate_actions: {
        forward_splits: [{ symbol: "NVDA", old_rate: 1, new_rate: 4, ex_date: "2026-12-07", process_date: "2026-12-07" }, { symbol: "OTHER", old_rate: 1, new_rate: 2, ex_date: "2026-12-07" }, { symbol: "NVDA", old_rate: 0, new_rate: 2, ex_date: "2026-12-08" }],
        reverse_splits: [{ symbol: "XYZ", old_rate: 10, new_rate: 1, ex_date: "2026-12-10" }],
      } }),
    });
    const r = await mk(f).splits(["NVDA", "XYZ"], "2026-10-21", "2027-02-28");
    expect(r).toEqual({ NVDA: [{ exDate: "2026-12-07", oldRate: 1, newRate: 4 }], XYZ: [{ exDate: "2026-12-10", oldRate: 10, newRate: 1 }] });
    expect(f.calls).toHaveLength(1);
    const u = new URL(f.calls[0]!.url);
    expect(u.searchParams.get("types")).toBe("forward_split,reverse_split");
    expect(u.searchParams.get("symbols")).toBe("NVDA,XYZ");
    expect(f.calls[0]!.url).not.toContain("SEC");
  });
  it("news: plain text, https links only, content not requested", async () => {
    const f = fakeFetch({
      "/v1beta1/news": () => jsonRes({ news: [
        { id: 7, created_at: "2026-11-30T15:39:00Z", headline: "  Recall\nover <b>software</b>  ", source: "benzinga", url: "https://example.com/a?x=1&y=2", symbols: ["TSLA"] },
        { id: 8, created_at: "2026-11-30T15:40:00Z", headline: "Bad link", source: "x", url: "javascript:alert(1)", symbols: ["TSLA"] },
        { id: "bad", created_at: "nope", headline: "dropped" },
      ] }),
    });
    const r = await mk(f).news(["TSLA"], Date.parse("2026-11-30T15:00:00Z"), 99);
    expect(r).toEqual([
      { id: 7, tMs: Date.parse("2026-11-30T15:39:00Z"), headline: "Recall over <b>software</b>", source: "benzinga", symbols: ["TSLA"], url: "https://example.com/a?x=1&y=2" },
      { id: 8, tMs: Date.parse("2026-11-30T15:40:00Z"), headline: "Bad link", source: "x", symbols: ["TSLA"] },
    ]);
    const u = new URL(f.calls[0]!.url);
    expect(u.searchParams.get("limit")).toBe("50");
    expect(u.searchParams.get("include_content")).toBe("false");
  });
  it("cleanLinkUrl refuses anything that is not a plain https link", () => {
    for (const bad of ["http://a.com", "javascript:x", "https://a.com/\"onmouseover=x", "https://u@a.com/", "https://a.com/<x>", "https://a .com", 5]) expect(cleanLinkUrl(bad)).toBeUndefined();
    expect(cleanLinkUrl("https://a.com/x?y=1#z")).toBe("https://a.com/x?y=1#z");
  });
});

describe("telegram: split warning and news", () => {
  const split = { exDate: "2026-12-07", oldRate: 1, newRate: 4 };
  it("split warning: at most four lines of 38, two buttons that fit Telegram's 64 bytes", () => {
    const r = renderGlance({ type: "SPLIT", symbol: "NVDA", split, levels: { low: 130, high: 160 } }, { nowMs: et(D, "07:10") });
    expect(r.text).toBe("✂️ <b>NVDA splits 4-for-1</b> on Mon 7 Dec\nYour LOW 130.00, HIGH 160.00 will be\nwrong after it.");
    for (const l of lines(r.text)) expect(glanceWidth(l)).toBeLessThanOrEqual(38);
    expect(r.silent).toBeFalsy();
    expect(r.buttons?.[0]?.map((b) => b.text)).toEqual(["✅ Adjust on 7 Dec", "Leave as is"]);
    for (const b of r.buttons![0]!) expect(new TextEncoder().encode(b.data!).length).toBeLessThanOrEqual(64);
    expect(decodeCallback(r.buttons![0]![0]!.data)).toEqual({ type: "split", symbol: "NVDA", exDate: "2026-12-07", adjust: true });
    expect(decodeCallback(encodeSplit("BRK.B", "2026-12-07", false))).toEqual({ type: "split", symbol: "BRK.B", exDate: "2026-12-07", adjust: false });
    expect(decodeCallback("s|NVDA|2026-12-07|1")).toBeNull();
    expect(decodeCallback("s|NVDA|20261207|2")).toBeNull();
  });
  it("split on the day itself offers Adjust now; % levels get no buttons; a reverse split says so", () => {
    expect(renderGlance({ type: "SPLIT", symbol: "NVDA", split: { ...split, exDate: D }, levels: { high: 160 } }, { nowMs: et(D, "07:10") }).buttons?.[0]?.[0]?.text).toBe("✅ Adjust now");
    const pct = renderGlance({ type: "SPLIT", symbol: "NVDA", split, levels: {} }, { nowMs: et(D, "07:10") });
    expect(pct.buttons).toBeUndefined();
    expect(pct.text).toContain("no change needed");
    const rev = renderGlance({ type: "SPLIT", symbol: "ABCDE", split: { exDate: "2026-12-07", oldRate: 10, newRate: 1 }, levels: { low: 1.5 } }, { nowMs: et(D, "07:10") });
    for (const l of lines(rev.text)) expect(glanceWidth(l)).toBeLessThanOrEqual(38);
    expect(rev.text).toContain("ABCDE reverse split 1-for-10");
    expect(renderSplitChoice("NVDA", split, "planned").text).toContain("on Mon 7 Dec.");
  });
  it("levels adjusted: silent, old -> new", () => {
    const r = renderGlance({ type: "SPLIT_APPLIED", symbol: "NVDA", split, from: { low: 130, high: 160, volume: 100_000 }, to: { low: 32.5, high: 40, volume: 400_000 } }, { nowMs: 0 });
    expect(r.silent).toBe(true);
    expect(lines(r.text)).toEqual(["✂️ <b>NVDA levels adjusted</b> · 4-for-1", "LOW 130.00 → 32.50", "HIGH 160.00 → 40.00", "Volume 0.10M → 0.40M"]);
  });
  it("news: silent, headline escaped and linked, long headlines cut to two lines", () => {
    const ev: OutboundEvent = { type: "NEWS", symbol: "TSLA", more: 2, items: [
      { id: 2, tMs: et(D, "10:39"), headline: "Company <recalls> vehicles & more over a software issue found in the latest update of its cars", source: "benzinga", url: "https://example.com/a?x=1&y=2" },
      { id: 1, tMs: et(D, "10:31"), headline: "Plain one", source: "reuters", url: "javascript:alert(1)" },
    ] };
    const r = renderGlance(ev, { nowMs: et(D, "10:40") });
    expect(r.silent).toBe(true);
    const L = lines(r.text);
    expect(L[0]).toBe("📰 <b>TSLA</b> · 10:39 ET");
    expect(L[1]).toBe('<a href="https://example.com/a?x=1&amp;y=2">Company &lt;recalls&gt; vehicles &amp; more over');
    expect(L[2]!.endsWith("…</a>")).toBe(true);
    expect(r.text).not.toContain("javascript");
    expect(r.text).toContain("Plain one\n<i>reuters · 10:31 ET</i>");
    expect(L.at(-1)).toBe("+2 more headlines");
  });
});

// ------------------------------------------------------------ worker flows
const CODE = "c".repeat(40);
const SECRET = "whsecret_abcdefghijklmnop";
let d: FakeD1;
let f: ReturnType<typeof fakeFetch>;
const NOW = Date.parse("2026-11-25T15:00:00Z"); // Wed 25 Nov, market open
const env = (): Env => ({
  DB: d.asD1(), ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
  ALPACA_KEY_ID: "k", ALPACA_SECRET_KEY: "s", TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHAT_ID: "42",
  TELEGRAM_WEBHOOK_SECRET: SECRET, DASHBOARD_ACCESS_CODE: CODE,
});
const call = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => handleFetch(new Request(`https://x.example${path}`, init), env(), { fetch: f, now: () => NOW, sleep: async () => {} });
const api = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  call(path, { method, headers: { authorization: `Bearer ${CODE}`, "cf-connecting-ip": "1.1.1.1", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const hook = (body: unknown) => call("/tg/webhook", { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, body: JSON.stringify(body) });
const stock = async () => ((await (await api("/api/stocks")).json()) as { stocks: Record<string, unknown>[] }).stocks[0]!;
const seedSplit = (exDate: string) =>
  d.prepare("INSERT INTO market_state (date, symbol, json, updated_ms) VALUES (?, ?, ?, ?) ON CONFLICT(date, symbol) DO UPDATE SET json = excluded.json")
    .bind("2026-11-25", "AAPL", JSON.stringify({ symbol: "AAPL", date: "2026-11-25", last: { t: NOW, p: 180, s: 1 }, splits: [{ exDate, oldRate: 1, newRate: 4 }] }), NOW).run();

describe("split choice: API and Telegram button", () => {
  beforeEach(async () => {
    d = new FakeD1();
    f = fakeFetch({
      "api.telegram.org": () => jsonRes({ ok: true, result: { message_id: 5 } }),
      "/v2/stocks/snapshots": () => jsonRes({ AAPL: { latestTrade: { t: "2026-11-25T14:59:00Z", p: 180, s: 1 } } }),
    });
    expect((await api("/api/stocks", { symbol: "AAPL", high: { mode: "dollar", value: 200 }, low: { mode: "dollar", value: 150 } })).status).toBe(201);
  });
  it("Adjust before the split day stores the plan; Leave as is removes it; export never carries it", async () => {
    await seedSplit("2026-12-07");
    const r = await api("/api/split", { symbol: "AAPL", exDate: "2026-12-07", adjust: true });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ choice: "planned" });
    expect((await stock()).splitPlan).toEqual({ exDate: "2026-12-07", oldRate: 1, newRate: 4 });
    expect((await stock()).high).toEqual({ mode: "dollar", value: 200 }); // nothing changes before the day
    const ex = await (await api("/api/export")).text();
    expect(ex).not.toContain("splitPlan");
    expect(await (await api("/api/split", { symbol: "AAPL", exDate: "2026-12-07", adjust: false })).json()).toMatchObject({ choice: "left" });
    expect((await stock()).splitPlan).toBeUndefined();
  });
  it("on the split day Adjust converts at once, only once", async () => {
    await seedSplit("2026-11-25");
    const r = await api("/api/split", { symbol: "AAPL", exDate: "2026-11-25", adjust: true });
    expect(await r.json()).toMatchObject({ choice: "applied", to: { low: 37.5, high: 50 } });
    expect(await stock()).toMatchObject({ high: { mode: "dollar", value: 50 }, low: { mode: "dollar", value: 37.5 } });
    const again = await api("/api/split", { symbol: "AAPL", exDate: "2026-11-25", adjust: true });
    expect(again.status).toBe(409);
    expect((await stock()).high).toEqual({ mode: "dollar", value: 50 });
  });
  it("unknown split, bad input and a split day in the past are refused without change", async () => {
    await seedSplit("2026-12-07");
    expect((await api("/api/split", { symbol: "AAPL", exDate: "2026-12-08", adjust: true })).status).toBe(409);
    expect((await api("/api/split", { symbol: "AAPL", exDate: "2026-12-07", adjust: "yes" })).status).toBe(400);
    expect((await api("/api/split", { symbol: "AAPL", exDate: "7 Dec", adjust: true })).status).toBe(400);
    expect((await api("/api/split", { symbol: "MSFT", exDate: "2026-12-07", adjust: true })).status).toBe(404);
    await seedSplit("2026-11-20");
    expect((await api("/api/split", { symbol: "AAPL", exDate: "2026-11-20", adjust: true })).status).toBe(409);
    expect(await stock()).toMatchObject({ high: { mode: "dollar", value: 200 } });
  });
  it("the Telegram button stores the plan and edits the warning", async () => {
    await seedSplit("2026-12-07");
    await hook({ update_id: 9, callback_query: { id: "cb", data: encodeSplit("AAPL", "2026-12-07", true), from: { id: 42 }, message: { message_id: 77, chat: { id: 42 } } } });
    expect((await stock()).splitPlan).toMatchObject({ exDate: "2026-12-07" });
    const edit = f.calls.find((c) => c.url.includes("editMessageText"));
    expect(String(edit?.init?.body)).toContain("Levels adjust before the open");
  });
  it("news is a switch, information only: alone it is not an alert", async () => {
    expect((await api("/api/stocks", { symbol: "MSFT", news: true })).status).toBe(422);
    expect((await api("/api/stocks", { symbol: "MSFT", news: "yes", high: { mode: "dollar", value: 1 } })).status).toBe(400);
    expect((await api("/api/stocks/AAPL", { news: true }, "PUT")).status).toBe(200);
    expect((await stock()).news).toBe(true);
    expect((await api("/api/stocks/AAPL", { splitPlan: { exDate: "2026-12-07", oldRate: 1, newRate: 4 } }, "PUT")).status).toBe(400); // never through the form
  });
});
