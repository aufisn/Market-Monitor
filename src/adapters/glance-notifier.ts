/**
 * Notifier port for the Glance Line layout: renders each core event (render-glance.ts)
 * and sends it through the Telegram transport. The briefing can be several messages.
 */
import type { Baseline, Notifier, OutboundEvent, StockConfig } from "../core/ports";
import { renderGlanceAll, type GlanceCtx } from "./render-glance";
import type { TelegramApi } from "./telegram";

export interface GlanceContextData {
  stocks?: StockConfig[];
  baselines?: Baseline[];
}

export interface GlanceNotifierOptions {
  now: () => number;
  /** Validated https URL or undefined. */
  dashboardUrl?: string;
  /** Loads the watchlist and baselines (only called for events that need them, once per instance). */
  loadContext?: () => Promise<GlanceContextData>;
}

const NEEDS_CONTEXT = new Set<OutboundEvent["type"]>(["BRIEFING", "FIRST_ALERT", "REMINDER", "LATE_ALERT"]);

export class GlanceNotifier implements Notifier {
  private loaded?: Promise<GlanceContextData>;
  constructor(private readonly api: TelegramApi, private readonly opts: GlanceNotifierOptions) {}

  private async ctxFor(event: OutboundEvent): Promise<GlanceCtx> {
    let data: GlanceContextData = {};
    if (this.opts.loadContext && NEEDS_CONTEXT.has(event.type)) {
      this.loaded ??= this.opts.loadContext().catch(() => ({}));
      data = await this.loaded;
    }
    return { nowMs: this.opts.now(), dashboardUrl: this.opts.dashboardUrl, ...data };
  }

  async send(event: OutboundEvent): Promise<number> {
    const parts = renderGlanceAll(event, await this.ctxFor(event));
    let first = 0;
    for (const [i, p] of parts.entries()) {
      const id = await this.api.sendMessage(p);
      if (i === 0) first = id;
    }
    return first;
  }

  async edit(messageId: number, event: OutboundEvent): Promise<void> {
    const parts = renderGlanceAll(event, await this.ctxFor(event));
    await this.api.editMessageText(messageId, parts[0]!);
  }

  delete(messageId: number): Promise<void> {
    return this.api.deleteMessage(messageId);
  }
}
