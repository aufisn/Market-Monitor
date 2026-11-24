import { describe, expect, it } from "vitest";
import { buildSetWebhookBody, TelegramApi, TelegramError } from "../../src/adapters/telegram";
import { fakeFetch, jsonRes } from "./fake-d1";

const mk = (f: typeof fetch, sleeps: number[] = []) =>
  new TelegramApi({ token: "TOK", chatId: "42", fetch: f, sleep: async (ms) => { sleeps.push(ms); }, now: () => 0 });

describe("telegram transport", () => {
  it("sends HTML with inline keyboard", async () => {
    const f = fakeFetch({ "/sendMessage": () => jsonRes({ ok: true, result: { message_id: 7 } }) });
    const id = await mk(f).sendMessage({ text: "<b>x</b>", buttons: [[{ text: "Ack", data: "A" }]] });
    expect(id).toBe(7);
    const body = JSON.parse(String(f.calls[0]!.init!.body));
    expect(body.parse_mode).toBe("HTML");
    expect(body.reply_markup.inline_keyboard[0][0]).toEqual({ text: "Ack", callback_data: "A" });
  });

  it("waits retry_after on 429 and retries", async () => {
    const sleeps: number[] = [];
    const f = fakeFetch({ "/sendMessage": [() => jsonRes({ ok: false, parameters: { retry_after: 3 } }, 429), () => jsonRes({ ok: true, result: { message_id: 9 } })] });
    expect(await mk(f, sleeps).sendMessage({ text: "a" })).toBe(9);
    expect(sleeps).toContain(3000);
    expect(f.calls).toHaveLength(2);
  });

  it("throws a transient RATE_LIMIT when retry_after is too long", async () => {
    const f = fakeFetch({ "/sendMessage": () => jsonRes({ ok: false, parameters: { retry_after: 120 } }, 429) });
    const err = await mk(f).sendMessage({ text: "a" }).catch((e) => e);
    expect(err).toBeInstanceOf(TelegramError);
    expect(err.kind).toBe("RATE_LIMIT");
    expect(err.transient).toBe(true);
    expect(err.retryAfterMs).toBe(120000);
  });

  it("never puts the token in an error message", async () => {
    const f = fakeFetch({ "/sendMessage": () => jsonRes({ ok: false, description: "Bad Request: chat not found" }, 400) });
    const err = await mk(f).sendMessage({ text: "a" }).catch((e) => e);
    expect(err.kind).toBe("BAD_REQUEST");
    expect(String(err.message)).not.toContain("TOK");
  });

  it("does not resend a message after a timeout (could double-send)", async () => {
    let n = 0;
    const f = (async () => { n++; throw Object.assign(new Error("t"), { name: "TimeoutError" }); }) as unknown as typeof fetch;
    await mk(f).sendMessage({ text: "a" }).catch(() => undefined);
    expect(n).toBe(1);
  });

  it("builds a webhook body with the secret token", () => {
    const b = buildSetWebhookBody("https://x.example/tg/webhook", "abcdefghijklmnop1234");
    expect(b.secret_token).toBe("abcdefghijklmnop1234");
    expect(b.allowed_updates).toEqual(["message", "callback_query"]);
    expect(() => buildSetWebhookBody("http://x", "abcdefghijklmnop1234")).toThrow();
  });
});
