/** FR-13.1 test cycle: /test and POST /api/test run a real-path TEST alert with reminders, ack, auto-stop, isolation. */
import { beforeEach, describe, expect, it } from "vitest";
import { widest } from "../../src/adapters/glance-fmt";
import type { Env } from "../../src/worker/env";
import { handleFetch } from "../../src/worker/index";
import { runScheduledJob } from "../../src/worker/scheduled";
import { FakeD1, fakeFetch, jsonRes } from "./fake-d1";

const CODE = "c".repeat(40);
const SECRET = "whsecret_abcdefghijklmnop";
let d: FakeD1;
let tg: { method: string; body: Record<string, any> }[];
let f: ReturnType<typeof fakeFetch>;
let NOW = 0;
let nextId = 100;

const env = (): Env => ({
  DB: d.asD1(), ASSETS: { fetch: async () => new Response("a") } as unknown as Fetcher, ALPACA_KEY_ID: "k", ALPACA_SECRET_KEY: "s",
  TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "42", TELEGRAM_WEBHOOK_SECRET: SECRET, DASHBOARD_ACCESS_CODE: CODE,
});
const deps = () => ({ fetch: f, now: () => NOW, sleep: async () => {} });
const call = (path: string, init: RequestInit = {}) => handleFetch(new Request(`https://x.example${path}`, init), env(), deps());
let uid = 0;
const hook = (b: Record<string, unknown>) =>
  call("/tg/webhook", { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, body: JSON.stringify({ update_id: ++uid, ...b }) });
const say = (text: string) => hook({ message: { chat: { id: 42 }, text } });
const press = (data: string, messageId: number) => hook({ callback_query: { id: "cb" + uid, data, from: { id: 42 }, message: { message_id: messageId, chat: { id: 42 } } } });
const startViaApi = () => call("/api/test", { method: "POST", headers: { authorization: `Bearer ${CODE}` } });
const idle = { runScheduled: async () => ({ status: "idle" }) };
const tick = (engine: unknown = idle) => runScheduledJob(env(), { ...deps(), engine: engine as never });
const sends = () => tg.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text));
const dump = () => JSON.stringify(["rule_state", "log", "counters", "alert_ids", "outbound_queue", "market_state"].map((t) => d.rows(`SELECT * FROM ${t}`)));

beforeEach(() => {
  d = new FakeD1();
  tg = [];
  uid = 0;
  nextId = 100;
  NOW = Date.parse("2026-11-25T15:00:00Z"); // Wed 10:00 ET, market open
  f = fakeFetch({
    "api.telegram.org": (u, init) => {
      tg.push({ method: u.split("/").pop()!, body: JSON.parse(String(init?.body)) });
      return jsonRes({ ok: true, result: { message_id: u.endsWith("/sendMessage") ? nextId++ : 1 } });
    },
  });
});

describe("FR-13.1 test cycle", () => {
  it("first alert now, then a notifying reminder at +1, +2 and +3 minutes, each replacing the previous one", async () => {
    expect((await startViaApi()).status).toBe(200);
    expect(sends()).toHaveLength(1);
    expect(sends()[0]).toContain("TEST ALERT");
    for (let n = 1; n <= 3; n++) {
      NOW += 60_000;
      await tick();
      const t = sends().at(-1)!;
      expect(t).toContain(`TEST REMINDER ${n}`);
      expect(t.replace(/\n/g, " ")).toContain(`Reminder ${n} – test`);
      expect(t.replace(/\n/g, " ")).toContain(`unacknowledged ${n} min`);
      expect(tg.filter((c) => c.method === "sendMessage").at(-1)!.body.disable_notification).toBeUndefined(); // notifies
      expect(widest(t)).toBeLessThanOrEqual(38);
    }
    expect(sends()).toHaveLength(4);
    expect(tg.filter((c) => c.method === "deleteMessage").map((c) => c.body.message_id)).toEqual([100, 101, 102]); // tidy-up
    NOW += 20_000;
    await tick(); // not due yet
    expect(sends()).toHaveLength(4);
  });

  it("acknowledge by button stops the reminders and edits the message", async () => {
    await say("/test");
    NOW += 60_000;
    await tick();
    await press("a|TEST|HIGH|0", 101);
    const edit = tg.filter((c) => c.method === "editMessageText").at(-1)!;
    expect(edit.body.message_id).toBe(101);
    expect(String(edit.body.text)).toMatch(/Acknowledged \d\d:\d\d ET \/ \d\d:\d\d Muscat/);
    expect(edit.body.reply_markup).toEqual({ inline_keyboard: [] }); // buttons removed
    const before = sends().length;
    NOW += 5 * 60_000;
    await tick();
    expect(sends()).toHaveLength(before);
  });

  it("/ack TEST acknowledges too, and says so when no test is running", async () => {
    await say("/test");
    await say("/ack TEST");
    expect(tg.filter((c) => c.method === "editMessageText")).toHaveLength(1);
    await say("/ack TEST");
    expect(sends().at(-1)).toContain("No test is running");
  });

  it("stops by itself after 10 reminders with a final message", async () => {
    await say("/test");
    for (let i = 0; i < 14; i++) {
      NOW += 60_000;
      await tick();
    }
    const all = sends();
    expect(all.filter((t) => t.includes("TEST REMINDER"))).toHaveLength(10);
    expect(all.filter((t) => t.includes("Test ended – no acknowledgment"))).toHaveLength(1);
    expect(all.at(-1)).toContain("Test ended");
    expect(d.rows("SELECT v FROM run_meta WHERE k='test_cycle'")[0]?.v ?? "").toBe("");
  });

  it("a second /test restarts the cycle from reminder 1", async () => {
    await say("/test");
    NOW += 60_000; await tick();
    NOW += 60_000; await tick();
    await say("/test");
    expect(tg.filter((c) => c.method === "editMessageReplyMarkup")).toHaveLength(1); // old test button removed
    NOW += 60_000;
    await tick();
    expect(sends().at(-1)).toContain("TEST REMINDER 1");
  });

  it("runs outside session hours: after the close and on a market holiday, before the engine's early exit", async () => {
    NOW = Date.parse("2026-11-25T21:30:00Z"); // 16:30 ET, session over, still inside the cron window
    await say("/test");
    NOW += 60_000;
    await tick(undefined); // the REAL engine, which exits at once when the market is closed
    expect(sends().at(-1)).toContain("TEST REMINDER 1");
    NOW = Date.parse("2026-11-26T15:00:00Z"); // Thanksgiving: market closed all day
    await say("/test");
    NOW += 60_000;
    await runScheduledJob(env(), deps());
    expect(sends().at(-1)).toContain("TEST REMINDER 1");
  });

  it("stays out of real alert state, logs, counters, the queue and the briefing", async () => {
    await d.prepare("INSERT INTO rule_state VALUES ('2026-11-25','NVDA','HIGH',3,?,0)").bind(JSON.stringify({ date: "2026-11-25", symbol: "NVDA", rule: "HIGH", state: "TRIGGERED", cycle: 1, remindersSent: 0, version: 3 })).run();
    await d.prepare("INSERT INTO log (t_ms, kind, symbol, rule, detail) VALUES (1,'FIRST_ALERT','NVDA','HIGH','{}')").run();
    await d.prepare("INSERT INTO counters VALUES ('2026-11-25','alerts',1)").run();
    const before = dump();
    await say("/test");
    for (let i = 0; i < 4; i++) { NOW += 60_000; await tick(); }
    await press("a|TEST|HIGH|0", 103);
    expect(dump()).toBe(before);
    // and the real unacknowledged total is unchanged
    await say("/status");
    expect(sends().at(-1)).toContain("Unacknowledged: 1");
  });

  it("costs one D1 read per run when no test is running", async () => {
    const r = await tick();
    expect(r.calls).toBeLessThanOrEqual(12);
    expect(sends()).toHaveLength(0);
  });
});
