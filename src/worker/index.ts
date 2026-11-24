/** Worker entry: scheduled() polls, fetch() serves webhook, dashboard API and health; the rest is static assets. */
import { handleApi } from "./api";
import { buildCtx, missingSecrets, type Deps, type Env } from "./env";
import { API_HEADERS, json } from "./http";
import { runScheduledJob, inWorkingWindow } from "./scheduled";
import { handleWebhook } from "./webhook";

export async function handleFetch(request: Request, env: Env, deps: Deps = {}): Promise<Response> {
  const url = new URL(request.url);
  const p = url.pathname;

  if (p === "/health") {
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
    if (!env.DB) return json({ ok: false }, 503);
    // Only the last poll time: no symbols, prices or alert data (FR-10.2).
    const ctx = buildCtx(env, { ...deps });
    const last = await ctx.store.getLastSuccessfulPollMs().catch(() => null);
    return json({ ok: last !== null, lastPollMs: last, ageSec: last === null ? null : Math.max(0, Math.round((ctx.now() - last) / 1000)), configured: missingSecrets(env).length === 0 });
  }

  if (p === "/tg/webhook") {
    if (missingSecrets(env).length > 0 && (!env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_CHAT_ID || !env.TELEGRAM_BOT_TOKEN || !env.DB)) {
      return new Response(null, { status: 401, headers: { "cache-control": "no-store" } });
    }
    return handleWebhook(request, buildCtx(env, { ...deps }, 0));
  }

  if (p === "/api" || p.startsWith("/api/")) {
    if (!env.DB) return json({ error: "NOT_CONFIGURED", message: "Database is not connected." }, 503);
    return handleApi(request, buildCtx(env, { ...deps }, 0), url);
  }

  // Everything else is the static dashboard shell (FR-8.1). In production it never reaches here
  // (run_worker_first is limited to /api/*, /tg/* and /health); this keeps `wrangler dev` working.
  if (env.ASSETS) return env.ASSETS.fetch(request);
  return new Response("Not found", { status: 404, headers: API_HEADERS });
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (!inWorkingWindow(Date.now())) return; // fast exit, no allocation
    await runScheduledJob(env);
  },
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleFetch(request, env);
    } catch (e) {
      console.error("fetch failed", (e as { name?: string })?.name ?? "unknown");
      return json({ error: "INTERNAL", message: "Something went wrong on the server." }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
