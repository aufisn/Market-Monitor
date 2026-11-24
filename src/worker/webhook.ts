/**
 * POST /tg/webhook (FR-5.2, FR-5.3, S-4, AT-20).
 *
 *  - wrong or missing X-Telegram-Bot-Api-Secret-Token -> 401, no body, nothing processed
 *  - any chat other than TELEGRAM_CHAT_ID -> 200, silently ignored (no reply, no log of content)
 *  - callback queries are answered within the same request so the button stops spinning
 */
import { decodeCallback } from "../adapters/callbacks";
import { renderReply } from "../adapters/render-placeholder";
import { constantTimeEqual } from "../adapters/util";
import { applyAck, runIntent, setMute } from "./actions";
import type { Ctx } from "./env";
import { parseCommand } from "./intents";
import { ApiError } from "./validate";

const MAX_BODY = 65_536;
const empty = (status: number): Response => new Response(null, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });

interface TgUpdate {
  update_id?: number;
  message?: { chat?: { id?: number | string }; text?: string };
  callback_query?: { id?: string; data?: string; from?: { id?: number | string }; message?: { message_id?: number; chat?: { id?: number | string } } };
}

export async function handleWebhook(request: Request, ctx: Ctx): Promise<Response> {
  if (request.method !== "POST") return empty(405);
  const secret = ctx.env.TELEGRAM_WEBHOOK_SECRET;
  const chatId = ctx.env.TELEGRAM_CHAT_ID;
  const supplied = request.headers.get("x-telegram-bot-api-secret-token");
  // Fail safe (S-9): without a configured secret nothing is accepted.
  if (!secret || !chatId || !supplied || supplied.length > 256 || !(await constantTimeEqual(supplied, secret))) return empty(401);

  const len = Number(request.headers.get("content-length"));
  if (Number.isFinite(len) && len > MAX_BODY) return empty(413);
  let update: TgUpdate;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return empty(413);
    update = JSON.parse(raw) as TgUpdate;
  } catch {
    return empty(400);
  }
  if (typeof update !== "object" || update === null) return empty(400);

  const msgChat = update.message?.chat?.id;
  const cb = update.callback_query;
  const cbChat = cb?.message?.chat?.id;
  // A callback_query may arrive without a message (Bot API 10.5): fall back to the sender id (same as the chat id in a private chat).
  const fromChat = msgChat ?? cbChat ?? cb?.from?.id;
  if (fromChat === undefined || String(fromChat) !== String(chatId)) return empty(200); // silent ignore

  // Telegram redelivers when we are slow: skip updates already handled.
  if (typeof update.update_id === "number") {
    const last = Number((await ctx.store.getMeta("last_update_id")) ?? -1);
    if (update.update_id <= last) return empty(200);
    await ctx.store.setMeta("last_update_id", String(update.update_id));
  }

  try {
    if (cb && typeof cb.id === "string") await handleCallback(ctx, cb);
    else if (typeof update.message?.text === "string") {
      const intent = parseCommand(update.message.text);
      if (intent) {
        const reply = await runIntent(ctx, intent);
        if (intent.type !== "test") await ctx.telegram.sendMessage(renderReply(reply));
      }
    }
  } catch (e) {
    console.error("webhook error", (e as { name?: string })?.name ?? "unknown"); // name only: never message text
  }
  return empty(200);
}

async function handleCallback(ctx: Ctx, cb: NonNullable<TgUpdate["callback_query"]>): Promise<void> {
  const id = cb.id as string;
  const action = decodeCallback(cb.data);
  const msgId = cb.message?.message_id;
  let answer = "Not understood";
  try {
    if (action?.type === "ack") {
      if (action.symbol === "TEST") {
        answer = "Test acknowledged";
        if (msgId) await ctx.telegram.editMessageReplyMarkup(msgId, null).catch(() => undefined);
      } else {
        const done = await applyAck(ctx, { symbol: action.symbol, rule: action.rule, cycle: action.cycle }, "telegram");
        answer = done ? "Acknowledged" : "Already acknowledged";
        // Remove the stale keyboard even when the state had already changed.
        if (!done && msgId) await ctx.telegram.editMessageReplyMarkup(msgId, null).catch(() => undefined);
      }
    } else if (action?.type === "ackall") {
      const done = await applyAck(ctx, { all: true }, "ackall");
      answer = done ? `Acknowledged ${done}` : "Nothing to acknowledge";
    } else if (action?.type === "mute") {
      await setMute(ctx, action.symbol, action.minutes);
      answer = `${action.symbol} muted ${action.minutes} min`;
    } else if (action?.type === "ackmove") {
      answer = "Not available yet"; // FR-4.7 is P1
    }
  } catch (e) {
    answer = e instanceof ApiError ? e.message.slice(0, 100) : "Error";
  }
  await ctx.telegram.answerCallbackQuery(id, answer).catch(() => undefined);
}
