/** Worker environment, secret names, and wiring of adapters. */
import { AlpacaMarketData } from "../adapters/alpaca";
import { D1Store } from "../adapters/d1store";
import { GlanceNotifier } from "../adapters/glance-notifier";
import { cleanDashboardUrl } from "../adapters/glance-fmt";
import { TelegramApi } from "../adapters/telegram";
import { CallCounter, type Sleep } from "../adapters/util";

export const APP_VERSION = "0.1.0";

/** Secret NAMES only (values live in the Worker secret store / git-ignored .dev.vars). */
export const REQUIRED_SECRETS = [
  "ALPACA_KEY_ID",
  "ALPACA_SECRET_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_WEBHOOK_SECRET",
  "DASHBOARD_ACCESS_CODE",
] as const;

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ALPACA_KEY_ID?: string;
  ALPACA_SECRET_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  DASHBOARD_ACCESS_CODE?: string;
  FINNHUB_API_KEY?: string;
  /** Non-secret public https address of the dashboard (wrangler.toml [vars]); empty hides the button. */
  DASHBOARD_URL?: string;
}

export interface Deps {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: Sleep;
}

export interface Ctx {
  env: Env;
  store: D1Store;
  market: AlpacaMarketData;
  telegram: TelegramApi;
  notifier: GlanceNotifier;
  /** Validated DASHBOARD_URL or undefined. */
  dashboardUrl?: string;
  /** outbound fetches (limit 45 of 50) */
  counter: CallCounter;
  /** D1 queries; a db.batch() counts once (limit 45 of 50) */
  d1counter: CallCounter;
  now: () => number;
  sleep?: Sleep;
}

export function missingSecrets(env: Env): string[] {
  const out: string[] = REQUIRED_SECRETS.filter((k) => typeof env[k] !== "string" || (env[k] as string).length === 0);
  if (!env.DB) out.push("DB");
  return out;
}

export function buildCtx(env: Env, deps: Deps = {}, cacheTtlMs = 25_000): Ctx {
  const now = deps.now ?? Date.now;
  const counter = new CallCounter(45);
  const d1counter = new CallCounter(45);
  const store = new D1Store(env.DB, { now, counter: d1counter, cacheTtlMs });
  const market = new AlpacaMarketData({
    keyId: env.ALPACA_KEY_ID ?? "",
    secretKey: env.ALPACA_SECRET_KEY ?? "",
    fetch: deps.fetch,
    sleep: deps.sleep,
    now,
    counter,
  });
  const telegram = new TelegramApi({
    token: env.TELEGRAM_BOT_TOKEN ?? "",
    chatId: env.TELEGRAM_CHAT_ID ?? "",
    fetch: deps.fetch,
    sleep: deps.sleep,
    now,
    counter,
  });
  const dashboardUrl = cleanDashboardUrl(env.DASHBOARD_URL);
  // DG-3: Alternative A "Glance Line".
  const notifier = new GlanceNotifier(telegram, {
    now,
    dashboardUrl,
    loadContext: async () => ({ stocks: await store.listStocks(), baselines: await store.getBaselines() }),
  });
  return { env, store, market, telegram, notifier, dashboardUrl, counter, d1counter, now, sleep: deps.sleep };
}
