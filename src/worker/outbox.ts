/**
 * Drains the outbound queue by priority (FR-5.4, FR-5.8). Pacing (about one
 * message a second) is done inside TelegramApi. Transient failures leave the
 * message queued; permanent ones drop it so a bad message cannot block the queue.
 *
 * Message-id bookkeeping (the core only queues events):
 *  - FIRST_ALERT / LATE_ALERT / REMINDER: after sending, the new message id is
 *    stored in the rule state's lastMessageId (needed for ack edit and tidy-up);
 *  - REMINDER with the tidy-up setting on (FR-4.12): the previous message is deleted;
 *  - ACK_CONFIRM with a known message: the original message is edited, not re-sent.
 */
import { TelegramError } from "../adapters/telegram";
import type { D1Store } from "../adapters/d1store";
import type { Notifier, OutboundEvent, RuleState, TradingDate } from "../core/ports";

export interface DrainResult {
  sent: number;
  dropped: number;
  stoppedOn?: string;
}

async function recordMessageId(store: D1Store, r: RuleState, id: number): Promise<void> {
  for (let i = 0; i < 2; i++) {
    const cur = await store.getRuleState(r.date, r.symbol, r.rule);
    if (!cur || cur.cycle !== r.cycle) return;
    if (await store.putRuleState({ ...cur, lastMessageId: id, version: cur.version + 1 }, cur.version)) return;
  }
}

async function deliver(store: D1Store, notifier: Notifier, ev: OutboundEvent): Promise<void> {
  if (ev.type === "ACK_CONFIRM" && ev.rule.lastMessageId) {
    try {
      await notifier.edit(ev.rule.lastMessageId, ev);
      return;
    } catch (e) {
      if (e instanceof TelegramError && e.transient) throw e;
      // message too old / deleted: fall through and send a fresh confirmation
    }
  }
  const id = await notifier.send(ev);
  if (ev.type === "FIRST_ALERT" || ev.type === "LATE_ALERT") await recordMessageId(store, ev.rule, id).catch(() => undefined);
  else if (ev.type === "REMINDER") {
    const tidy = (await store.getSettings().catch(() => null))?.reminderTidyUp ?? true;
    for (const r of ev.rules) {
      if (tidy && r.lastMessageId) await notifier.delete(r.lastMessageId).catch(() => undefined);
      await recordMessageId(store, r, id).catch(() => undefined);
    }
  }
}

export async function drainOutbound(store: D1Store, notifier: Notifier, date: TradingDate, nowMs: number, max = 3): Promise<DrainResult> {
  const items = await store.dequeueBatch(max);
  const res: DrainResult = { sent: 0, dropped: 0 };
  for (const it of items) {
    try {
      await deliver(store, notifier, it.event);
      await store.markSent(it.id);
      res.sent++;
    } catch (e) {
      if (e instanceof TelegramError && e.transient) {
        res.stoppedOn = e.kind;
        await store.bumpAttempts(it.id).catch(() => undefined);
        break;
      }
      await store.markSent(it.id).catch(() => undefined); // permanent failure: do not retry forever
      res.dropped++;
      await store
        .log([{ tMs: nowMs, kind: "ERROR", detail: { what: "telegram_send_dropped", queueId: it.id, kind: e instanceof TelegramError ? e.kind : "UNKNOWN" } }])
        .catch(() => undefined);
    }
  }
  if (res.sent || res.dropped || res.stoppedOn) {
    await store.bumpCounters(date, { tg_sent: res.sent, tg_failed: res.dropped + (res.stoppedOn ? 1 : 0) }).catch(() => undefined);
  }
  return res;
}
