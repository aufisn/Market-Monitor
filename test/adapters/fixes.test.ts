/** Regression tests for the QA / security fix round (one block per fix). */
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/worker/env";
import { handleFetch } from "../../src/worker/index";
import { FakeD1, fakeFetch, jsonRes } from "./fake-d1";

const CODE = "c".repeat(40);
const SECRET = "whsecret_abcdefghijklmnop";
const DATE = "2026-11-25";
let d: FakeD1;
let tg: { method: string; body: Record<string, any> }[];
let f: ReturnType<typeof fakeFetch>;
let NOW = Date.parse("2026-11-25T15:00:00Z");
let nextId = 5;

const env = (): Env => ({
  DB: d.asD1(), ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
  ALPACA_KEY_ID: "k", ALPACA_SECRET_KEY: "s", TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHAT_ID: "42", TELEGRAM_WEBHOOK_SECRET: SECRET, DASHBOARD_ACCESS_CODE: CODE,
});
const call = (path: string, init: RequestInit = {}) => handleFetch(new Request(`https://x.example${path}`, init), env(), { fetch: f, now: () => NOW, sleep: async () => {} });
let uid = 1000;
const hook = (body: Record<string, unknown>) =>
  call("/tg/webhook", { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, body: JSON.stringify({ update_id: ++uid, ...body }) });
const say = (text: string, reply?: { id: number; text: string }) =>
  hook({ message: { chat: { id: 42 }, text, ...(reply ? { reply_to_message: { message_id: reply.id, text: reply.text } } : {}) } });
const press = (data: string, messageId = 77) => hook({ callback_query: { id: "cb" + uid, data, from: { id: 42 }, message: { message_id: messageId, chat: { id: 42 } } } });
const post = (path: string, body: unknown) =>
  call(path, { method: "POST", headers: { authorization: `Bearer ${CODE}`, "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const get = (path: string) => call(path, { headers: { authorization: `Bearer ${CODE}` } });
const sent = (m: string) => tg.filter((c) => c.method === m);
const lastSend = () => String(sent("sendMessage").at(-1)!.body.text);

const stock = (o: Record<string, unknown>) => d.prepare("INSERT OR REPLACE INTO stocks VALUES (?,?,?,0)").bind(o.symbol as string, 1, JSON.stringify({ enabled: true, ...o })).run();
const market = (symbol: string, o: Record<string, unknown>) => d.prepare("INSERT OR REPLACE INTO market_state VALUES (?,?,?,0)").bind(DATE, symbol, JSON.stringify({ symbol, date: DATE, ...o })).run();
const rule = (symbol: string, r: string, o: Record<string, unknown> = {}) =>
  d.prepare("INSERT OR REPLACE INTO rule_state VALUES (?,?,?,1,?,0)").bind(DATE, symbol, r, JSON.stringify({ date: DATE, symbol, rule: r, state: "TRIGGERED", cycle: 1, remindersSent: 0, lastMessageId: 77, version: 1, t0Ms: NOW - 1_800_000, ...o })).run();
const stockRow = (s: string) => JSON.parse(String(d.rows(`SELECT json FROM stocks WHERE symbol='${s}'`)[0]!.json));
const ruleRow = (s: string, r: string) => JSON.parse(String(d.rows(`SELECT json FROM rule_state WHERE symbol='${s}' AND rule='${r}'`)[0]!.json));
const prevClose = { symbol: "X", date: "2026-11-24", close: 138.2, high: 139, low: 136, volume: 6e6 };

beforeEach(() => {
  d = new FakeD1();
  tg = [];
  uid = 1000;
  nextId = 5;
  NOW = Date.parse("2026-11-25T15:00:00Z");
  f = fakeFetch({
    "api.telegram.org": (u, init) => {
      tg.push({ method: u.split("/").pop()!, body: JSON.parse(String(init?.body)) });
      return jsonRes({ ok: true, result: { message_id: u.endsWith("/sendMessage") ? nextId++ : 1 } });
    },
  });
});

describe("fix 1: global pause keeps its memory (pause, pause, resume)", () => {
  it("restores every stock the global pause stopped", async () => {
    await stock({ symbol: "AAA", high: { mode: "dollar", value: 10 } });
    await stock({ symbol: "BBB", high: { mode: "dollar", value: 10 } });
    await stock({ symbol: "CCC", high: { mode: "dollar", value: 10 }, paused: true }); // paused by hand before: stays paused
    await say("/pause");
    await say("/pause");
    expect(JSON.parse(String(d.rows("SELECT v FROM run_meta WHERE k='paused_all'")[0]!.v)).sort()).toEqual(["AAA", "BBB"]);
    await say("/resume");
    expect(["AAA", "BBB", "CCC"].map((s) => !!stockRow(s).paused)).toEqual([false, false, true]);
  });
  it("a stock added between two pauses is merged in, nothing is dropped", async () => {
    await stock({ symbol: "AAA", high: { mode: "dollar", value: 10 } });
    await post("/api/pause-all", { paused: true });
    await stock({ symbol: "BBB", high: { mode: "dollar", value: 10 } });
    await post("/api/pause-all", { paused: true });
    await post("/api/pause-all", { paused: false });
    expect(["AAA", "BBB"].map((s) => !!stockRow(s).paused)).toEqual([false, false]);
  });
});

describe("fix 2: POST /api/ack-move", () => {
  beforeEach(async () => {
    await stock({ symbol: "NVDA", high: { mode: "dollar", value: 145 }, low: { mode: "dollar", value: 130 } });
    await market("NVDA", { last: { t: 1, p: 145.6, s: 1 }, prev: prevClose });
    await rule("NVDA", "HIGH");
  });
  const body = (value: unknown, extra: Record<string, unknown> = {}) => ({ symbol: "NVDA", rule: "HIGH", cycle: 1, value, ...extra });

  it.each([["+1%", 146.45], ["2%", 147.9], ["$150", 150], ["150", 150]])("value %s saves, logs, acknowledges and re-arms", async (value, expected) => {
    const r = await post("/api/ack-move", body(value));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, newThreshold: expected });
    expect(stockRow("NVDA").high.value).toBe(expected);
    expect(ruleRow("NVDA", "HIGH").state).toBe("ARMED");
    expect(d.rows("SELECT * FROM log WHERE kind='SETTINGS_CHANGE'")).toHaveLength(1);
    expect(d.rows("SELECT * FROM log WHERE kind='ACK'")).toHaveLength(1);
    expect(d.rows("SELECT * FROM config_log WHERE key='NVDA'").length).toBeGreaterThan(0);
  });

  it("a validation error acknowledges and saves nothing", async () => {
    for (const value of ["144", "-3%", "abc", "0", 150, null]) {
      const r = await post("/api/ack-move", body(value));
      expect(r.status, String(value)).toBe(400);
      const j = (await r.json()) as any;
      expect(j.error).toBeTruthy();
      expect(j.message).toBeTruthy();
    }
    expect(stockRow("NVDA").high.value).toBe(145);
    expect(ruleRow("NVDA", "HIGH").state).toBe("TRIGGERED");
    expect(d.rows("SELECT * FROM log WHERE kind='ACK'")).toHaveLength(0);
  });

  it("LOW must stay below HIGH and below the last price", async () => {
    await stock({ symbol: "AMZN", high: { mode: "dollar", value: 215 }, low: { mode: "dollar", value: 200 } });
    await market("AMZN", { last: { t: 1, p: 199.85, s: 1 }, prev: { ...prevClose, close: 207.5 } });
    await rule("AMZN", "LOW");
    expect((await post("/api/ack-move", { symbol: "AMZN", rule: "LOW", cycle: 1, value: "250" })).status).toBe(400);
    expect(stockRow("AMZN").low.value).toBe(200);
    expect((await post("/api/ack-move", { symbol: "AMZN", rule: "LOW", cycle: 1, value: "1%" })).status).toBe(200);
    expect(stockRow("AMZN").low.value).toBe(198);
  });

  it("a stale cycle or an acknowledged alert gives 409; bad rule gives 400", async () => {
    const stale = await post("/api/ack-move", body("+1%", { cycle: 2 }));
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as any).message).toBe("This alert is no longer active");
    expect(stockRow("NVDA").high.value).toBe(145);
    expect((await post("/api/ack-move", body("+1%", { rule: "VOLUME" }))).status).toBe(400);
    expect((await post("/api/ack-move", "[1]")).status).toBe(400);
    expect((await get("/api/ack-move")).status).toBe(405);
  });
});

describe("fix 4: POST /api/mute validation", () => {
  beforeEach(async () => { await stock({ symbol: "NVDA", high: { mode: "dollar", value: 145 } }); });
  it("accepts only an object with an integer number of minutes from 1 to 1440 (or null)", async () => {
    for (const b of ['[1]', '"x"', "5", "null"]) expect((await post("/api/mute", b)).status, b).toBe(400);
    for (const minutes of ["60", true, false, 0, -5, 1441, 1.5, {}, [60], undefined]) {
      expect((await post("/api/mute", { symbol: "NVDA", minutes })).status, String(minutes)).toBe(400);
    }
    expect((await post("/api/mute", { symbol: "NVDA", minutes: 60 })).status).toBe(200);
    expect(stockRow("NVDA").mutedUntilMs).toBe(NOW + 3_600_000);
    expect((await post("/api/mute", { symbol: "NVDA", minutes: 1440 })).status).toBe(200);
    expect((await post("/api/mute", { symbol: "NVDA", minutes: null })).status).toBe(200);
    expect(stockRow("NVDA").mutedUntilMs).toBeUndefined();
  });
});

describe("fix 5: a typed reply to an expired or replaced prompt", () => {
  const PROMPT = "⌨ Reply with the new NVDA HIGH:\na price (148.00) or a percent (+3%)";
  beforeEach(async () => {
    await stock({ symbol: "NVDA", high: { mode: "dollar", value: 145 }, low: { mode: "dollar", value: 130 } });
    await market("NVDA", { last: { t: 1, p: 144.8, s: 1 }, prev: prevClose });
    await rule("NVDA", "HIGH");
  });
  it("expired prompt", async () => {
    await press("y|NVDA|HIGH|1"); // prompt message id 5
    NOW += 11 * 60_000;
    await say("148", { id: 5, text: PROMPT });
    expect(lastSend().replace(/\n/g, " ")).toBe("That prompt expired. Tap Ack + move again."); // wrapped at 38 characters
    expect(stockRow("NVDA").high.value).toBe(145);
  });
  it("replaced prompt (a newer one is live)", async () => {
    await press("y|NVDA|HIGH|1"); // id 5
    await press("y|NVDA|HIGH|1"); // id 6 replaces it
    await say("148", { id: 5, text: PROMPT });
    expect(lastSend().replace(/\n/g, " ")).toBe("That prompt expired. Tap Ack + move again."); // wrapped at 38 characters
    expect(stockRow("NVDA").high.value).toBe(145);
    await say("148", { id: 6, text: PROMPT });
    expect(stockRow("NVDA").high.value).toBe(148);
  });
});

describe("fix 6: strict /why dates", () => {
  beforeEach(async () => {
    NOW = Date.parse("2026-11-30T20:00:00Z");
    await stock({ symbol: "NVDA", high: { mode: "dollar", value: 145 } });
  });
  it("API rejects impossible and out-of-table dates", async () => {
    for (const date of ["2026-02-31", "2026-13-01", "2025-12-31", "2028-01-01", "20261125", "2026-1-5", "x"]) {
      expect((await get(`/api/why?symbol=NVDA&t=10:00&date=${date}`)).status, date).toBe(400);
    }
    expect((await get("/api/why?symbol=NVDA&t=10:00&date=2026-11-27")).status).toBe(200);
  });
  it("closed day: 'Market closed: <reason>' in the API and in Telegram, with an optional date", async () => {
    const j = (await (await get("/api/why?symbol=NVDA&t=14:03&date=2026-11-26")).json()) as any;
    expect(j.marketClosed).toBe("Thanksgiving Day");
    expect(j.lines[0]).toBe("Market closed: Thanksgiving Day");
    await say("/why NVDA 14:03 2026-11-26");
    expect(lastSend()).toContain("Market closed: Thanksgiving Day");
    await say("/why NVDA 14:03 2026-11-28");
    expect(lastSend()).toContain("Market closed: Weekend");
    await say("/why NVDA 14:03 2026-02-31");
    expect(lastSend()).toContain("Date must be a real day");
    await say("/why NVDA 10:00");
    expect(lastSend()).not.toContain("Market closed");
    const open = (await (await get("/api/why?symbol=NVDA&t=10:00&date=2026-11-27")).json()) as any;
    expect(open.marketClosed).toBeNull();
  });
});

describe("fix 7: Ack + move is refused when the alert is stale", () => {
  beforeEach(async () => {
    await stock({ symbol: "NVDA", high: { mode: "dollar", value: 145 } });
    await market("NVDA", { last: { t: 1, p: 145.6, s: 1 }, prev: prevClose });
    await rule("NVDA", "HIGH", { cycle: 2 });
  });
  it("chooser, typed prompt and the +1% button check the cycle", async () => {
    await press("x|NVDA|HIGH|1");
    expect(sent("answerCallbackQuery").at(-1)!.body.text).toBe("This alert is no longer active");
    expect(sent("editMessageReplyMarkup")).toHaveLength(1); // keyboard removed
    await press("y|NVDA|HIGH|1");
    expect(sent("answerCallbackQuery").at(-1)!.body.text).toBe("This alert is no longer active");
    expect(sent("sendMessage")).toHaveLength(0); // no prompt was sent
    await press("t|NVDA|HIGH|1|1");
    expect(sent("answerCallbackQuery").at(-1)!.body.text).toBe("This alert is no longer active");
    expect(stockRow("NVDA").high.value).toBe(145);
    expect(ruleRow("NVDA", "HIGH").state).toBe("TRIGGERED");
    await press("t|NVDA|HIGH|1|2"); // the current cycle works
    expect(stockRow("NVDA").high.value).toBe(146.45);
  });
});

describe("fix 8: 'Ack all SYM' acknowledges only the rules listed in that message", () => {
  it("leaves other rules of the stock alone and ignores stale cycles", async () => {
    await stock({ symbol: "NVDA", high: { mode: "dollar", value: 145 }, low: { mode: "dollar", value: 130 }, volume: { mode: "multiple", value: 2 } });
    await rule("NVDA", "HIGH");
    await rule("NVDA", "LOW");
    await rule("NVDA", "VOLUME");
    await press("k|NVDA|HIGH:1,LOW:9");
    expect(ruleRow("NVDA", "HIGH").state).toBe("ACKNOWLEDGED");
    expect(ruleRow("NVDA", "LOW").state).toBe("TRIGGERED"); // stale cycle
    expect(ruleRow("NVDA", "VOLUME").state).toBe("TRIGGERED"); // not listed
  });
});
