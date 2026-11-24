/**
 * POST /tg/webhook (FR-5.2, FR-5.3, S-4, AT-20).
 *
 *  - wrong or missing X-Telegram-Bot-Api-Secret-Token -> 401, no body, nothing processed
 *  - any chat other than TELEGRAM_CHAT_ID -> 200, silently ignored (no reply, no log of content)
 *  - callback queries are answered within the same request so the button stops spinning
 */
import { decodeCallback } from "../adapters/callbacks";
import { f2 } from "../adapters/glance-fmt";
import { renderOk, renderText } from "../adapters/render-commands";
import { constantTimeEqual } from "../adapters/util";
import { ackAndMove } from "./ackmove";
import { handleButton, PENDING_MOVE_KEY, readPendingMove } from "./buttons";
import { runCommand } from "./commands";
import type { Ctx } from "./env";
import { parseCommand, parseMoveInput } from "./intents";
import { ApiError } from "./validate";

const MAX_BODY = 65_536;
const empty = (status: number): Response => new Response(null, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });

interface TgUpdate {
  update_id?: number;
  message?: { chat?: { id?: number | string }; text?: string; reply_to_message?: { message_id?: number; text?: string } };
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
    else if (typeof update.message?.text === "string") await handleMessage(ctx, update.message as { text: string; reply_to_message?: { message_id?: number; text?: string } });
  } catch (e) {
    console.error("webhook error", (e as { name?: string })?.name ?? "unknown"); // name only: never message text
  }
  return empty(200);
}

async function handleMessage(ctx: Ctx, msg: { text: string; reply_to_message?: { message_id?: number; text?: string } }): Promise<void> {
  // A reply to the "Type a value" prompt finishes an Ack + move.
  const replyTo = msg.reply_to_message?.message_id;
  if (replyTo !== undefined && !msg.text.startsWith("/")) {
    const pending = await readPendingMove(ctx);
    if (pending && pending.promptId === replyTo) {
      const parsed = parseMoveInput(msg.text);
      if (!parsed) {
        await ctx.telegram.sendMessage(renderText("Not understood. Send a price like 148.00 or a percent like +3%."));
        return;
      }
      const r = await ackAndMove(ctx, pending.symbol, pending.rule, parsed, { cycle: pending.cycle, messageId: pending.messageId });
      if (r.ok) {
        await ctx.store.setMeta(PENDING_MOVE_KEY, "");
        await ctx.telegram.sendMessage(renderOk(pending.symbol, `${pending.rule} moved`, [`${f2(r.from)} → ${f2(r.to)}. Re-armed.`]));
      } else {
        if (r.kind === "STALE") await ctx.store.setMeta(PENDING_MOVE_KEY, "");
        await ctx.telegram.sendMessage(renderText(r.reason)); // an input problem keeps the prompt open for another try
      }
      return;
    }
    // A reply to one of our prompts that is no longer the live one (expired or replaced).
    if (msg.reply_to_message?.text?.startsWith("⌨ Reply with the new ")) {
      await ctx.telegram.sendMessage(renderText("That prompt expired. Tap Ack + move again."));
      return;
    }
  }
  const intent = parseCommand(msg.text);
  if (!intent) return;
  const reply = await runCommand(ctx, intent);
  if (reply) await ctx.telegram.sendMessage(reply);
}

async function handleCallback(ctx: Ctx, cb: NonNullable<TgUpdate["callback_query"]>): Promise<void> {
  const id = cb.id as string;
  const action = decodeCallback(cb.data);
  let answer = "Not understood";
  try {
    if (action) answer = await handleButton(ctx, action, cb.message?.message_id);
  } catch (e) {
    answer = e instanceof ApiError ? e.message.slice(0, 100) : "Error";
  }
  await ctx.telegram.answerCallbackQuery(id, answer).catch(() => undefined);
}
