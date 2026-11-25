import { beforeEach, describe, expect, it } from "vitest";
import { handleFetch } from "../../src/worker/index";
import { runScheduledJob, inWorkingWindow } from "../../src/worker/scheduled";
import { parseCommand } from "../../src/worker/intents";
import type { Env } from "../../src/worker/env";
import { FakeD1, fakeFetch, jsonRes } from "./fake-d1";

const CODE = "c".repeat(40);
const SECRET = "whsecret_abcdefghijklmnop";
let d: FakeD1;
let tgSent: unknown[];
let f: ReturnType<typeof fakeFetch>;
let NOW = Date.parse("2026-11-25T15:00:00Z");

const env = (): Env => ({
  DB: d.asD1(), ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
  ALPACA_KEY_ID: "k", ALPACA_SECRET_KEY: "s", TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHAT_ID: "42",
  TELEGRAM_WEBHOOK_SECRET: SECRET, DASHBOARD_ACCESS_CODE: CODE,
});
const deps = () => ({ fetch: f, now: () => NOW, sleep: async () => {} });
const call = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => handleFetch(new Request(`https://x.example${path}`, init), env(), deps());
const hook = (body: unknown, secret: string | null = SECRET) =>
  call("/tg/webhook", { method: "POST", headers: { "content-type": "application/json", ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}) }, body: JSON.stringify(body) });
const api = (path: string, init: RequestInit = {}, code = CODE, ip = "1.1.1.1") =>
  call(path, { ...init, headers: { authorization: `Bearer ${code}`, "cf-connecting-ip": ip, ...(init.body ? { "content-type": "application/json" } : {}) } });

beforeEach(() => {
  d = new FakeD1();
  tgSent = [];
  NOW = Date.parse("2026-11-25T15:00:00Z");
  f = fakeFetch({
    "api.telegram.org": (_u, init) => { tgSent.push(JSON.parse(String(init?.body))); return jsonRes({ ok: true, result: { message_id: 5 } }); },
    "/v2/stocks/snapshots": (u) => jsonRes(Object.fromEntries((new URL(u).searchParams.get("symbols") ?? "").split(",").filter((s) => s !== "NOPE").map((s) => [s, { latestTrade: { t: "2026-11-25T14:59:00Z", p: 100, s: 1 } }]))),
  });
});

describe("telegram webhook (AT-20)", () => {
  const msg = (chat: number, text: string, id = 1) => ({ update_id: id, message: { chat: { id: chat }, text } });
  it("rejects missing or wrong secret header and does nothing", async () => {
    expect((await hook(msg(42, "/status"), null)).status).toBe(401);
    expect((await hook(msg(42, "/status"), "wrong")).status).toBe(401);
    expect(tgSent).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  });
  it("ignores any other chat silently", async () => {
    const r = await hook(msg(999, "/status"));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("");
    expect(tgSent).toHaveLength(0);
  });
  it("answers the owner's /status and ignores replayed updates", async () => {
    expect((await hook(msg(42, "/status", 10))).status).toBe(200);
    expect(tgSent).toHaveLength(1);
    expect(JSON.stringify(tgSent[0])).toContain("STATUS");
    await hook(msg(42, "/status", 10));
    expect(tgSent).toHaveLength(1);
  });
  it("answers callback queries, also without a message field", async () => {
    await hook({ update_id: 3, callback_query: { id: "cb1", data: "A", from: { id: 42 } } });
    expect(f.calls.some((c) => c.url.includes("answerCallbackQuery"))).toBe(true);
    await hook({ update_id: 4, callback_query: { id: "cb2", data: "A", from: { id: 7 } } });
    expect(f.calls.filter((c) => c.url.includes("answerCallbackQuery"))).toHaveLength(1);
  });
  it("acknowledges via button and edits the message", async () => {
    d.rows("select 1");
    await api("/api/stocks", { method: "POST", body: JSON.stringify({ symbol: "AAPL", high: { mode: "dollar", value: 200 } }) });
    await d.prepare("INSERT INTO rule_state VALUES ('2026-11-25','AAPL','HIGH',1,?,0)").bind(JSON.stringify({ date: "2026-11-25", symbol: "AAPL", rule: "HIGH", state: "TRIGGERED", cycle: 1, remindersSent: 0, lastMessageId: 77, version: 1 })).run();
    await hook({ update_id: 5, callback_query: { id: "cb", data: "a|AAPL|HIGH|1", message: { message_id: 77, chat: { id: 42 } } } });
    expect(f.calls.some((c) => c.url.includes("editMessageText"))).toBe(true);
    expect(String(d.rows("SELECT json FROM rule_state")[0]!.json)).toContain("ACKNOWLEDGED");
  });
});

describe("dashboard API auth (FR-8.10)", () => {
  it("rejects missing and wrong codes, accepts the right one", async () => {
    expect((await call("/api/state")).status).toBe(401);
    expect((await api("/api/state", {}, "x".repeat(40))).status).toBe(401);
    const ok = await api("/api/state");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(ok.headers.get("cache-control")).toBe("no-store");
  });
  it("locks after 10 failures for 15 minutes, even for the right code, then releases", async () => {
    for (let i = 0; i < 10; i++) expect((await api("/api/state", {}, "bad" + i, "9.9.9.9")).status).toBe(401);
    const locked = await api("/api/state", {}, CODE, "9.9.9.9");
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBeTruthy();
    expect((await api("/api/state", {}, CODE, "8.8.8.8")).status).toBe(200); // other client unaffected
    NOW += 15 * 60_000 + 1000;
    expect((await api("/api/state", {}, CODE, "9.9.9.9")).status).toBe(200);
  });
  it("fails safe when the access code is not configured or too short", async () => {
    const e = { ...env(), DASHBOARD_ACCESS_CODE: "short" };
    const r = await handleFetch(new Request("https://x.example/api/state", { headers: { authorization: "Bearer short" } }), e, deps());
    expect(r.status).toBe(503);
  });
});

describe("dashboard API behaviour", () => {
  const post = (b: unknown) => api("/api/stocks", { method: "POST", body: JSON.stringify(b) });
  it("creates, validates, rejects duplicates and unknown symbols", async () => {
    expect((await post({ symbol: "aapl", high: { mode: "dollar", value: 250 }, low: { mode: "dollar", value: 230 } })).status).toBe(201);
    expect((await post({ symbol: "AAPL" })).status).toBe(409);
    expect((await post({ symbol: "NOPE" })).status).toBe(422);
    expect((await post({ symbol: "MSFT", high: { mode: "dollar", value: 100 }, low: { mode: "dollar", value: 120 } })).status).toBe(422);
    expect((await post({ symbol: "MSFT", high: { mode: "dollar", value: -5 } })).status).toBe(400);
    expect((await post({ symbol: "MSFT", bogus: 1 })).status).toBe(400);
    expect((await post({ symbol: "<script>" })).status).toBe(400);
  });
  it("create accepts volume, notes and paused with the same checks as update (add/edit form)", async () => {
    const r = await post({ symbol: "NVDA", high: { mode: "dollar", value: 200 }, low: { mode: "dollar", value: 100 }, volume: { mode: "multiple", value: 2 }, notes: "earnings week", paused: true });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { stock: unknown }).stock).toMatchObject({ symbol: "NVDA", volume: { mode: "multiple", value: 2 }, notes: "earnings week", paused: true });
    expect((await post({ symbol: "MSFT", volume: { mode: "multiple", value: 0 } })).status).toBe(400);
    expect((await post({ symbol: "MSFT", volume: { mode: "absolute", value: 1.5 } })).status).toBe(400);
    expect((await post({ symbol: "MSFT", notes: "x".repeat(201) })).status).toBe(400);
    expect((await post({ symbol: "MSFT", paused: "yes" })).status).toBe(400);
    expect((await post({ symbol: "MSFT", volume: { mode: "absolute", value: 500000 }, notes: "ok" })).status).toBe(201); // volume only, no price rule: same as update
  });
  it("needs at least one alert: create and update reject a stock left with none (422), import allows older stocks", async () => {
    const r = await post({ symbol: "MSFT", notes: "x" });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message?: string; error: string }).error).toBe("NO_ALERT");
    expect(JSON.stringify(await (await post({ symbol: "MSFT" })).json())).toContain("Set at least one alert: LOW, HIGH, Volume or 52-week.");
    expect((await post({ symbol: "AAPL", range52: true })).status).toBe(201); // the 52-week switch alone is an alert
    expect((await post({ symbol: "AMD", range52: "yes" })).status).toBe(400);
    expect((await post({ symbol: "MSFT", volume: { mode: "multiple", value: 2 } })).status).toBe(201);
    const put = (b: unknown) => api("/api/stocks/MSFT", { method: "PUT", body: JSON.stringify(b) });
    expect((await put({ volume: null })).status).toBe(422); // would leave none
    expect((await put({ notes: "fine", paused: true })).status).toBe(200);
    expect((await put({ volume: null, low: { mode: "dollar", value: 5 } })).status).toBe(200); // swapping is fine
    const exp = { format: "market-monitor-config", version: 1, settings: {}, stocks: [{ symbol: "OLD", enabled: true }] };
    expect((await api("/api/import", { method: "POST", body: JSON.stringify(exp) })).status).toBe(200);
  });
  it("asks to confirm when the latest price already crosses (FR-2.4)", async () => {
    await d.prepare("INSERT INTO market_state VALUES ('2026-11-25','AAPL',?,0)").bind(JSON.stringify({ symbol: "AAPL", date: "2026-11-25", last: { t: 1, p: 100, s: 1 } })).run();
    const r = await post({ symbol: "AAPL", high: { mode: "dollar", value: 90 } });
    expect(r.status).toBe(409);
    expect((await r.json() as { error: string }).error).toBe("CONFIRM_REQUIRED");
    expect((await post({ symbol: "AAPL", high: { mode: "dollar", value: 90 }, confirm: true })).status).toBe(201);
  });
  it("exports without secrets and imports back (AT-24)", async () => {
    await post({ symbol: "AAPL", high: { mode: "dollar", value: 250 } });
    const exp = await (await api("/api/export")).text();
    expect(exp).not.toMatch(/tok|whsecret|ccccc/);
    await api("/api/stocks/AAPL", { method: "DELETE" });
    expect(((await (await api("/api/stocks")).json()) as { stocks: unknown[] }).stocks).toHaveLength(0);
    expect((await api("/api/import", { method: "POST", body: exp })).status).toBe(200);
    expect(((await (await api("/api/stocks")).json()) as { stocks: { symbol: string }[] }).stocks[0]?.symbol).toBe("AAPL");
  });
  it("rejects an oversized body and a bad import", async () => {
    expect((await api("/api/stocks", { method: "POST", body: "x".repeat(70_000) })).status).toBe(413);
    expect((await api("/api/import", { method: "POST", body: JSON.stringify({ format: "nope" }) })).status).toBe(400);
  });
  it("settings are range-checked", async () => {
    expect((await api("/api/settings", { method: "PUT", body: JSON.stringify({ reminderIntervalMin: 99 }) })).status).toBe(400);
    expect((await api("/api/settings", { method: "PUT", body: JSON.stringify({ reminderIntervalMin: 5 }) })).status).toBe(200);
  });
  it("health shows only the poll time; unknown paths fall to assets", async () => {
    const h = await (await call("/health")).json() as Record<string, unknown>;
    expect(Object.keys(h).sort()).toEqual(["ageSec", "configured", "lastPollMs", "ok"]);
    expect(await (await call("/index.html")).text()).toBe("asset");
  });
});

describe("scheduled", () => {
  it("fast exit outside the window and on weekends", async () => {
    expect(inWorkingWindow(Date.parse("2026-11-25T10:59:00Z"))).toBe(false);
    expect(inWorkingWindow(Date.parse("2026-11-28T15:00:00Z"))).toBe(false);
    expect(inWorkingWindow(Date.parse("2026-11-25T11:00:00Z"))).toBe(true);
    const r = await runScheduledJob(env(), { ...deps(), now: () => Date.parse("2026-11-25T05:00:00Z") });
    expect(r.ran).toBe(false);
  });
  it("polls up to 5 times, stops on idle, and drains the queue", async () => {
    let calls = 0;
    const engine = { runScheduled: async () => { calls++; return { status: "ok" }; } };
    const r = await runScheduledJob(env(), { ...deps(), engine });
    expect(calls).toBe(5);
    expect(r.polls).toBe(5);
    calls = 0;
    const r2 = await runScheduledJob(env(), { ...deps(), engine: { runScheduled: async () => { calls++; return { status: "idle" }; } } });
    expect(calls).toBe(1);
    expect(r2.polls).toBe(1);
  });
  it("sends queued events by priority", async () => {
    const eng = { runScheduled: async (p: { store: { enqueue(e: unknown, pr: number, n: number): Promise<void> } }) => { await p.store.enqueue({ type: "READY", date: "d", info: {} }, 3, 1); await p.store.enqueue({ type: "TEST_ALERT" }, 0, 2); return { status: "pre_open" }; } };
    await runScheduledJob(env(), { ...deps(), engine: eng as never });
    expect(JSON.stringify(tgSent[0])).toContain("TEST ALERT");
    expect(JSON.stringify(tgSent[1])).toContain("READY");
  });
  it("missing secrets: no engine run, one notice per day with names only", async () => {
    let ran = 0;
    const e = { ...env(), ALPACA_SECRET_KEY: undefined };
    const engine = { runScheduled: async () => { ran++; return { status: "ok" }; } };
    await runScheduledJob(e, { ...deps(), engine });
    await runScheduledJob(e, { ...deps(), engine });
    expect(ran).toBe(0);
    expect(tgSent).toHaveLength(1);
    expect(JSON.stringify(tgSent[0])).toContain("ALPACA_SECRET_KEY");
  });
});

describe("command parsing", () => {
  it("parses /set variants", () => {
    expect(parseCommand("/set aapl high 250")).toMatchObject({ type: "set", symbol: "AAPL", field: "high", value: { mode: "dollar", value: 250 } });
    expect(parseCommand("/set AAPL low -5%")).toMatchObject({ value: { mode: "percent", value: -5 } });
    expect(parseCommand("/set AAPL volume 2x")).toMatchObject({ value: { mode: "multiple", value: 2 } });
    expect(parseCommand("/set AAPL high off")).toMatchObject({ value: null });
    expect(parseCommand("/set AAPL high abc")?.type).toBe("invalid");
    expect(parseCommand("/mute@mybot AAPL 2h")).toEqual({ type: "mute", symbol: "AAPL", minutes: 120 });
    expect(parseCommand("hello")).toBeNull();
  });
});

describe("one-time data access check (news, splits)", () => {
  const idle = { runScheduled: async () => ({ status: "idle" }) };
  const withRoutes = (r: Record<string, (u: string) => Response>) => {
    const base = f;
    f = fakeFetch({ ...r, "api.telegram.org": (_u, init) => { tgSent.push(JSON.parse(String(init?.body))); return jsonRes({ ok: true, result: { message_id: 7 } }); } });
    return base;
  };
  beforeEach(async () => (await import("../../src/worker/accesscheck")).resetAccessCheckForTests());

  it("reports allowed and refused data once, silently, with statuses only", async () => {
    withRoutes({
      "/v1beta1/news": () => jsonRes({ news: [{ created_at: new Date(NOW - 12 * 60_000).toISOString(), headline: "H" }] }),
      "symbols=NVDA": () => jsonRes({ corporate_actions: { forward_splits: [{ symbol: "NVDA", old_rate: 1, new_rate: 10, ex_date: "2024-06-10" }] } }),
      "/v1/corporate-actions": () => jsonRes({ message: "forbidden" }, 403),
    });
    await runScheduledJob(env(), { ...deps(), engine: idle, accessCheck: true });
    expect(tgSent).toHaveLength(1);
    const msg = tgSent[0] as { text: string; disable_notification?: boolean };
    expect(msg.text).toContain("News: allowed");
    expect(msg.text).toContain("latest 12 min old");
    expect(msg.text).toContain("NVDA 10-for-1 found");
    expect(msg.text).toContain("Splits (coming): refused (HTTP 403)");
    expect(msg.text).toContain("Refused data will not be used.");
    expect(msg.text).not.toContain("H\n");
    expect(msg.disable_notification).toBe(true);
    const before = f.calls.length;
    await runScheduledJob(env(), { ...deps(), engine: idle, accessCheck: true });
    expect(tgSent).toHaveLength(1);
    expect(f.calls.slice(before).some((c) => c.url.includes("/v1beta1/news") || c.url.includes("corporate-actions"))).toBe(false);
  });

  it("no answer (network trouble) records nothing and tries again later", async () => {
    withRoutes({ "/v1beta1/news": () => { throw new TypeError("network"); }, "/v1/corporate-actions": () => jsonRes({ corporate_actions: {} }) });
    await runScheduledJob(env(), { ...deps(), engine: idle, accessCheck: true });
    expect(tgSent).toHaveLength(0);
    withRoutes({ "/v1beta1/news": () => jsonRes({ news: [] }), "/v1/corporate-actions": () => jsonRes({ corporate_actions: { forward_splits: [], reverse_splits: [] } }) });
    await runScheduledJob(env(), { ...deps(), engine: idle, accessCheck: true });
    expect((tgSent[0] as { text: string }).text).toContain("News: allowed");
    expect((tgSent[0] as { text: string }).text).toContain("Splits (past): answered, no usable data");
  });
});
