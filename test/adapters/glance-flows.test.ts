/** Worker flows for the Glance Line: callbacks, commands, Ack + move, /why, global pause, auth hardening, new API fields. */
import { beforeEach, describe, expect, it } from "vitest";
import { clientKeySource, GLOBAL_MAX } from "../../src/worker/auth";
import type { Env } from "../../src/worker/env";
import { handleFetch } from "../../src/worker/index";
import { parseCommand, parseMoveInput } from "../../src/worker/intents";
import { widest } from "../../src/adapters/glance-fmt";
import { FakeD1, fakeFetch, jsonRes } from "./fake-d1";

const CODE = "c".repeat(40);
const SECRET = "whsecret_abcdefghijklmnop";
const DATE = "2026-11-25";
let d: FakeD1;
let tg: { method: string; body: Record<string, any> }[];
let f: ReturnType<typeof fakeFetch>;
let NOW = Date.parse("2026-11-25T15:00:00Z"); // Wed 10:00 EST
let dashUrl = "";

const env = (): Env => ({
  DB: d.asD1(), ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
  ALPACA_KEY_ID: "k", ALPACA_SECRET_KEY: "s", TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHAT_ID: "42",
  TELEGRAM_WEBHOOK_SECRET: SECRET, DASHBOARD_ACCESS_CODE: CODE, DASHBOARD_URL: dashUrl,
});
const deps = () => ({ fetch: f, now: () => NOW, sleep: async () => {} });
const call = (path: string, init: RequestInit = {}) => handleFetch(new Request(`https://x.example${path}`, init), env(), deps());
let uid = 100;
const hook = (body: Record<string, unknown>) =>
  call("/tg/webhook", { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, body: JSON.stringify({ update_id: ++uid, ...body }) });
const say = (text: string, reply?: number) => hook({ message: { chat: { id: 42 }, text, ...(reply ? { reply_to_message: { message_id: reply } } : {}) } });
const press = (data: string, messageId = 77) => hook({ callback_query: { id: "cb" + uid, data, from: { id: 42 }, message: { message_id: messageId, chat: { id: 42 } } } });
const api = (path: string, ip = "1.1.1.1", code = CODE) => call(path, { headers: { authorization: `Bearer ${code}`, "cf-connecting-ip": ip } });
const sent = (m: string) => tg.filter((c) => c.method === m);
const lastSend = () => sent("sendMessage").at(-1)!.body;

const stock = (o: Record<string, unknown>) => d.prepare("INSERT OR REPLACE INTO stocks VALUES (?,?,?,0)").bind(o.symbol as string, o.enabled === false ? 0 : 1, JSON.stringify({ enabled: true, ...o })).run();
const market = (symbol: string, o: Record<string, unknown>) => d.prepare("INSERT OR REPLACE INTO market_state VALUES (?,?,?,0)").bind(DATE, symbol, JSON.stringify({ symbol, date: DATE, ...o })).run();
const rule = (symbol: string, r: string, o: Record<string, unknown> = {}) =>
  d.prepare("INSERT OR REPLACE INTO rule_state VALUES (?,?,?,1,?,0)").bind(DATE, symbol, r, JSON.stringify({ date: DATE, symbol, rule: r, state: "TRIGGERED", cycle: 1, remindersSent: 0, lastMessageId: 77, version: 1, t0Ms: NOW - 1_800_000, ...o })).run();
const stockRow = (symbol: string) => JSON.parse(String(d.rows(`SELECT json FROM stocks WHERE symbol='${symbol}'`)[0]!.json));
const ruleRow = (symbol: string, r: string) => JSON.parse(String(d.rows(`SELECT json FROM rule_state WHERE symbol='${symbol}' AND rule='${r}'`)[0]!.json));
const prevClose = { symbol: "X", date: "2026-11-24", close: 138.2, high: 139, low: 136, volume: 6e6 };

beforeEach(() => {
  d = new FakeD1();
  tg = [];
  uid = 100;
  dashUrl = "";
  NOW = Date.parse("2026-11-25T15:00:00Z");
  f = fakeFetch({
    "api.telegram.org": (u, init) => {
      tg.push({ method: u.split("/").pop()!, body: JSON.parse(String(init?.body)) });
      return jsonRes({ ok: true, result: { message_id: 5 } });
    },
    "/v2/stocks/snapshots": (u) => jsonRes(Object.fromEntries((new URL(u).searchParams.get("symbols") ?? "").split(",").map((s) => [s, { latestTrade: { t: "2026-11-25T14:59:00Z", p: 100, s: 1 } }]))),
  });
});

describe("Ack + move (FR-4.7)", () => {
  beforeEach(async () => {
    await stock({ symbol: "NVDA", high: { mode: "dollar", value: 145 }, low: { mode: "dollar", value: 130 } });
    await market("NVDA", { last: { t: 1, p: 145.6, s: 1 }, prev: prevClose });
    await rule("NVDA", "HIGH");
  });

  it("+1% moves HIGH to 146.45, logs it, acknowledges and re-arms", async () => {
    await press("t|NVDA|HIGH|1|1");
    expect(stockRow("NVDA").high).toEqual({ mode: "dollar", value: 146.45 });
    expect(ruleRow("NVDA", "HIGH").state).toBe("ARMED"); // acknowledged, then re-armed by the core
    expect(d.rows("SELECT * FROM log WHERE kind='SETTINGS_CHANGE'")).toHaveLength(1);
    expect(d.rows("SELECT * FROM config_log WHERE key='NVDA'").length).toBeGreaterThan(0);
    const edits = sent("editMessageText").map((c) => String(c.body.text));
    expect(edits.some((t) => t.includes("HIGH moved 145.00 → 146.45 (+1%)"))).toBe(true);
    expect(sent("answerCallbackQuery")[0]!.body.text).toContain("146.45");
  });

  it("LOW moves down by 2% of its own value", async () => {
    await stock({ symbol: "AMZN", high: { mode: "dollar", value: 215 }, low: { mode: "dollar", value: 200 } });
    await market("AMZN", { last: { t: 1, p: 199.85, s: 1 }, prev: { ...prevClose, close: 207.5 } });
    await rule("AMZN", "LOW");
    await press("t|AMZN|LOW|2|1");
    expect(stockRow("AMZN").low.value).toBe(196);
  });

  it("refuses a move that would alert again at once and changes nothing", async () => {
    await market("NVDA", { last: { t: 1, p: 147, s: 1 }, prev: prevClose });
    await press("t|NVDA|HIGH|1|1");
    expect(stockRow("NVDA").high.value).toBe(145);
    expect(ruleRow("NVDA", "HIGH").state).toBe("TRIGGERED");
    expect(String(sent("answerCallbackQuery")[0]!.body.text)).toContain("alert at once");
  });

  it("already acknowledged: no move", async () => {
    await rule("NVDA", "HIGH", { state: "ACKNOWLEDGED" });
    await press("t|NVDA|HIGH|1|1");
    expect(stockRow("NVDA").high.value).toBe(145);
  });

  it("chooser swaps the keyboard, Cancel restores it", async () => {
    await press("x|NVDA|HIGH|1");
    const kb = JSON.stringify(sent("editMessageReplyMarkup")[0]!.body.reply_markup);
    expect(kb).toContain("+1% → 146.45");
    expect(kb).toContain("t|NVDA|HIGH|2|1");
    await press("c|NVDA|HIGH");
    expect(JSON.stringify(sent("editMessageReplyMarkup")[1]!.body.reply_markup)).toContain("Acknowledge");
  });

  it("typed value: ForceReply prompt, then a price and a percent", async () => {
    await press("y|NVDA|HIGH|1");
    expect(sent("sendMessage")[0]!.body.reply_markup.force_reply).toBe(true);
    await say("abc", 5);
    expect(String(lastSend().text)).toContain("Not understood");
    await say("144", 5); // below last
    expect(stockRow("NVDA").high.value).toBe(145);
    await say("148", 5);
    expect(stockRow("NVDA").high.value).toBe(148);
    expect(ruleRow("NVDA", "HIGH").state).toBe("ARMED");
  });

  it("typed percent is further out than the threshold", async () => {
    await press("y|NVDA|HIGH|1");
    await say("+3%", 5);
    expect(stockRow("NVDA").high.value).toBe(149.35);
  });

  it("input parser", () => {
    expect(parseMoveInput("148.5")).toEqual({ price: 148.5 });
    expect(parseMoveInput("+3%")).toEqual({ pct: 3 });
    expect(parseMoveInput("-3%")).toBeNull();
    expect(parseMoveInput("0")).toBeNull();
  });
});

describe("Details, mute, dashboard button", () => {
  it("Details is a silent reply with the grouped card", async () => {
    await stock({ symbol: "NVDA", high: { mode: "dollar", value: 145 }, low: { mode: "dollar", value: 130 } });
    await market("NVDA", { last: { t: 1, p: 144.8, s: 1 }, prev: prevClose, open: 141.05, cumVolume: 2_400_000 });
    await rule("NVDA", "HIGH", { thresholdAtT0: 145, t0Value: 145.6 });
    await press("d|NVDA|HIGH");
    const b = lastSend();
    expect(b.disable_notification).toBe(true);
    expect(b.reply_parameters.message_id).toBe(77);
    expect(b.text).toContain("<b>Price</b>");
    expect(b.text).toContain("HIGH 145.00 · LOW 130.00");
  });

  it("Mute 1h and the unknown-button answer", async () => {
    await stock({ symbol: "NVDA", high: { mode: "dollar", value: 145 } });
    await press("m|NVDA|60");
    expect(stockRow("NVDA").mutedUntilMs).toBe(NOW + 3_600_000);
    await press("zzz");
    expect(sent("answerCallbackQuery").at(-1)!.body.text).toBe("Not understood");
  });

  it("DASHBOARD_URL becomes a URL button; empty or http hides it", async () => {
    dashUrl = "https://mm.example.workers.dev";
    await api("/api/test", "1.1.1.1").catch(() => undefined);
    await call("/api/test", { method: "POST", headers: { authorization: `Bearer ${CODE}` } });
    expect(JSON.stringify(sent("sendMessage")[0]!.body.reply_markup)).toContain('"url":"https://mm.example.workers.dev"');
    tg = [];
    dashUrl = "http://insecure.example";
    await call("/api/test", { method: "POST", headers: { authorization: `Bearer ${CODE}` } });
    expect(JSON.stringify(sent("sendMessage")[0]!.body.reply_markup)).not.toContain("url");
  });

  it("Mark all seen edits the message", async () => {
    await press("E");
    expect(String(sent("editMessageText")[0]!.body.text)).toContain("Marked as seen");
  });
});

describe("commands", () => {
  beforeEach(async () => {
    await stock({ symbol: "NVDA", high: { mode: "dollar", value: 145 }, low: { mode: "dollar", value: 130 }, notes: "<script>alert(1)</script>" });
    await market("NVDA", { last: { t: 1, p: 145.6, s: 1 }, prev: prevClose, open: 141.05, cumVolume: 1_000_000 });
  });

  it("/ticker, /watchlist, /today, /help, /status are within 38 and escaped", async () => {
    for (const c of ["/ticker NVDA", "/watchlist", "/today", "/help", "/status", "/ticker ZZZ"]) {
      tg = [];
      await say(c);
      const t = String(lastSend().text);
      expect(widest(t), c).toBeLessThanOrEqual(38);
      expect(t.replace(/<\/?(b|i)>/g, ""), c).not.toMatch(/<|>/);
    }
    await say("/ticker NVDA");
    expect(String(lastSend().text)).toContain("&lt;script&gt;");
  });

  it("/set shows the A reply and the already-crossed confirmation with Save / Cancel", async () => {
    await say("/set NVDA high 148");
    expect(String(lastSend().text)).toBe("✅ <b>NVDA HIGH</b> set to 148.00\n+7.1% from Prev Close 138.20\nWas 145.00 · last 145.60\nRe-armed now.");
    await say("/set NVDA high 145");
    const b = lastSend();
    expect(String(b.text)).toContain("This will alert immediately. Save?");
    expect(JSON.stringify(b.reply_markup)).toContain("Save and alert");
    expect(stockRow("NVDA").high.value).toBe(148); // not saved yet
    await press("v|NVDA|high");
    expect(stockRow("NVDA").high.value).toBe(145);
    expect(String(sent("editMessageText").at(-1)!.body.text)).toContain("saved: 145.00");
    await say("/set NVDA high 144");
    await press("z|NVDA|high");
    expect(stockRow("NVDA").high.value).toBe(145);
  });

  it("global /pause and /resume with no symbol (keeps stocks that were already paused)", async () => {
    await stock({ symbol: "AAPL", high: { mode: "dollar", value: 300 } });
    await stock({ symbol: "MSFT", high: { mode: "dollar", value: 500 }, paused: true });
    await say("/pause");
    expect(["NVDA", "AAPL", "MSFT"].map((s) => stockRow(s).paused)).toEqual([true, true, true]);
    expect(String(lastSend().text)).toContain("ALL ALERTS PAUSED");
    await say("/resume");
    expect(["NVDA", "AAPL", "MSFT"].map((s) => !!stockRow(s).paused)).toEqual([false, false, true]);
    await say("/pause AAPL");
    expect(stockRow("AAPL").paused).toBe(true);
  });

  it("parses the new commands", () => {
    expect(parseCommand("/why nvda 14:03")).toEqual({ type: "why", symbol: "NVDA", hour: 14, minute: 3 });
    expect(parseCommand("/why NVDA 25:00")?.type).toBe("invalid");
    expect(parseCommand("/ticker aapl")).toEqual({ type: "ticker", symbol: "AAPL" });
    expect(parseCommand("/watchlist")?.type).toBe("watchlist");
    expect(parseCommand("/today")?.type).toBe("today");
  });
});

describe("/why and GET /api/why (FR-11.3)", () => {
  const at = (hhmm: string) => Date.parse(`${DATE}T${String(Number(hhmm.slice(0, 2)) + 5).padStart(2, "0")}:${hhmm.slice(3)}:00Z`);
  beforeEach(async () => {
    NOW = at("11:00");
    await stock({ symbol: "NVDA", high: { mode: "dollar", value: 145 }, low: { mode: "dollar", value: 130 } });
    await market("NVDA", { last: { t: 1, p: 144.8, s: 1 }, prev: prevClose });
    const log = (t: number, kind: string, rule: string, detail: unknown) => d.prepare("INSERT INTO log (t_ms, kind, symbol, rule, detail) VALUES (?,?,?,?,?)").bind(t, kind, "NVDA", rule, JSON.stringify(detail)).run();
    await log(at("09:50"), "FIRST_ALERT", "HIGH", { value: 145.6, threshold: 145, cycle: 1 });
    await log(at("10:20"), "REMINDER", "HIGH", { n: 3 });
    const cfg = (t: number, prev: unknown, next: unknown) => d.prepare("INSERT INTO config_log (t_ms, kind, key, prev, next) VALUES (?,?,?,?,?)").bind(t, "stock", "NVDA", JSON.stringify(prev), JSON.stringify(next)).run();
    await cfg(at("09:35"), null, { symbol: "NVDA", enabled: true, high: { mode: "dollar", value: 150 } });
    await cfg(at("09:55"), { symbol: "NVDA", enabled: true, high: { mode: "dollar", value: 150 } }, { symbol: "NVDA", enabled: true, high: { mode: "dollar", value: 145 } });
  });

  it("explains an alert that was sent", async () => {
    await say("/why NVDA 09:50");
    const t = String(lastSend().text);
    expect(t.replace(/\n/g, " ")).toContain("Alert HIGH sent at 09:50 ET: price 145.60 against limit 145.00.");
    expect(t).toContain("HIGH state: alert open.");
    expect(widest(t)).toBeLessThanOrEqual(38);
  });

  it("explains why nothing was sent and which limit was in force then", async () => {
    await say("/why NVDA 09:40");
    const t = String(lastSend().text);
    expect(t).toContain("No alert or reminder was logged");
    expect(t).toContain("Limits then: HIGH 150.00");
    expect(t).toContain("Limits were edited at");
    await say("/why NVDA 23:00");
    expect(String(lastSend().text)).toContain("has not happened yet");
  });

  it("API returns the same facts as JSON, with a date option", async () => {
    const r = await api("/api/why?symbol=NVDA&t=09:50");
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.price).toEqual({ value: 145.6, kind: "alert", tMs: at("09:50") });
    expect(j.limits).toEqual({ high: 150, low: null, volume: null }); // the 09:55 edit to 145 had not happened yet
    expect(j.states[0]).toEqual({ rule: "HIGH", state: "alert_open" });
    expect(j.sent[0].kind).toBe("FIRST_ALERT");
    expect(Array.isArray(j.lines)).toBe(true);
    expect((await api("/api/why?symbol=NVDA&t=25:00")).status).toBe(400);
    expect((await api("/api/why?symbol=NVDA&t=09:50&date=garbage")).status).toBe(400);
    expect((await api("/api/why?symbol=NVDA&t=23:30")).status).toBe(422);
    expect((await api(`/api/why?symbol=NVDA&t=09:50&date=${DATE}`)).status).toBe(200);
  });
});

describe("POST /api/pause-all and pausedAll", () => {
  it("pauses and resumes everything, reported in /api/state", async () => {
    await stock({ symbol: "NVDA", high: { mode: "dollar", value: 145 } });
    await stock({ symbol: "MSFT", high: { mode: "dollar", value: 500 }, paused: true });
    const post = (b: unknown) => call("/api/pause-all", { method: "POST", headers: { authorization: `Bearer ${CODE}`, "content-type": "application/json" }, body: JSON.stringify(b) });
    expect(((await (await api("/api/state")).json()) as any).pausedAll).toBe(false);
    expect(((await (await post({ paused: true })).json()) as any)).toMatchObject({ ok: true, changed: 1 });
    expect(((await (await api("/api/state")).json()) as any).pausedAll).toBe(true);
    await post({ paused: false });
    expect(["NVDA", "MSFT"].map((s) => !!stockRow(s).paused)).toEqual([false, true]);
    expect((await post({ paused: "yes" })).status).toBe(400);
  });
});

describe("GET /api/state additions", () => {
  it("marketStatus from the calendar", async () => {
    const j = (await (await api("/api/state")).json()) as any;
    expect(j.marketStatus.status).toBe("OPEN");
    expect(j.marketStatus.closesMs).toBe(Date.parse("2026-11-25T21:00:00Z"));
    expect(j.marketStatus.calendarValidUntil).toBe("2027-12-31");
    NOW = Date.parse("2026-11-26T15:00:00Z"); // Thanksgiving
    const c = (await (await api("/api/state")).json()) as any;
    expect(c.marketStatus).toMatchObject({ status: "CLOSED", reason: "Thanksgiving Day" });
    expect(c.marketStatus.opensMs).toBe(Date.parse("2026-11-27T14:30:00Z"));
    NOW = Date.parse("2026-11-27T15:00:00Z"); // day after Thanksgiving: early close 13:00
    const e = (await (await api("/api/state")).json()) as any;
    expect(e.marketStatus).toMatchObject({ status: "EARLY_CLOSE", closesMs: Date.parse("2026-11-27T18:00:00Z") });
  });

  it("baseline info for each market entry", async () => {
    await stock({ symbol: "NVDA", volume: { mode: "multiple", value: 2 } });
    await stock({ symbol: "AAPL", volume: { mode: "absolute", value: 500000 } });
    await market("NVDA", { last: { t: 1, p: 1, s: 1 }, cumVolume: 600_000 });
    await market("AAPL", { cumVolume: 1 });
    await market("TSLA", {});
    // 5-minute buckets, average cumulative volume 10,000 per bucket: at 30 min (10:00) it is 60,000
    const avgCum = Array.from({ length: 78 }, (_, i) => 10_000 * (i + 1));
    await d.prepare("INSERT INTO baselines VALUES ('NVDA',?,?,?)").bind(DATE, "OK", JSON.stringify({ symbol: "NVDA", builtFor: DATE, barMinutes: 5, sessions: 20, avgCum, avgFullDay: 780_000, status: "OK" })).run();
    await d.prepare("INSERT INTO baselines VALUES ('AAPL',?,?,?)").bind(DATE, "BUILDING", JSON.stringify({ symbol: "AAPL", builtFor: DATE, barMinutes: 5, sessions: 3, avgCum: [], avgFullDay: 0, status: "BUILDING" })).run();
    const j = (await (await api("/api/state")).json()) as any;
    const by = Object.fromEntries(j.market.map((m: any) => [m.symbol, m.baseline]));
    expect(by.NVDA).toEqual({ status: "OK", avgCumNow: 60_000, multiple: 10, thresholdShares: 120_000 });
    expect(by.AAPL).toEqual({ status: "BUILDING", thresholdShares: 500_000 });
    expect(by.TSLA).toEqual({ status: "NO_BASELINE" });
    expect(j.market.find((m: any) => m.symbol === "NVDA").cumVolume).toBe(600_000); // existing fields untouched
  });
});

describe("auth hardening", () => {
  it("IPv6 clients are keyed by their /64", () => {
    const a = clientKeySource("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    expect(clientKeySource("2001:0DB8:1:2::1")).toBe(a);
    expect(clientKeySource("[2001:db8:1:2:ffff::9]")).toBe(a);
    expect(clientKeySource("2001:db8:1:3::1")).not.toBe(a);
    expect(clientKeySource("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(clientKeySource("203.0.113.9")).toBe("203.0.113.9");
    expect(clientKeySource("fe80::1%eth0")).toBe(clientKeySource("fe80::2"));
    expect(clientKeySource("not-an-ip:::")).toMatch(/^raw:/);
  });

  it("10 failures from different addresses in one /64 lock the whole /64, not other prefixes", async () => {
    for (let i = 0; i < 10; i++) expect((await api("/api/state", `2001:db8:1:2:${i.toString(16)}::${i + 1}`, "bad" + i)).status).toBe(401);
    expect((await api("/api/state", "2001:db8:1:2:abcd::77")).status).toBe(429);
    expect((await api("/api/state", "2001:db8:1:9::1")).status).toBe(200);
    NOW += 15 * 60_000 + 1000;
    expect((await api("/api/state", "2001:db8:1:2:abcd::77")).status).toBe(200);
  });

  it("global brake: after 200 failures no more per-client rows, all logins rejected, one notice, alerts still work", async () => {
    await stock({ symbol: "NVDA", high: { mode: "dollar", value: 145 } });
    await rule("NVDA", "HIGH");
    for (let i = 0; i < GLOBAL_MAX; i++) await api("/api/state", `10.${i >> 8}.${i & 255}.1`, "bad");
    const rows = () => d.rows("SELECT * FROM auth_failures").length;
    expect(rows()).toBe(GLOBAL_MAX + 1); // 200 clients + the global row
    expect(tg.filter((c) => JSON.stringify(c.body).includes("LOGIN FLOOD"))).toHaveLength(0);
    expect((await api("/api/state", "10.9.9.9", "bad")).status).toBe(401); // the 201st failure: no client row, one notice
    expect(rows()).toBe(GLOBAL_MAX + 1);
    expect(tg.filter((c) => JSON.stringify(c.body).includes("LOGIN FLOOD"))).toHaveLength(1);
    // everything is rejected for the rest of the window, even the right code, and nothing is written
    expect((await api("/api/state", "10.8.8.8")).status).toBe(200); // the correct code is ALWAYS accepted
    const w = await api("/api/state", "10.7.7.7", "bad");
    expect(w.status).toBe(429);
    const wj = (await w.json()) as any;
    expect(wj.error).toBe("GLOBAL_LOCK");
    expect(wj.retryAfterMs).toBeGreaterThan(0);
    expect(w.headers.get("retry-after")).toBeTruthy();
    expect(rows()).toBe(GLOBAL_MAX + 1);
    expect(tg.filter((c) => JSON.stringify(c.body).includes("LOGIN FLOOD"))).toHaveLength(1);
    // alert-state writes are not starved: the Telegram acknowledge still works
    await press("a|NVDA|HIGH|1");
    expect(ruleRow("NVDA", "HIGH").state).toBe("ACKNOWLEDGED");
    // next window
    NOW += 15 * 60_000 + 1000;
    expect((await api("/api/state", "10.8.8.8")).status).toBe(200);
    expect((await api("/api/state", "10.6.6.6", "bad")).status).toBe(401);
  });
});
