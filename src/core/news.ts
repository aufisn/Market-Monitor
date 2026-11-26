/**
 * News headlines (design step 7): silent, information only, at most one message per stock per 15 minutes;
 * headlines that arrive inside that gap come together in the next message. Pure: no I/O.
 */
import type { MarketState, NewsHeadline, NewsItem, Symbol } from "./ports";
import { MIN } from "./time";

export const NEWS_GAP_MS = 15 * MIN;
/** Headlines shown in one message (newest first); the rest are counted as "+N more". */
export const NEWS_SHOWN = 3;
/** News is checked on every second run (one call for the whole watchlist). */
export const NEWS_EVERY_MIN = 2;
/** A stock seen for the first time today gets headlines from the last 15 minutes, never older. */
export const NEWS_LOOKBACK_MS = 15 * MIN;

type NewsState = NonNullable<MarketState["news"]>;

/**
 * Folds the latest headlines (or none, on a run without a fetch) into one stock's news state.
 * Returns the new state, whether it changed, and the message to send now, if any.
 */
export function foldNews(
  state: NewsState | undefined, symbol: Symbol, list: NewsHeadline[] | undefined, nowMs: number, firstSeenMs: number,
): { state: NewsState; changed: boolean; send?: { items: NewsItem[]; more: number } } {
  let st: NewsState = state ?? { seenMs: firstSeenMs };
  let changed = !state;
  const fresh = (list ?? []).filter((h) => h.symbols.includes(symbol) && h.tMs > st.seenMs).sort((a, b) => b.tMs - a.tMs);
  if (fresh.length) {
    const items = [...fresh.map(({ symbols: _s, ...it }) => it), ...(st.pending ?? [])];
    const seen = new Set<number>();
    const uniq = items.filter((it) => !seen.has(it.id) && seen.add(it.id));
    const more = (st.more ?? 0) + Math.max(0, uniq.length - NEWS_SHOWN);
    st = { ...st, seenMs: fresh[0]!.tMs, pending: uniq.slice(0, NEWS_SHOWN), ...(more ? { more } : {}) };
    changed = true;
  }
  if (st.pending?.length && (st.sentMs === undefined || nowMs - st.sentMs >= NEWS_GAP_MS)) {
    const send = { items: st.pending, more: st.more ?? 0 };
    st = { seenMs: st.seenMs, sentMs: nowMs };
    return { state: st, changed: true, send };
  }
  return { state: st, changed };
}
