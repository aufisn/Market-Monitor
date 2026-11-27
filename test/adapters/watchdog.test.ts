/** Outside watchdog: Healthchecks ping every fifth minute, /fail after a failed poll, never without a valid address. */
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/worker/env";
import { runScheduledJob } from "../../src/worker/scheduled";
import { cleanPingUrl, isPingMinute } from "../../src/worker/watchdog";
import { FakeD1, fakeFetch, jsonRes } from "./fake-d1";

const PING = "https://hc-ping.com/0a1b2c3d-1111-2222-3333-444455556666";
let d: FakeD1;
let f: ReturnType<typeof fakeFetch>;
const env = (url: string | undefined = PING): Env => ({
  DB: d.asD1(), ASSETS: { fetch: async () => new Response("a") } as unknown as Fetcher,
  ALPACA_KEY_ID: "k", ALPACA_SECRET_KEY: "s", TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHAT_ID: "42",
  TELEGRAM_WEBHOOK_SECRET: "w".repeat(24), DASHBOARD_ACCESS_CODE: "c".repeat(40), HEALTHCHECK_URL: url,
});
const idle = { runScheduled: async () => ({ status: "idle" }) };
const run = (e: Env, iso: string, engine: { runScheduled: () => Promise<{ status: string }> } = idle) =>
  runScheduledJob(e, { fetch: f, now: () => Date.parse(iso), sleep: async () => {}, engine, accessCheck: false });
const pings = () => f.calls.filter((c) => c.url.includes("hc-ping.com")).map((c) => c.url);

beforeEach(() => {
  d = new FakeD1();
  f = fakeFetch({ "hc-ping.com": () => new Response("OK"), "api.telegram.org": () => jsonRes({ ok: true, result: { message_id: 1 } }) });
});

describe("watchdog ping address", () => {
  it("accepts only https://hc-ping.com/<id>", () => {
    expect(cleanPingUrl(PING)).toBe(PING);
    expect(cleanPingUrl(` ${PING} `)).toBe(PING);
    expect(cleanPingUrl("https://hc-ping.com/abcKEY/my-check")).toBe("https://hc-ping.com/abcKEY/my-check");
    for (const bad of [undefined, "", "http://hc-ping.com/x", "https://evil.example/x", "https://hc-ping.com.evil.example/x",
      "https://u:p@hc-ping.com/x", "https://hc-ping.com:8443/x", "https://hc-ping.com/x?y=1", "https://hc-ping.com/", "https://hc-ping.com/a/b/c",
      "https://hc-ping.com/x#y", `https://hc-ping.com/${"a".repeat(250)}`]) expect(cleanPingUrl(bad)).toBeUndefined();
  });
  it("pings on minutes divisible by 5 only", () => {
    expect(isPingMinute(Date.parse("2026-11-27T16:05:00Z"))).toBe(true);
    expect(isPingMinute(Date.parse("2026-11-27T16:06:00Z"))).toBe(false);
  });
});

describe("watchdog in the timer run", () => {
  it("pings once on a fifth minute, not on other minutes", async () => {
    await run(env(), "2026-11-27T16:05:01Z");
    expect(pings()).toEqual([PING]);
    await run(env(), "2026-11-27T16:06:01Z");
    expect(pings()).toHaveLength(1);
  });
  it("pings /fail when a poll failed", async () => {
    await run(env(), "2026-11-27T16:10:01Z", { runScheduled: async () => { throw new Error("boom"); } });
    expect(pings()).toEqual([`${PING}/fail`]);
  });
  it("does nothing without a valid address", async () => {
    await run({ ...env(), HEALTHCHECK_URL: undefined }, "2026-11-27T16:05:01Z");
    await run(env("https://example.com/ping"), "2026-11-27T16:05:01Z");
    expect(pings()).toHaveLength(0);
  });
  it("stays silent when secrets are missing, so Healthchecks raises the alarm", async () => {
    await run({ ...env(), ALPACA_KEY_ID: undefined }, "2026-11-27T16:05:01Z");
    expect(pings()).toHaveLength(0);
  });
  it("a failing ping never breaks the run", async () => {
    f = fakeFetch({ "hc-ping.com": () => { throw new TypeError("network"); } });
    const r = await run(env(), "2026-11-27T16:05:01Z");
    expect(r.ran).toBe(true);
  });
});
