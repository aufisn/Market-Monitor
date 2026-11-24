/**
 * Cron entry logic (FR-1.5, FR-3.8, FR-4.11, FR-5.8, S-9).
 *
 * One scheduled invocation = up to 5 polls about 12 s apart, stopping before
 * ~50 s. The engine takes its own lease ("run", 50 s) around every tick, so
 * overlapping invocations cannot both act. The loop stops early when the call
 * budget (45 per invocation, PRD 1c) cannot fit another tick.
 */
import * as core from "../core/engine";
import { nyDate, realSleep } from "../adapters/util";
import { buildCtx, missingSecrets, type Ctx, type Deps, type Env } from "./env";
import { drainOutbound } from "./outbox";
import { renderPlaceholder } from "../adapters/render-placeholder";

export const WORK_START_UTC_HOUR = 11; // 07:00 ET (EDT) / 06:00 ET (EST), the earliest pre-open work
export const WORK_END_UTC_HOUR = 22; // exclusive: covers SESSION ENDED after a 16:00 ET close in both clock settings

/** Cheap gate: weekday and UTC hour only (no Intl, no I/O). */
export function inWorkingWindow(ms: number): boolean {
  const d = new Date(ms);
  const dow = d.getUTCDay();
  const h = d.getUTCHours();
  return dow >= 1 && dow <= 5 && h >= WORK_START_UTC_HOUR && h < WORK_END_UTC_HOUR;
}

export interface EngineApi {
  runScheduled(ports: { store: Ctx["store"]; market: Ctx["market"] }, nowMs: number): Promise<{ status: string }>;
}

export interface ScheduledDeps extends Deps {
  engine?: EngineApi;
  pollIntervalMs?: number;
  maxPolls?: number;
  /** Do not START a poll later than this many ms after the run began. */
  startCutoffMs?: number;
}

const STOP_STATUSES = new Set(["idle", "skipped", "expired", "pre_open", "closing", "error"]);

export interface RunReport {
  ran: boolean;
  reason?: string;
  polls: number;
  calls: number;
}

export async function runScheduledJob(env: Env, deps: ScheduledDeps = {}): Promise<RunReport> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  if (!inWorkingWindow(t0)) return { ran: false, reason: "outside-window", polls: 0, calls: 0 }; // <1 ms exit

  const missing = missingSecrets(env);
  if (missing.length > 0) {
    await failSafe(env, missing, deps);
    return { ran: false, reason: "missing-secrets", polls: 0, calls: 0 };
  }

  const ctx = buildCtx(env, { ...deps, now });
  // The scheduled loop re-reads settings/watchlist at most every 25 s to save calls.
  const engine: EngineApi = deps.engine ?? core;
  const sleep = deps.sleep ?? realSleep;
  const interval = deps.pollIntervalMs ?? 12_000;
  const maxPolls = deps.maxPolls ?? 5;
  const cutoff = deps.startCutoffMs ?? 50_000;
  const ports = { store: ctx.store, market: ctx.market };

  await dailyPurge(ctx, t0);

  let polls = 0;
  let lastCost = 3;
  let lastD1Cost = 8;
  for (let i = 0; i < maxPolls; i++) {
    const start = now();
    if (i > 0 && start - t0 > cutoff) break;
    const before = ctx.counter.used;
    const beforeD1 = ctx.d1counter.used;
    let status = "error";
    try {
      status = (await engine.runScheduled(ports, start)).status;
      polls++;
    } catch (e) {
      console.error("tick failed", (e as { name?: string })?.name ?? "unknown"); // name only, never message text
      await ctx.store.log([{ tMs: start, kind: "ERROR", detail: { what: "tick_failed", name: (e as { name?: string })?.name ?? "unknown" } }]).catch(() => undefined);
    }
    // Send what the engine queued (alerts first by priority); first tick always checks for backlog.
    if (status !== "idle" && status !== "expired" && (i === 0 || ctx.store.queueDirty)) {
      try {
        await drainOutbound(ctx.store, ctx.notifier, nyDate(start), start, 3);
      } catch (e) {
        console.error("drain failed", (e as { name?: string })?.name ?? "unknown");
      }
    }
    lastCost = Math.max(lastCost, ctx.counter.used - before);
    lastD1Cost = Math.max(lastD1Cost, ctx.d1counter.used - beforeD1);
    if (STOP_STATUSES.has(status)) break;
    if (ctx.counter.remaining < lastCost + 2 || ctx.d1counter.remaining < lastD1Cost + 2) break; // budget guard: fetches and D1 queries counted separately
    const next = t0 + (i + 1) * interval;
    if (next - t0 > cutoff) break;
    const wait = next - now();
    if (wait > 0) await sleep(wait);
  }
  return { ran: true, polls, calls: ctx.counter.used + ctx.d1counter.used };
}

async function dailyPurge(ctx: Ctx, t0: number): Promise<void> {
  const d = new Date(t0);
  if (d.getUTCHours() !== WORK_START_UTC_HOUR || d.getUTCMinutes() >= 5) return;
  try {
    const day = d.toISOString().slice(0, 10);
    if ((await ctx.store.getMeta("purge_day")) === day) return;
    await ctx.store.purgeOld(t0); // FR-11.2
    await ctx.store.setMeta("purge_day", day);
  } catch {
    /* optional work: never block alerting */
  }
}

/** S-9: missing secrets stop alerting and produce ONE clear notice per day (names only, never values). */
async function failSafe(env: Env, missing: string[], deps: ScheduledDeps): Promise<void> {
  console.error("missing secrets:", missing.join(", "));
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    const ctx = buildCtx(env, deps);
    const day = new Date(ctx.now()).toISOString().slice(0, 10);
    if ((await ctx.store.getMeta("notice_secrets_day")) === day) return;
    await ctx.store.setMeta("notice_secrets_day", day);
    await ctx.telegram.sendMessage(renderPlaceholder({ type: "OPS_NOTICE", code: "MISSING_SECRETS", detail: `Alerting is stopped. Missing settings: ${missing.join(", ")}` }));
  } catch {
    /* nothing more we can do */
  }
}
