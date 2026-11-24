# Phase 0 desk research findings

Date checked for every item below: **2026-11-24**. Only public pages were read. Nothing was signed up for, and no API was called with keys.
Tags: `[VERIFIED 2026-11-24]` = confirmed on an official published page that day. `[STILL UNVERIFIED – reason]` = could not be confirmed that way.

---

## 1. NYSE holiday and early-close schedule 2026–2027

Source: https://www.nyse.com/markets/hours-calendars (checked 2026-11-24) `[VERIFIED 2026-11-24]`

Early-close time: **13:00 ET** for equities (13:15 for eligible options). Late sessions of the NYSE American/Arca/National/Texas equity markets end at 17:00, which does not matter for regular-session gating.

Spot checks from the PRD:

| Check | Result |
|---|---|
| Thu 26 Nov 2026 | CLOSED (Thanksgiving) – confirmed |
| Fri 27 Nov 2026 | EARLY CLOSE 13:00 ET – confirmed (PRD 4.3 "[LIKELY]" can become VERIFIED) |
| Thu 24 Dec 2026 | EARLY CLOSE 13:00 ET – confirmed |
| Fri 25 Dec 2026 | CLOSED – confirmed (FR-1.4 "[LIKELY]" can become VERIFIED) |
| Good Friday 2027 | Fri 26 Mar 2027 CLOSED |
| Juneteenth 2027 | Sat 19 Jun, observed **Fri 18 Jun 2027** CLOSED |
| July 4 2027 | Sun 4 Jul, observed **Mon 5 Jul 2027** CLOSED. No early close on Fri 2 Jul 2027. |
| July 2026 | Sat 4 Jul, observed **Fri 3 Jul 2026** CLOSED. NYSE lists no early close on Thu 2 Jul 2026. |
| Day after Thanksgiving 2027 | Fri 26 Nov 2027 EARLY CLOSE 13:00 ET |
| Christmas 2027 | Sat 25 Dec, observed **Fri 24 Dec 2027** CLOSED. NYSE lists no early close on Thu 23 Dec 2027. |
| New Year 2028 | Sat 1 Jan 2028: **no holiday observed** (NYSE footnote), so Fri 31 Dec 2027 is a normal full day |

Ready-to-paste table (dates are New York dates; closeEt is regular-session close; `validUntil` = last date covered):

```ts
// Source: https://www.nyse.com/markets/hours-calendars  (checked 2026-11-24)
export const CALENDAR_VALID_UNTIL = "2027-12-31";
export const REGULAR_OPEN_ET = "09:30";
export const REGULAR_CLOSE_ET = "16:00";
export const EARLY_CLOSE_ET = "13:00";

export const NYSE_HOLIDAYS: Record<string, string> = {
  // 2026
  "2026-01-01": "New Year's Day",
  "2026-01-19": "Martin Luther King, Jr. Day",
  "2026-02-16": "Washington's Birthday",
  "2026-04-03": "Good Friday",
  "2026-05-25": "Memorial Day",
  "2026-06-19": "Juneteenth",
  "2026-07-03": "Independence Day (observed)",
  "2026-09-07": "Labor Day",
  "2026-11-26": "Thanksgiving Day",
  "2026-12-25": "Christmas Day",
  // 2027
  "2027-01-01": "New Year's Day",
  "2027-01-18": "Martin Luther King, Jr. Day",
  "2027-02-15": "Washington's Birthday",
  "2027-03-26": "Good Friday",
  "2027-05-31": "Memorial Day",
  "2027-06-18": "Juneteenth (observed)",
  "2027-07-05": "Independence Day (observed)",
  "2027-09-06": "Labor Day",
  "2027-11-25": "Thanksgiving Day",
  "2027-12-24": "Christmas Day (observed)",
};

export const NYSE_EARLY_CLOSES: Record<string, string> = {
  // close at 13:00 ET
  "2026-11-27": "Day after Thanksgiving",
  "2026-12-24": "Christmas Eve",
  "2027-11-26": "Day after Thanksgiving",
};
```

For the next table refresh, NYSE already publishes 2028: holidays 17 Jan, 21 Feb, 14 Apr, 29 May, 19 Jun, 4 Jul (Tue), 4 Sep, 23 Nov, 25 Dec. Early closes are Mon 3 Jul 2028 and Fri 24 Nov 2028. No New Year's holiday is observed in 2028.

---

## 2. Alpaca Market Data v2 (free "Basic" plan)

### 2a. Plan limits
Source: https://docs.alpaca.markets/docs/about-market-data-api `[VERIFIED 2026-11-24]`
- Basic (free) is the default for paper and live accounts. Real-time equities come from **IEX** only. **REST 200 calls/min.** WebSocket allows 30 symbols. "Equities historical limit: latest 15 minutes".
- Algo Trader Plus costs $99/month, with all US exchanges and 10,000 calls/min.

### 2b. Snapshot endpoint
Source: https://docs.alpaca.markets/reference/stocksnapshots-1 `[VERIFIED 2026-11-24]`
- `GET https://data.alpaca.markets/v2/stocks/snapshots?symbols=AAPL,TSLA&feed=iex`
- `feed` values: `sip`, `iex`, `delayed_sip`, `boats`, `overnight`, `otc`. The default is `sip` for subscribers and **`iex` otherwise**. Always pass `feed=iex` explicitly.
- The response is a map keyed by symbol. Each snapshot has:
  - `latestTrade`: `t` (RFC-3339, ns), `i` (trade id), `x` (exchange), `p` (price), `s` (size), `c` (condition array), `z` (tape), optional `u` (update status: canceled / incorrect / corrected)
  - `latestQuote`: `t`, `bx`, `bp`, `bs`, `ax`, `ap`, `as`, `c`, `z`
  - `minuteBar`, `dailyBar`, `prevDailyBar`: `t`, `o`, `h`, `l`, `c`, `v`, `n` (trade count), `vw` (VWAP)
- **No previous-minute bar.** Only `minuteBar` ("latest minute bar") and `prevDailyBar` are included. The quoted text is "A snapshot provides the latest trade, latest quote, latest minute bar, current daily bar and previous daily bar."
- Whether `minuteBar` is the **in-progress** minute or the **last completed** minute is not stated in the docs `[STILL UNVERIFIED – not documented; measure in Phase 0 by comparing minuteBar.t with wall-clock time]`. If it is the last completed minute, FR-3.3's "current one-minute bar high/low" is really the previous minute. Spike detection still works, but it lags by up to about one minute.
- The FAQ says latest/snapshot endpoints "require a subscription to be used with the SIP feed", so the free plan must use `iex` for snapshots (https://docs.alpaca.markets/us/docs/market-data-faq.md) `[VERIFIED 2026-11-24]`.

### 2c. Trade conditions, extended hours, cancels and corrections
Source: https://docs.alpaca.markets/us/docs/market-data-faq.md `[VERIFIED 2026-11-24]`
- Bars are aggregated from trades. When a trade has several conditions, the strictest rule applies.
- `M` (official close) and `Q` (official open) update nothing. `9` (corrected consolidated close) does not update minute bars or daily volume.
- `B`, `C`, `H`, `I` (odd lot), `N`, `R`, `U` (extended trading hours), `V`, `7` do not update price but do update volume.
- `T` (extended hours trade) updates minute-bar OHLC and volume but **daily-bar volume only**. Daily-bar open/high/low/close therefore exclude extended-hours trades, while daily volume includes them.
- Canceled/corrected trades: the snapshot trade carries the optional `u` field (canceled / incorrect / corrected). The stock FAQ does not describe how cancels change bars.
- The condition-code list is served by `GET /v2/stocks/meta/conditions/trade?tape=A|B|C` (https://docs.alpaca.markets/us/reference/stockmetaconditions-1.md), which needs keys. The full table was not read `[STILL UNVERIFIED – needs keyed call in Phase 0]`.
- Practical rule for code: identify extended hours by **timestamp** (outside 09:30–16:00 ET / the early-close time) as well as by conditions `T`/`U`. Ignore a `latestTrade` that has `u` set.

### 2d. Multi-symbol historical bars and pagination
Source: https://docs.alpaca.markets/reference/stockbars `[VERIFIED 2026-11-24]`
- `GET https://data.alpaca.markets/v2/stocks/bars?symbols=A,B&timeframe=1Day&start=...&end=...&feed=...&limit=...&adjustment=raw&sort=asc&page_token=...`
- `limit` defaults to 1000, with a maximum of 10000. **It applies to the total number of data points across all symbols, not per symbol.**
- Results are sorted by symbol and then by time. Follow `next_page_token` until it is null, because one page may contain only the first symbol.
- `feed` default for bars is **`sip`**. Default `start`/`end` move to 15 minutes ago if the user lacks real-time access.
- Free plan and SIP history: "the `end` parameter must be at least 15 minutes old to query SIP data without a subscription" (FAQ) `[VERIFIED 2026-11-24]`. So yesterday's consolidated daily bar and previous close are available free. Today's SIP bars ending within the last 15 minutes return 403.

### 2e. Halts / LULD (FR-1.8)
Sources: https://docs.alpaca.markets/us/docs/real-time-stock-pricing-data , snapshot reference above.
- The REST snapshot has **no halt or trading-status field**. Halt status (`statuses`) and LULD bands (`lulds`) exist only as **WebSocket** channels. The docs say status messages "can be accessed from any {source} depending on your subscription" `[VERIFIED 2026-11-24 for "REST has no halt field"]`.
- Whether the free IEX WebSocket delivers `statuses` is `[STILL UNVERIFIED – not stated per feed; needs a keyed test]`. Either way, a cron/REST design cannot hold a WebSocket open. **FR-1.8 is not achievable with the current architecture.** Best proxy: flag "possible halt" when `latestTrade.t` and `latestQuote.t` are both stale while the market is open.

### 2f. Account from Oman
- Paper-only account: "Anyone globally can create an Alpaca Paper Only Account! All you need to do is sign up with your email address." Paper-only holders get IEX data only. Source: https://docs.alpaca.markets/us/docs/paper-trading `[VERIFIED 2026-11-24]`
- Live brokerage country list: https://alpaca.markets/support/countries-alpaca-is-available (updated Feb 2026) publishes no list and says to contact support. Oman eligibility for live accounts is `[STILL UNVERIFIED – not published; not needed, since paper-only is enough]`. Actual sign-up from Oman is `[STILL UNVERIFIED – requires Salim to sign up]`.

---

## 3. Cloudflare Workers free plan

Source: https://developers.cloudflare.com/workers/platform/limits/ `[VERIFIED 2026-11-24]`
- Requests: 100,000/day, reset at 00:00 UTC. Over the limit, the Worker returns error 1027.
- CPU time: **10 ms per HTTP request and 10 ms per Cron Trigger** on Free.
- Wall time: **15 min per Cron Trigger invocation**.
- Subrequests: **50 per invocation** (fetch; each redirect hop counts) and **1,000 to internal Cloudflare services**. A Feb 2026 changelog (https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/) raised only Paid (10,000, configurable to 10M). Free "remain limited to 50 external subrequests and 1000 subrequests to Cloudflare services".
- **D1 has its own cap: 50 queries per Worker invocation on Free**, and "a `db.batch()` call counts as a single query" (https://developers.cloudflare.com/d1/platform/limits/). So the PRD's "conflicting" note resolves to two separate caps: ≤50 external fetches, and ≤50 D1 queries/batches per run, within 1,000 internal calls in total.
- Simultaneous open outgoing connections: 6 per invocation. Memory: 128 MB. Startup: 1 s. Worker size: 64 MiB.
- Cron Triggers: **5 per account**.
- D1 Free (https://developers.cloudflare.com/d1/platform/pricing/ and limits): 5 M rows read/day, 100,000 rows written/day, 5 GB total storage, **500 MB per database**, 10 databases, reset 00:00 UTC. Past the daily limit, queries return errors (enforced since 1 Sep 2026, changelog https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/). Batches are metered by rows. The new 50 MB max query result size takes effect 2026-11-04 (irrelevant here).
- Static assets (https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/): "Requests to static assets are free and unlimited." Limits are 20,000 files and 25 MiB per file. **Important:** on Free, once the request limit is exceeded, requests that match `run_worker_first` patterns "will receive a 429 … instead of falling back to static asset serving". Negative `!` patterns still serve assets.
- Config syntax (https://developers.cloudflare.com/workers/static-assets/binding/):

```jsonc
{
  "name": "market-monitor",
  "main": "src/index.ts",
  "compatibility_date": "2026-11-24",
  "assets": {
    "directory": "./public/",
    "binding": "ASSETS",
    "run_worker_first": ["/api/*", "/telegram/*", "/health"]   // everything else = asset first
  },
  "triggers": { "crons": ["* * * * *"] }
}
```
Default `run_worker_first` is false: assets are served first, and the Worker runs only when no asset matches. The array form allows up to 100 patterns, and `!` negations take precedence.
- Changes since the PRD: none that contradict it. The new details are the 500 MB per-DB cap, the separate D1 50-queries cap with batch = 1, and the 429 behaviour for `run_worker_first` routes.

---

## 4. Telegram Bot API

Source: https://core.telegram.org/bots/api (latest version **Bot API 10.5, 22 Nov 2026**) `[VERIFIED 2026-11-24]`
- `setWebhook` `secret_token`: 1–256 chars, `A-Z a-z 0-9 _ -`. It is sent in header **`X-Telegram-Bot-Api-Secret-Token`** on every webhook request.
- Message length: `sendMessage` / `editMessageText` text is **1–4096 characters after entity parsing**.
- `callback_data`: 1–64 bytes.
- `answerCallbackQuery`: the client shows a progress bar until it is called, so "it is necessary to react by calling answerCallbackQuery". **The docs give no numeric timeout** `[STILL UNVERIFIED – exact expiry not documented; answer immediately, before any DB work]`.
- Bot API 10.5 adds `setMySettings` with a `callback_query_mode`. In one mode, callbacks arrive with `inline_message_id` instead of `message`. Keep the default mode, and have code tolerate a missing `message`.
- `editMessageText` age limit: the only 48 h restriction is for **business messages not sent by the bot**. Bot-sent messages in a private chat have no documented edit age limit `[VERIFIED 2026-11-24]`.
- Edits do not notify: the API docs do not state this `[STILL UNVERIFIED – not stated in official docs; widely observed behaviour; confirm on phone in Phase 0]`.
- `deleteMessage`: "A message can only be deleted if it was sent less than 48 hours ago". Bots can delete their outgoing messages in private chats `[VERIFIED 2026-11-24]`.
- `disable_notification`: "Users will receive a notification with no sound." It is silent, not invisible.
- Rate limits (https://core.telegram.org/bots/faq): in a single chat, avoid more than **1 message/second** (short bursts are allowed, then 429). Groups are limited to 20 messages/min, and broadcast to about 30 messages/second. A 429 response carries `parameters.retry_after` `[VERIFIED 2026-11-24]`.

---

## 5. Finnhub free plan

- `/quote?symbol=XYZ`: fields `c` current, `d` change, `dp` % change, `h` day high, `l` day low, `o` open, `pc` previous close. Responses in practice also include `t` (timestamp), but it is not in the schema. **There is no volume field.** The endpoint is marked "High Usage", and the docs say "Constant polling is not recommended. Use websocket". Source: https://finnhub.io/static/swagger.json (official OpenAPI file behind https://finnhub.io/docs/api/quote) `[VERIFIED 2026-11-24]`
- Rate limit: Free = **60 API calls/minute** (https://finnhub.io/pricing, via search snippet; the page renders in JavaScript). On every plan there is also **30 calls/second**, and going over returns HTTP 429 (https://finnhub.io/docs/api/rate-limit) `[VERIFIED 2026-11-24]`.
- `/stock/candle` is marked "Premium Access Required". `/calendar/earnings` free tier is "1 month of historical earnings and new updates", so an earnings-date flag (FR-7.5) is feasible on the free plan (swagger) `[VERIFIED 2026-11-24]`.

---

## 6. Free external uptime monitors (FR-10.2)

| Service | Free tier | 5-min check of a URL? | Telegram on free? | Source |
|---|---|---|---|---|
| UptimeRobot | 50 monitors, 5-min interval, 5 integrations, commercial use OK | Yes | **No**: "This feature is available in our Solo, Team & Enterprise plans" | https://uptimerobot.com/pricing/ , https://uptimerobot.com/integrations/telegram-integration/ |
| Better Stack | 10 monitors+heartbeats, 1 status page | Yes (free interval not stated on pricing page) | **No**: free lists "Slack & e-mail alerts" only | https://betterstack.com/pricing |
| Healthchecks.io | Hobbyist $0: 20 checks | **No**: passive heartbeat (the Worker must ping it); cron schedule plus time zone plus grace time supported | Telegram integration exists; free availability per an older official blog post, not the current pricing page | https://healthchecks.io/pricing/ , https://healthchecks.io/docs/configuring_checks/ |
| cron-job.org | Free, unlimited jobs, every minute, 30 s timeout | Calls a URL; failure alert by **email only**; **job is disabled after >25 failures** | No | https://cron-job.org/en/faq/ |

Tags: UptimeRobot / Better Stack / cron-job.org `[VERIFIED 2026-11-24]`. Healthchecks.io Telegram-on-free `[STILL UNVERIFIED – current pricing page silent; confirm when creating the account]`.

Recommendation: no service verified here does "check URL every 5 min and send to Telegram" for free. The best fit is **Healthchecks.io as a dead-man's switch**. The Worker pings it, for example every 5th run (one subrequest), and the check uses a cron schedule `*/5 9-16 * * 1-5` with time zone America/New_York and a grace time. Healthchecks then alerts by Telegram if pings stop. This catches "Worker not running", which a URL check would miss. Fallback: UptimeRobot free with email alerts.

---

## 7. Samsung One UI (phone setup, FR-5.7)

Sources are Samsung official support pages. None of them gives a One UI version, and labels can vary by version.
- **Never sleeping apps:** Settings > Battery and device care > Battery > **Background usage limits** > Never sleeping apps > `+` > select Telegram > Add (https://www.samsung.com/us/support/answer/ANS10003442/). Older path: Battery > App power management > Never sleeping apps (https://www.samsung.com/ae/support/mobile-devices/how-to-manage-sleeping-apps-to-save-battery-life-on-your-galaxy-device/). On newer One UI, Battery is a top-level Settings entry, so search Settings for "Never sleeping" `[VERIFIED 2026-11-24 for path on Samsung US page; exact label on Salim's One UI version STILL UNVERIFIED – check on device]`.
- **Do Not Disturb exception:** Quick settings > long-press Do not disturb (or Settings > search "Do not disturb") > *Allowed during Do not disturb* > **App notifications** > add Telegram (https://www.samsung.com/us/support/answer/ANS10002889/) `[VERIFIED 2026-11-24]`.
- **Per-channel sound for Telegram:** Settings > Notifications > Advanced settings > turn on managing **notification categories** for each app. Then Settings > Notifications > App notifications > Telegram > Notification categories > (category for private chats) > Sound. That category can also have "Ignore Do not disturb" (https://www.samsung.com/nz/support/mobile-devices/how-to-set-notification-sounds-for-each-app-on-you-galaxy-phone/) `[VERIFIED 2026-11-24 for Samsung side]`. Telegram's own per-chat sound (chat > bot name > Notifications > Customize) `[STILL UNVERIFIED – not checked on an official Telegram page; test on device]`.

---

## Changes the PRD/code should make

1. **FR-1.4 / 4.3:** change the [LIKELY] tags to [VERIFIED 2026-11-24]. Add 24 Dec 2026 as an early close (13:00). Embed the table above with `validUntil 2027-12-31`. Note the 2027 observed days (18 Jun, 5 Jul, 24 Dec) and that no early close falls on 2 Jul 2026, 23 Dec 2027 or 31 Dec 2027.
2. **FR-3.3 / 5.2:** the snapshot has no previous-minute bar, and the `minuteBar` timing (live or last completed) is undocumented. Measure it in Phase 0. If it is the last completed minute, store each poll's `minuteBar` so a skipped minute is backfilled with one `/v2/stocks/bars?timeframe=1Min&feed=iex` call.
3. **Always send `feed=iex`** on snapshots and same-day bars, and `feed=sip` only with `end` ≥15 min old (previous close, baselines). Bars `limit` is a total across symbols, so code must follow `next_page_token`.
4. **Ignore trades with `u` set**, and gate on timestamp, not only conditions, for extended hours. Daily-bar OHLC excludes extended hours but daily volume includes `T` trades. Label it, or compute session volume from minute bars if exactness matters.
5. **FR-1.8 halts:** not available over REST. Downgrade to P2, or reword it as a "no IEX trade or quote for N minutes: possible halt" heuristic.
6. **Section 1c:** replace "conflicting" with: ≤50 external fetches, ≤50 D1 queries per run (`db.batch` = 1 query), ≤1,000 Cloudflare-service calls. Add the 500 MB per-database cap.
7. **FR-8.1:** keep the page shell asset-first. Know that `run_worker_first` routes (API, webhook) return 429 once the daily allowance is gone.
8. **Telegram:** call `answerCallbackQuery` first thing. Handle a callback without `message` (Bot API 10.5 `callback_query_mode`). Split messages at 4096 chars. Pace at ≤1 message/second per chat and honour `retry_after`. Only bot messages under 48 h can be deleted. Edits have no age limit.
9. **FR-10.2:** UptimeRobot and Better Stack free tiers do **not** include Telegram. Use a Healthchecks.io heartbeat (Telegram) or UptimeRobot with email, and budget one subrequest per ping.
10. **FR-5.1/5.8 fallback:** Finnhub `/quote` has no volume, and docs discourage constant polling. Keep it as a price-only fallback within 60 calls/min. The FR-7.5 earnings flag looks feasible on the Finnhub free plan.
11. **5.4 Alpaca from Oman:** paper-only sign-up is open "globally" with email. Change the tag to LIKELY-OK, pending Salim's actual sign-up.
