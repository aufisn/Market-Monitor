/**
 * Telegram Bot API transport (FR-5.1, FR-5.3, FR-5.4). Transport only: it
 * accepts pre-rendered {text, buttons}; production wording is gated by DG-3.
 *
 * The bot token appears only in the request URL path (as Telegram requires)
 * and is never copied into errors or logs.
 */
import type { Notifier, OutboundEvent } from "../core/ports";
import { CallCounter, escapeHtml, realSleep, type Sleep } from "./util";

export { escapeHtml };

export interface Button {
  text: string;
  /** callback_data (max 64 bytes) -- see callbacks.ts. */
  data?: string;
  url?: string;
}
export interface Rendered {
  text: string; // HTML parse mode; dynamic parts must go through escapeHtml
  buttons?: Button[][];
  silent?: boolean; // disable_notification
  /** Send as a reply to this message id (Details card). */
  replyTo?: number;
  /** Ask the chat to reply to this message (ForceReply); the value is the input placeholder. Replaces any buttons. */
  forceReply?: string;
}

export type TelegramErrorKind = "AUTH" | "RATE_LIMIT" | "BAD_REQUEST" | "SERVER" | "TIMEOUT" | "NETWORK";

export class TelegramError extends Error {
  override name = "TelegramError";
  constructor(readonly kind: TelegramErrorKind, message: string, readonly status?: number, readonly retryAfterMs?: number) {
    super(message);
  }
  /** Worth keeping in the queue and trying again later. */
  get transient(): boolean {
    return this.kind === "RATE_LIMIT" || this.kind === "SERVER" || this.kind === "TIMEOUT" || this.kind === "NETWORK";
  }
}

export interface TelegramConfig {
  token: string;
  chatId: string;
  fetch?: typeof fetch;
  sleep?: Sleep;
  now?: () => number;
  timeoutMs?: number; // default 5000
  maxRetryWaitMs?: number; // longest retry_after honoured inside a run, default 8000
  minSendGapMs?: number; // spacing between sends to one chat, default 1000 (FR-5.4)
  counter?: CallCounter;
}

const MAX_TEXT = 4096;

export class TelegramApi {
  private readonly f: typeof fetch;
  private readonly sleep: Sleep;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maxWait: number;
  private readonly gap: number;
  private lastSendAt = -Infinity;

  constructor(private readonly cfg: TelegramConfig) {
    this.f = cfg.fetch ?? ((i, init) => fetch(i, init));
    this.sleep = cfg.sleep ?? realSleep;
    this.now = cfg.now ?? Date.now;
    this.timeoutMs = cfg.timeoutMs ?? 5000;
    this.maxWait = cfg.maxRetryWaitMs ?? 8000;
    this.gap = cfg.minSendGapMs ?? 1000;
  }

  /** Returns the new message id. */
  async sendMessage(r: Rendered): Promise<number> {
    await this.pace();
    const res = await this.call<{ message_id: number }>("sendMessage", {
      chat_id: this.cfg.chatId,
      ...body(r),
      ...(r.silent ? { disable_notification: true } : {}),
    }, false);
    this.lastSendAt = this.now();
    return res.message_id;
  }

  async editMessageText(messageId: number, r: Rendered): Promise<void> {
    await this.call("editMessageText", { chat_id: this.cfg.chatId, message_id: messageId, ...body(r), reply_markup: markup(r.buttons) ?? { inline_keyboard: [] } }, true);
  }

  /** Pass null to remove the keyboard. */
  async editMessageReplyMarkup(messageId: number, buttons: Button[][] | null): Promise<void> {
    await this.call("editMessageReplyMarkup", { chat_id: this.cfg.chatId, message_id: messageId, reply_markup: (buttons && markup(buttons)) || { inline_keyboard: [] } }, true);
  }

  async deleteMessage(messageId: number): Promise<void> {
    try {
      await this.call("deleteMessage", { chat_id: this.cfg.chatId, message_id: messageId }, true);
    } catch (e) {
      // already deleted / too old: nothing more to do
      if (e instanceof TelegramError && e.kind === "BAD_REQUEST") return;
      throw e;
    }
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    try {
      await this.call("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text: text.slice(0, 200) } : {}) }, true);
    } catch (e) {
      if (e instanceof TelegramError && e.kind === "BAD_REQUEST") return; // query too old
      throw e;
    }
  }

  async setWebhook(url: string, secretToken: string): Promise<void> {
    await this.call("setWebhook", buildSetWebhookBody(url, secretToken), true);
  }

  // ------------------------------------------------------------ plumbing
  private async pace(): Promise<void> {
    const wait = this.lastSendAt + this.gap - this.now();
    if (wait > 0) await this.sleep(wait);
  }

  /** `idempotent`: safe to repeat after a timeout/5xx (not for sendMessage: could double-send). */
  private async call<T = unknown>(method: string, payload: unknown, idempotent: boolean): Promise<T> {
    const url = `https://api.telegram.org/bot${this.cfg.token}/${method}`;
    let lastErr: TelegramError | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      this.cfg.counter?.spend();
      let res: Response;
      try {
        res = await this.f(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        const n = (e as { name?: string } | null)?.name;
        lastErr = new TelegramError(n === "TimeoutError" || n === "AbortError" ? "TIMEOUT" : "NETWORK", `telegram ${method} did not complete`);
        if (attempt === 0 && idempotent) { await this.sleep(300); continue; }
        throw lastErr;
      }
      let j: { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } } = {};
      try { j = await res.json(); } catch { /* non-JSON body */ }
      if (res.ok && j.ok !== false) return j.result as T;
      const st = res.status;
      const desc = typeof j.description === "string" ? j.description : "";
      if (st === 429) {
        const ra = Number(j.parameters?.retry_after ?? res.headers.get("retry-after"));
        const wait = (Number.isFinite(ra) && ra > 0 ? ra : 1) * 1000;
        lastErr = new TelegramError("RATE_LIMIT", "telegram rate limit", st, wait);
        if (attempt === 0 && wait <= this.maxWait) { await this.sleep(wait); continue; }
        throw lastErr;
      }
      if (st === 401 || st === 403 || st === 404) throw new TelegramError("AUTH", `telegram refused the bot credentials or chat (HTTP ${st})`, st);
      if (st === 400 && /message is not modified/i.test(desc)) return undefined as T;
      if (st >= 500) {
        lastErr = new TelegramError("SERVER", `telegram server error (HTTP ${st})`, st);
        if (attempt === 0 && idempotent) { await this.sleep(500); continue; }
        throw lastErr;
      }
      throw new TelegramError("BAD_REQUEST", `telegram rejected ${method}: ${desc.slice(0, 120)}`, st);
    }
    throw lastErr ?? new TelegramError("NETWORK", `telegram ${method} failed`);
  }
}

/** Builds the setWebhook request body (FR-5.2). Only callback_query and message updates are wanted. */
export function buildSetWebhookBody(url: string, secretToken: string): Record<string, unknown> {
  if (!/^https:\/\//.test(url)) throw new Error("webhook url must be https");
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(secretToken)) throw new Error("webhook secret must be 16-256 chars of A-Z a-z 0-9 _ -");
  return { url, secret_token: secretToken, allowed_updates: ["message", "callback_query"], drop_pending_updates: false, max_connections: 2 };
}

function body(r: Rendered): Record<string, unknown> {
  const text = r.text.length > MAX_TEXT ? r.text.slice(0, MAX_TEXT - 1) + "…" : r.text;
  const rm = r.forceReply !== undefined
    ? { force_reply: true, input_field_placeholder: r.forceReply.slice(0, 64), selective: false }
    : markup(r.buttons);
  return {
    text, parse_mode: "HTML", link_preview_options: { is_disabled: true },
    ...(r.replyTo !== undefined ? { reply_parameters: { message_id: r.replyTo, allow_sending_without_reply: true } } : {}),
    ...(rm ? { reply_markup: rm } : {}),
  };
}

export function markup(buttons?: Button[][]): { inline_keyboard: unknown[][] } | undefined {
  if (!buttons || buttons.length === 0) return undefined;
  const rows = buttons
    .map((row) => row.filter((b) => b.data || b.url).map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data })))
    .filter((row) => row.length > 0);
  return rows.length ? { inline_keyboard: rows } : undefined;
}

/** Notifier port over the transport; wording comes from an injected renderer. */
export class TelegramNotifier implements Notifier {
  constructor(private readonly api: TelegramApi, private readonly render: (e: OutboundEvent) => Rendered) {}
  send(event: OutboundEvent): Promise<number> {
    return this.api.sendMessage(this.render(event));
  }
  edit(messageId: number, event: OutboundEvent): Promise<void> {
    return this.api.editMessageText(messageId, this.render(event));
  }
  delete(messageId: number): Promise<void> {
    return this.api.deleteMessage(messageId);
  }
}
