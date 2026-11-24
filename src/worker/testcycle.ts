/**
 * Test cycle (FR-13.1): /test and POST /api/test run a real-path TEST alert with a reminder every minute,
 * acknowledge by button or /ack TEST, and an automatic stop after 10 reminders.
 *
 * Isolation: the whole state is ONE run_meta row ("test_cycle"). Nothing here touches rule_state, alert ids,
 * the log, counters, the outbound queue or the briefing, so a test can never count as a real alert.
 * The scheduled handler drives the reminders before the engine runs, so it works at any hour the cron runs.
 */
import { renderTestAck, renderTestEnded, renderTestReminder } from "../adapters/render-glance";
import type { Ctx } from "./env";

export const TEST_KEY = "test_cycle";
export const TEST_INTERVAL_MS = 60_000;
export const TEST_MAX_REMINDERS = 10;

export interface TestCycle {
  startMs: number;
  lastId: number; // newest message of the cycle (the one that carries the Acknowledge button)
  n: number; // reminders sent so far
  nextMs: number;
}

export async function readTestCycle(ctx: Ctx): Promise<TestCycle | null> {
  try {
    const raw = await ctx.store.getMeta(TEST_KEY);
    const c = raw ? (JSON.parse(raw) as TestCycle) : null;
    return c && typeof c.lastId === "number" && typeof c.nextMs === "number" && typeof c.n === "number" ? c : null;
  } catch {
    return null;
  }
}

const save = (ctx: Ctx, c: TestCycle | null): Promise<void> => ctx.store.setMeta(TEST_KEY, c ? JSON.stringify(c) : "");

/** Starts (or restarts) a test cycle: sends the first TEST alert now. */
export async function startTestCycle(ctx: Ctx): Promise<void> {
  const old = await readTestCycle(ctx);
  if (old) await ctx.telegram.editMessageReplyMarkup(old.lastId, null).catch(() => undefined); // the old test is over
  const now = ctx.now();
  const id = await ctx.notifier.send({ type: "TEST_ALERT" });
  await save(ctx, { startMs: now, lastId: id, n: 0, nextMs: now + TEST_INTERVAL_MS });
}

/** Called by the scheduled handler on every run, before the engine. Cheap when no test is running (one read). */
export async function driveTestCycle(ctx: Ctx, nowMs: number): Promise<void> {
  const c = await readTestCycle(ctx);
  if (!c || nowMs < c.nextMs || ctx.counter.remaining < 6) return;
  if (c.n >= TEST_MAX_REMINDERS) {
    await ctx.telegram.sendMessage(renderTestEnded(nowMs));
    await save(ctx, null);
    return;
  }
  const n = c.n + 1;
  const id = await ctx.telegram.sendMessage(renderTestReminder(n, nowMs, ctx.dashboardUrl));
  await ctx.telegram.deleteMessage(c.lastId).catch(() => undefined); // tidy-up (FR-4.12): only the newest message stays
  await save(ctx, { ...c, lastId: id, n, nextMs: c.startMs + (n + 1) * TEST_INTERVAL_MS });
}

/** Acknowledge the running test (button, /ack TEST). Returns false when none is running. */
export async function ackTestCycle(ctx: Ctx, messageId?: number): Promise<boolean> {
  const c = await readTestCycle(ctx);
  if (!c) return false;
  await save(ctx, null);
  await ctx.telegram.editMessageText(c.lastId, renderTestAck(ctx.now())).catch(() => undefined);
  if (messageId !== undefined && messageId !== c.lastId) await ctx.telegram.editMessageReplyMarkup(messageId, null).catch(() => undefined);
  return true;
}
