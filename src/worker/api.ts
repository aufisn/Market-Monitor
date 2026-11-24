/** Dashboard JSON API under /api/* (FR-8, FR-2.6, FR-11.4). Same-origin only, Bearer access code. */
import { nyDate } from "../adapters/util";
import { DEFAULT_SETTINGS, type LogKind, type RuleKind } from "../core/ports";
import { applyAck, removeStock, saveStock, setMute } from "./actions";
import { authenticate } from "./auth";
import { APP_VERSION, type Ctx } from "./env";
import { errorResponse, json, readJson, text } from "./http";
import { ApiError, MAX_STOCKS, validateSettings, validateSettingsPartial, validateStockInput, validateSymbol } from "./validate";

const LOG_KINDS: readonly LogKind[] = ["FIRST_ALERT", "REMINDER", "ACK", "LATE_ALERT", "SETTINGS_CHANGE", "ERROR", "SUPPRESSED", "HEALTH"];
const RULES: readonly RuleKind[] = ["HIGH", "LOW", "VOLUME"];

function allow(method: string, ...ok: string[]): void {
  if (!ok.includes(method)) throw new ApiError(405, "METHOD_NOT_ALLOWED", `Use ${ok.join(" or ")}.`);
}

export async function handleApi(request: Request, ctx: Ctx, url: URL): Promise<Response> {
  const denied = await authenticate(request, ctx);
  if (denied) return denied;
  try {
    return await route(request, ctx, url);
  } catch (e) {
    if (!(e instanceof ApiError)) console.error("api error", (e as { name?: string })?.name ?? "unknown");
    return errorResponse(e);
  }
}

async function route(request: Request, ctx: Ctx, url: URL): Promise<Response> {
  const m = request.method;
  const path = url.pathname.replace(/\/+$/, "");
  const now = ctx.now();

  if (path === "/api/state") {
    allow(m, "GET");
    const date = nyDate(now);
    const snap = await ctx.store.dashboardSnapshot(date);
    return json({ version: APP_VERSION, serverTimeMs: now, date, maxStocks: MAX_STOCKS, ...snap });
  }

  if (path === "/api/stocks") {
    allow(m, "GET", "POST");
    if (m === "GET") return json({ stocks: await ctx.store.listStocks() });
    const { stock } = await saveStock(ctx, await readJson(request), { mode: "create" });
    return json({ stock }, 201);
  }

  const sm = /^\/api\/stocks\/([^/]+)$/.exec(path);
  if (sm) {
    allow(m, "PUT", "PATCH", "DELETE");
    let rawSym = sm[1] as string;
    try { rawSym = decodeURIComponent(rawSym); } catch { /* validated below */ }
    const symbol = validateSymbol(rawSym);
    if (m === "DELETE") {
      await removeStock(ctx, symbol);
      return json({ ok: true });
    }
    const body = (await readJson(request)) as Record<string, unknown>;
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ApiError(400, "INVALID_INPUT", "body: must be an object");
    const r = await saveStock(ctx, { ...body, symbol }, { mode: "update" });
    return json({ stock: r.stock, rearmed: r.rearmed });
  }

  if (path === "/api/ack") {
    allow(m, "POST");
    const b = (await readJson(request)) as Record<string, unknown>;
    if (typeof b !== "object" || b === null) throw new ApiError(400, "INVALID_INPUT", "body: must be an object");
    if (b.all === true) return json({ acknowledged: await applyAck(ctx, { all: true }, "ackall") });
    const symbol = validateSymbol(b.symbol);
    const rule = b.rule === undefined ? undefined : RULES.includes(b.rule as RuleKind) ? (b.rule as RuleKind) : undefined;
    if (b.rule !== undefined && !rule) throw new ApiError(400, "INVALID_INPUT", "rule: must be HIGH, LOW or VOLUME");
    const cycle = b.cycle === undefined ? undefined : Number(b.cycle);
    if (cycle !== undefined && !Number.isInteger(cycle)) throw new ApiError(400, "INVALID_INPUT", "cycle: must be a whole number");
    const done = await applyAck(ctx, { symbol, rule, cycle }, "dashboard");
    return json({ acknowledged: done });
  }

  if (path === "/api/mute") {
    allow(m, "POST");
    const b = (await readJson(request)) as Record<string, unknown>;
    const minutes = b.minutes === null ? null : Number(b.minutes);
    if (minutes !== null && (!Number.isInteger(minutes) || minutes <= 0 || minutes > 7 * 1440)) throw new ApiError(400, "INVALID_INPUT", "minutes: whole number up to 10080, or null to unmute");
    await setMute(ctx, validateSymbol(b.symbol), minutes);
    return json({ ok: true });
  }

  if (path === "/api/settings") {
    allow(m, "GET", "PUT");
    const cur = await ctx.store.getSettings();
    if (m === "GET") return json({ settings: cur, defaults: DEFAULT_SETTINGS });
    const next = { ...cur, ...validateSettingsPartial(await readJson(request)) };
    await ctx.store.putSettings(next);
    return json({ settings: next });
  }

  if (path === "/api/export") {
    allow(m, "GET");
    // FR-2.6: configuration only. Secrets are never stored in the database, so none can leak here.
    const [settings, stocks] = await Promise.all([ctx.store.getSettings(), ctx.store.listStocks()]);
    return json({ format: "market-monitor-config", version: 1, exportedAt: new Date(now).toISOString(), settings, stocks }, 200, {
      "content-disposition": 'attachment; filename="market-monitor-config.json"',
    });
  }

  if (path === "/api/import") {
    allow(m, "POST");
    const b = (await readJson(request, 262_144)) as Record<string, unknown>;
    if (!b || typeof b !== "object" || b.format !== "market-monitor-config" || b.version !== 1) {
      throw new ApiError(400, "INVALID_INPUT", "This is not a Market Monitor export file (format/version).");
    }
    if (!Array.isArray(b.stocks) || b.stocks.length > MAX_STOCKS) throw new ApiError(400, "INVALID_INPUT", `stocks: list of at most ${MAX_STOCKS}`);
    const seen = new Set<string>();
    const stocks = b.stocks.map((s) => {
      const v = validateStockInput(s);
      if (seen.has(v.symbol)) throw new ApiError(400, "INVALID_INPUT", `duplicate symbol ${v.symbol}`);
      seen.add(v.symbol);
      return v;
    });
    const settings = validateSettings(b.settings ?? {}, DEFAULT_SETTINGS);
    await ctx.store.replaceConfig(settings, stocks);
    return json({ ok: true, stocks: stocks.length });
  }

  if (path === "/api/log") {
    allow(m, "GET");
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? 100) | 0 || 100));
    const beforeRaw = url.searchParams.get("before");
    const before = beforeRaw === null ? undefined : Number(beforeRaw);
    if (before !== undefined && !Number.isFinite(before)) throw new ApiError(400, "INVALID_INPUT", "before: must be a number");
    const kind = url.searchParams.get("kind") ?? undefined;
    if (kind !== undefined && !LOG_KINDS.includes(kind as LogKind)) throw new ApiError(400, "INVALID_INPUT", "kind: unknown");
    const symbolRaw = url.searchParams.get("symbol");
    const rows = await ctx.store.queryLog({ limit, beforeMs: before, kind, symbol: symbolRaw ? validateSymbol(symbolRaw) : undefined });
    if (url.searchParams.get("format") === "csv") {
      const lines = ["time_utc,kind,symbol,rule,detail", ...rows.map((r) => [new Date(r.tMs).toISOString(), r.kind, r.symbol ?? "", r.rule ?? "", JSON.stringify(r.detail)].map(csvCell).join(","))];
      return text(lines.join("\n") + "\n", 200, "text/csv; charset=utf-8", { "content-disposition": 'attachment; filename="market-monitor-log.csv"' });
    }
    return json({ log: rows });
  }

  if (path === "/api/test") {
    allow(m, "POST");
    await ctx.notifier.send({ type: "TEST_ALERT" });
    return json({ ok: true });
  }

  throw new ApiError(404, "NOT_FOUND", "No such endpoint.");
}

/** CSV cell with quoting and spreadsheet-formula neutralising. */
export function csvCell(v: string): string {
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
