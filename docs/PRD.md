==============================================================================
MARKET WATCH - PRODUCT REQUIREMENTS DOCUMENT (PRD)
==============================================================================
Product       : Market Watch - US stock price & volume threshold alerts
Form          : Server-side monitor on a Cloudflare Worker (free plan),
                alerts and acknowledgment through Telegram, HTML dashboard
                (installable web app) served by the same Worker, source code
                in a PUBLIC GitHub repository named
                "Market-Monitor" (code only, never secrets)
Owner         : Salim (Muscat, Oman - UTC+4, no daylight saving)
Document date : 24 November 2026
Version       : 3.1 (v3.0 plus public repository and build instructions)
Status        : Ready for developer review. NO production code until the UX
                decision gate (section 9) is passed. Technical spikes allowed.

HOW TO READ THIS DOCUMENT
- Requirements are numbered (FR-x.y) with a priority:
    P0 = must ship in v1      P1 = should ship in v1 if time allows
    P2 = later / optional
- Facts about third-party services carry a tag:
    [VERIFIED 2026-11-24] = checked against a published page that day
    [LIKELY]              = believed true, developer must confirm
    [UNVERIFIED]          = not checked, developer must confirm in Phase 0
- DECISION GATE (DG) = needs Salim's explicit approval before work continues.


==============================================================================
0. WHAT CHANGED FROM v2.0
==============================================================================
Salim's requirement: monitoring must keep running while his phone is off or
locked. A web page on the phone cannot do that, so the monitor moves to a
server that runs all day on the free Cloudflare Workers plan (Salim has
already registered a Cloudflare account).

CHANGED
- Where it runs: phone  -->  Cloudflare Worker with a once-a-minute schedule,
  polling several times inside each minute.
- Alert channel: in-app/phone notification  -->  Telegram messages with an
  Acknowledge button (as Salim originally chose). The dashboard can also
  acknowledge.
- Dashboard: no longer does the monitoring. It is a window onto the server:
  shows the data, edits thresholds, acknowledges. Served by the same Worker.
- Repository: public, named Market-Monitor, code only. The dashboard is
  still served by the Worker, not GitHub Pages (one address, no cross-site
  setup).
- Phone-side items removed: wake lock, Dim mode, suspension guard, foreground
  alarm, endurance test on the phone.
NEW
- Server-side storage (Cloudflare D1), lock against double runs, gap scan for
  missed schedule runs, health messages, free-tier budget guard, deploy
  pipeline from GitHub.
KEPT
- Alerts fire if and only if thresholds Salim sets are crossed; repeat every
  10 minutes until acknowledged.
- Only while the US market is open.
- Dashboard shows LOW and HIGH thresholds, Previous Close, Opening, Last
  recorded.
- Opening Briefing; three UX alternatives before commitment; zero cost; no
  AI/LLM anywhere.


==============================================================================
1. THE LIMITS THAT SHAPE THIS DESIGN - READ FIRST
==============================================================================
The free plan is enough, but it sets hard edges. The design is built around
them; the developer must not assume otherwise.

a) NOT TICK-BY-TICK. The server wakes on a schedule (every minute is the
   smallest practical step; "* * * * *" is a valid schedule [VERIFIED
   2026-11-24]) and polls market data over HTTP. It cannot hold a live
   stream open all day. A scheduled run may stay alive up to 15 minutes of
   elapsed time [VERIFIED], and time spent waiting on the network does not
   count as processor time [VERIFIED], so each run polls about every 10-15
   seconds for the minute (Phase 0 confirms the achievable rate).
   A crossing is detected within one poll interval. To make sure a brief
   spike between polls is not missed, each poll also reads the current
   one-minute bar's high and low (FR-3.3).
b) 10 ms OF PROCESSOR TIME PER RUN on the free plan [VERIFIED]. Code must be
   tiny and efficient; no heavy parsing or libraries. Building the volume
   baseline is spread over many runs (FR-6.2).
c) 50 EXTERNAL REQUESTS PER RUN on the free plan [VERIFIED]; the limit for
   calls to Cloudflare's own services (such as the database) is documented
   inconsistently (1,000 in one place, 50 queries per run for D1 in another)
   [VERIFIED, conflicting]. Design rule: at most 45 calls of any kind per
   run, and batch database statements.
d) 100,000 REQUESTS PER DAY [VERIFIED]. Free usage of the database is 100,000
   rows written and 5 million rows read per day, 5 GB storage, and queries
   fail once a limit is passed [VERIFIED]. Nothing is billed on the free
   plan; operations simply fail. Expected use is under 5% of every limit
   (section 4.4).
e) ONLY 5 SCHEDULES PER ACCOUNT [VERIFIED]. This design uses one.
f) SCHEDULES RUN IN UTC [VERIFIED] and a failed scheduled run is not retried
   [VERIFIED]. A minute can therefore be missed. The gap scan (FR-9) makes
   sure a missed minute is covered at the next run.
g) FREE DATA IS ONE EXCHANGE (IEX) [VERIFIED]. Prices and especially volume
   come from IEX only (section 5).
h) NO POWER OR PHONE DEPENDENCE, BUT A SWITCHED-OFF PHONE CANNOT RING.
   Telegram holds messages until the phone is back online; the server keeps
   sending reminders every 10 minutes meanwhile. The phone must be on, with
   Telegram allowed to notify, for Salim to hear alerts.

ESCALATION PATH (DG-1). If minute-level polling proves too slow in practice,
the same engine is moved to an always-on process (a spare Mac mini, or an
Oracle Cloud Always Free server if sign-up works from Oman [UNVERIFIED]).
Requirement FR-14.4 keeps the engine portable so this is a change of host,
not a rewrite.


==============================================================================
2. PURPOSE, GOALS, NON-GOALS
==============================================================================
2.1 Purpose
Tell Salim, on Telegram and with reminders he cannot miss, when a stock he
watches crosses a price or volume threshold that HE set, and keep reminding
him every 10 minutes until he acknowledges, whether his phone is locked,
asleep or in his pocket.

2.2 Goals (in priority order)
G1. Alert exactly when, and only when, a user-set threshold is crossed.
G2. Keep working with the phone locked, asleep, or the dashboard closed.
G3. Remind every 10 minutes until acknowledged.
G4. A dashboard showing, per stock: LOW threshold, HIGH threshold, Previous
    Close, Opening price, Last recorded price.
G5. Never alert when the US market is closed.
G6. Never silently miss a crossing (late is acceptable, silent is not).
G7. Salim can change stocks and thresholds himself, from the phone.
G8. Zero cost; no AI model and no Claude API key anywhere.

2.3 Non-goals (v1)
- No news, sentiment or AI commentary.
- No automatic or "smart" thresholds (optional suggestions only, P1, never
  applied without Salim).
- No trading or brokerage connection that can move money.
- No pre-market or after-hours monitoring.
- No non-US markets, options, crypto or forex.
- No multiple users; one owner.

2.4 User and context
- Single user in Muscat. US regular session 09:30-16:00 New York time =
  18:30-01:00 Muscat from 1 Nov 2026 until US daylight saving starts in March
  2027 (then 17:30-00:00). The session crosses midnight in Muscat; every date
  in the system is the New York trading date.
- Device: foldable Samsung phone. Telegram messages must be readable on the
  narrow cover screen (lines of 38 characters or fewer, no wide tables).
- Language: English in v1; Arabic is P2.


==============================================================================
3. DECISIONS AND INTERPRETATIONS TO CONFIRM
==============================================================================
DG-1  Cadence sufficiency: after the Phase 0 cadence test (section 11), Salim
      confirms that polling every 10-15 seconds (guaranteed at least once a
      minute) is fast enough, or chooses the escalation path in section 1.
DG-2  Data source and account: see section 5.
DG-3  UX alternatives: see section 9.
DG-4  Dashboard hosting: served by the Worker as static files
      (RECOMMENDED: same address for page and API, no cross-site permissions)
      versus GitHub Pages (possible now that the repository is public).

Interpretations used in this PRD (the developer lists them back to Salim in
the first review):
I-1  PRICE RULES. Each stock has an optional HIGH and an optional LOW
     threshold. HIGH is crossed when a valid price is greater than or equal to
     the HIGH; LOW is crossed when a valid price is less than or equal to the
     LOW. Each can be entered as a dollar price or as a percentage from
     Previous Close (recomputed every morning); the dashboard always shows the
     resulting dollar value.
I-2  VOLUME RULE. Each stock has an optional volume threshold entered as a
     multiple (default 2.0x) of the average cumulative volume at this time of
     day over the last 20 sessions, or as an absolute share count. Crossed
     when today's cumulative volume reaches the threshold.
I-3  REPEAT. After the first alert, a reminder is sent every 10 minutes
     (setting, default 10) until Salim acknowledges, even if price has moved
     back inside the band. An optional "auto-clear when back inside" setting
     exists and is OFF by default.
I-4  ACKNOWLEDGE. Acknowledgment is an explicit tap on Acknowledge (Telegram
     button or dashboard) or the /ack command. Deleting, muting or ignoring a
     message is not an acknowledgment.
I-5  AFTER ACKNOWLEDGE. The rule is quiet until the value has returned inside
     its band by a re-arm buffer (default 0.2% for price, 10% for volume,
     editable, zero allowed) and crosses again. Editing a threshold re-arms
     immediately.
I-6  MARKET CLOSE. Reminders stop at the close. Anything unacknowledged stays
     listed as "Unacknowledged at close", sends nothing more, and re-arms fresh
     at the next open.
I-7  "YESTERDAY MAX" in the Opening Briefing = yesterday's high price.
I-8  FIRST MESSAGE OF THE DAY = one Opening Briefing, about one minute after
     the open. It is information: no acknowledgment, no repeats.
I-9  "LAST RECORDED" = the last valid trade price received, with its time and
     age; not a guaranteed best national price (section 5.3).
I-10 A crossing detected from a one-minute bar's high or low (not from the
     last trade) counts as a crossing and is labelled "touched at HH:MM".


==============================================================================
4. SYSTEM OVERVIEW
==============================================================================
4.1 Components (one Worker deployment, one database)
  C1 Scheduler        - one schedule "* 11-21 * * MON-FRI" (UTC), covering the
                        pre-open work and the session in both US clock
                        settings; the code decides what to do from the New York
                        time and the exchange calendar.
  C2 Market Calendar  - embedded table of holidays and early closes.
  C3 Data Adapter     - Alpaca market-data REST (primary), fallback source.
  C4 Baseline Job     - previous close, yesterday's range, time-of-day volume
                        curves; built a little at a time before the open.
  C5 Rule Engine      - price and volume rules on each poll.
  C6 Alert State Machine - trigger, reminders, acknowledge, re-arm.
  C7 Telegram Gateway - sends alerts; receives button presses and commands via
                        a webhook.
  C8 Dashboard        - HTML web app (static files) plus a small API.
  C9 Storage          - Cloudflare D1 database (SQL).
  C10 Health Monitor  - ready/ended messages, error notices, budget guard.
  C11 Deploy Pipeline - GitHub (public) -> tests -> deploy.
  The core engine (C5, C6, parts of C4) is plain code that does not call
  Cloudflare features directly; it receives data, time and storage through
  small interfaces (FR-14.4).

4.2 Data flow
  [Alpaca data API] --poll--> [Worker: scheduled run] --> [D1 database]
                                   |        ^                  ^
                                   v        |                  |
                           [Telegram API]  [Worker: web requests] <-- dashboard
                                   |        ^   (Telegram webhook, dashboard API)
                                   v        |
                          Salim's phone (Telegram app, dashboard page)
  Telegram -> Worker via webhook; Worker -> Telegram by sending messages.
  Nothing connects inwards to Salim's phone or any machine of his.

4.3 Daily timeline (New York time; Muscat in brackets until March 2027)
  07:00 ET (16:00)  Baseline Job starts, one stock per run (FR-6.2).
  09:00 ET (18:00)  Pre-open check; silent "READY" message with status.
  09:30 ET (18:30)  Session opens; rule evaluation begins.
  09:31 ET (18:31)  Opening Briefing.
  09:30-16:00 ET    Polling, alerts, reminders.
  16:00 ET (01:00)  Close: reminders stop; unacknowledged flagged.
  16:05 ET (01:05)  Silent "SESSION ENDED" message with the day's counts.
  Early-close days (about 13:00 ET) shift the afternoon. Friday 27 Nov 2026,
  the day after US Thanksgiving, is normally an early close [LIKELY]; use it as
  a test day.

4.4 Free-tier budget (expected, per trading day; developer measures in Phase 0)
  Requests to the Worker       : about 660 schedule runs + dashboard polling
                                 (about 1,500 if open all session) + Telegram
                                 callbacks (under 100)  = about 2,300 of 100,000
  Database rows written        : target under 6,000 of 100,000 (write only on
                                 change; one "last poll" row per run)
  Database rows read           : target under 400,000 of 5,000,000 (indexed
                                 queries only)
  Calls per run                : 45 or fewer of 50
  Processor time per run       : 8 ms or less of 10 ms (guard in FR-10.5)
  Static dashboard files       : free and unlimited [VERIFIED]


==============================================================================
5. DATA SOURCES AND FEASIBILITY (DG-2)
==============================================================================
5.1 Free options [VERIFIED 2026-11-24 unless tagged]
  - Alpaca "Basic" market data, free with a paper-trading account: real-time
    data from the IEX exchange only; REST 200 requests per minute; historical
    consolidated (SIP) data delayed 15 minutes. Used from the server by REST
    (no stream, so the one-connection and 30-symbol stream limits do not
    apply, but the 200 requests per minute does).
  - Finnhub free: 60 calls per minute and real-time US quotes (it gives current
    price, day high/low, open and previous close per symbol); candle and
    volume history is premium, so it cannot supply the volume baseline. It is
    the named fallback for PRICE rules only.
  - Twelve Data free: 8 credits per minute and 800 per day; not suitable.
5.2 Expected Alpaca calls [LIKELY - confirm in Phase 0]
  - One multi-symbol snapshot call per poll returns, per stock: latest trade,
    current minute bar, today's daily bar (open, high, low, volume). One call
    per poll keeps the budget small.
  - One historical-bars call per stock before the open for Previous Close and
    yesterday's high/low/volume (consolidated data is allowed because it is
    for a past day), and one call per stock for the volume baseline.
5.3 Caveats
  - IEX is one exchange. Alpaca's own example shows about 0.9 million shares on
    IEX against about 51.9 million consolidated for one stock and day (about
    2%). A ratio of today's IEX volume to the average IEX volume at the same
    time of day is meaningful, but noisy on thinly traded stocks. Volume is
    always labelled "IEX volume".
  - "Last recorded" is the last IEX trade; on a quiet stock it can be minutes
    old. Every price shows its age; amber after 60 seconds, red after 5
    minutes. The one-minute bar's high/low reduce but do not remove the risk
    that a crossing happens only on other exchanges.
  - Previous Close and yesterday's high/low come from consolidated daily bars;
    Opening is the IEX open and is labelled "Opening (IEX)".
5.4 Phase 0 checks (all [UNVERIFIED] until done)
  - Salim can open the free Alpaca account from Oman and obtain keys. Use
    paper-trading keys so no real-money permission exists.
  - The snapshot fields above exist on the free feed and are real-time.
  - Achievable polls per minute inside one scheduled run, measured processor
    time per run, and the actual delay between the schedule time and the run
    start (jitter) over at least 3 full sessions.


==============================================================================
6. FUNCTIONAL REQUIREMENTS
==============================================================================

------------------------------------------------------------------------------
FR-1  MARKET CALENDAR AND SESSION GATING
------------------------------------------------------------------------------
FR-1.1 (P0) Alerts and reminders are produced only between the official open
        and close of the US regular session on a trading day. None on weekends,
        US market holidays, or outside the session.
FR-1.2 (P0) Early closes end the session at the early-close time.
FR-1.3 (P0) The calendar is an embedded table (current and next year) taken
        from the exchange's official schedule, with a "valid until" date
        shown in the dashboard. 30 days before expiry the system sends a
        Telegram reminder to update it. If the date is outside the table the
        system stays silent on alerts and sends one clear "calendar expired"
        message; it never guesses.
FR-1.4 (P0) Checks the calendar must pass: Thursday 26 Nov 2026 closed
        (Thanksgiving), Friday 27 Nov 2026 early close, Friday 25 Dec 2026
        closed [LIKELY - confirm against the exchange schedule].
FR-1.5 (P0) The schedule runs in UTC. The code converts to New York time using
        proper time-zone rules (including the US clock change in March and
        November) and exits within a millisecond outside working windows.
FR-1.6 (P0) All times in messages and on the dashboard are shown in New York
        time and Muscat time (example: 10:42 ET / 19:42 Muscat).
FR-1.7 (P0) Dashboard market-status banner: OPEN, CLOSED (reason), EARLY CLOSE
        TODAY, with time to next open or close.
FR-1.8 (P1) Trading halts: if the data shows a halt for a watched stock, its
        rules pause and a halt/resume notice is sent. Availability on the free
        data [UNVERIFIED].

------------------------------------------------------------------------------
FR-2  CONFIGURATION, WATCHLIST AND THRESHOLDS
------------------------------------------------------------------------------
FR-2.1 (P0) Watchlist and thresholds live in the database and are edited from
        the dashboard or by Telegram commands; no code change or redeploy.
FR-2.2 (P0) Capacity: 30 stocks by default (bounded by the processor and call
        budget); Phase 0 tests whether 50 fit.
FR-2.3 (P0) Per stock: optional LOW, optional HIGH, optional volume threshold,
        mute state, notes (none required). Defaults for reminder interval,
        re-arm buffers and volume guards are global settings with per-stock
        overrides.
FR-2.4 (P0) Validation: LOW below HIGH; positive values; symbol must exist in
        the data source; no duplicates. If a new threshold is already crossed
        by the latest price, the system asks "This will alert immediately.
        Save?" before saving.
FR-2.5 (P0) Every change is logged with time and previous value.
FR-2.6 (P0) Backup: export and import of watchlist, thresholds and settings as
        a JSON file from the dashboard. Keys and tokens are never exported.

------------------------------------------------------------------------------
FR-3  RULE EVALUATION (EACH POLL)
------------------------------------------------------------------------------
FR-3.1 (P0) Rules exist only for thresholds Salim has entered. A stock with no
        thresholds produces data on the dashboard and no alerts.
FR-3.2 (P0) PRICE-HIGH: crossed when a valid price >= HIGH. PRICE-LOW: crossed
        when a valid price <= LOW. VOLUME: crossed when today's cumulative IEX
        volume >= threshold, where threshold = multiple x AvgCum(t) (FR-6) or
        the absolute share count.
FR-3.3 (P0) Valid price evidence in each poll: the latest trade price, AND the
        high and low of the current and previous completed one-minute bars.
        A bar high at or above HIGH, or a bar low at or below LOW, counts as a
        crossing (I-10), recorded with the minute it happened.
FR-3.4 (P0) False-crossing protection (it never creates alerts, only
        prevents wrong ones): ignore trades flagged by the provider as
        extended-hours, canceled, corrected or out of sequence; a price more
        than 10% from the median of the previous five minute-closes is held
        until the next poll confirms it.
FR-3.5 (P0) Evaluation happens only while the market is open (FR-1).
FR-3.6 (P0) Each rule has an independent state (FR-4). A stock can have HIGH,
        LOW and VOLUME alerting at once.
FR-3.7 (P0) Editing a threshold re-evaluates it immediately against the latest
        stored data.
FR-3.8 (P0) Polling cadence: at least one successful poll per minute is
        required; the target is one poll every 10-15 seconds inside each run,
        subject to the call budget (45 calls per run).
FR-3.9 (P0) Provider errors (rate limit, authentication failure, timeouts) are
        retried once inside the run and then reported (FR-10.3); a stock with
        no data for 2 minutes in an open market is marked NO DATA.

------------------------------------------------------------------------------
FR-4  ALERT LIFECYCLE: TRIGGER, REPEAT UNTIL ACKNOWLEDGED, RE-ARM
------------------------------------------------------------------------------
States per rule: ARMED -> TRIGGERED -> REPEATING -> ACKNOWLEDGED -> ARMED.
Plus UNACKNOWLEDGED_AT_CLOSE.

FR-4.1 (P0) FIRST ALERT: at the first valid crossing the system records T0
        (time, price) and sends the Telegram alert immediately (within the
        same run).
FR-4.2 (P0) REMINDERS: while unacknowledged and the market is open, a reminder
        is sent at T0 + 10, +20, +30 minutes and so on (interval is a setting,
        range 1-60). Because the schedule ticks every minute, a reminder is
        sent at the first tick at or after its due time (typically within 15
        seconds, never more than about 60 seconds late). Reminders are
        numbered: "Reminder 3 - unacknowledged for 30 min".
FR-4.3 (P0) Reminders continue after the price returns inside the band (I-3);
        the message states "price now back inside your band". Setting
        "auto-clear" is OFF by default.
FR-4.4 (P0) ACKNOWLEDGE by: (a) the Acknowledge button on the Telegram message,
        (b) the dashboard, (c) /ack SYMBOL, (d) Acknowledge all. Effect within
        2 seconds. The Telegram message is edited to show "Acknowledged HH:MM"
        and its buttons are removed.
FR-4.5 (P0) ACK SAFETY: the database record is checked immediately before every
        reminder is sent, so an acknowledgment made just before a reminder is
        due cancels it. At most one extra reminder may be sent in the worst
        race, and never after the acknowledgment has been shown.
FR-4.6 (P0) RE-ARM after acknowledgment per I-5; a new crossing starts a new
        cycle with a new T0.
FR-4.7 (P1) "Acknowledge and move threshold": one tap acknowledges and moves the
        crossed threshold by +1%, +2% or a typed value.
FR-4.8 (P0) AT MARKET CLOSE: reminders stop. Unacknowledged alerts are listed
        as "Unacknowledged at close". Next open: rules start ARMED.
FR-4.9 (P0) Persistence: all alert states live in the database; nothing is held
        in memory between runs.
FR-4.10 (P0) De-duplication: alert id = (trading date, symbol, rule, cycle
        number) with a database uniqueness rule, so overlapping runs cannot
        send two first alerts.
FR-4.11 (P0) LOCK: a run takes a short database lease (expires after 50
        seconds); a second run that starts while the lease is held exits
        without sending anything, so two runs never alert twice.
FR-4.12 (P1) Reminder tidy-up: a new reminder deletes the previous reminder
        message for the same rule (if the phone was off, only the latest
        reminder is waiting when it comes back). Setting, default ON.
FR-4.13 (P0) Several simultaneous alerts are listed oldest first, each
        acknowledged separately, plus "Acknowledge all". Reminders due in the
        same minute for one stock are combined into one message.

------------------------------------------------------------------------------
FR-5  TELEGRAM GATEWAY
------------------------------------------------------------------------------
FR-5.1 (P0) A dedicated bot created through BotFather. The bot token is a
        secret held only in the Worker's secret store.
FR-5.2 (P0) Receiving: Telegram calls the Worker's webhook. The webhook is
        registered with a secret token and the Worker rejects any request
        without the matching "X-Telegram-Bot-Api-Secret-Token" header
        [VERIFIED]. The Worker also answers ONLY Salim's chat id; every other
        sender is ignored silently.
FR-5.3 (P0) Button presses arrive as "callback_query" updates [VERIFIED]; the
        Worker answers each press within a few seconds so the button stops
        spinning, and applies the action.
FR-5.4 (P0) Sending: HTML-formatted text; inline buttons; editing and deleting
        of the system's own messages. Limits respected: about one message a
        second per chat and 30 per second overall [VERIFIED]; on "retry after"
        replies the system waits and retries; priority order: first alerts,
        reminders, briefing, health messages.
FR-5.5 (P0) ALERT CONTENT (mandatory): symbol; rule and direction (HIGH, LOW or
        VOLUME); the threshold value; current price; Previous Close; Opening
        price; change in percent and dollars from Previous Close; volume
        multiple; time of crossing (ET and Muscat) and "touched at" when it was
        seen on a bar; time unacknowledged and reminder number; data age when
        over 60 seconds; buttons: Acknowledge, Ack and move threshold (P1),
        Mute 1h, Open dashboard.
FR-5.6 (P0) Commands (names indicative): /status, /watchlist, /ticker XYZ,
        /set XYZ high 250 | low 230 | volume 2x, /mute XYZ [duration], /unmute,
        /ack XYZ, /ackall, /today, /why XYZ 14:03, /pause, /resume, /test,
        /help. /set applies FR-2.4 validation and replies with the dollar values.
FR-5.7 (P0) Notification settings on the phone (documented in the setup
        checklist and tested in Phase 0): custom sound and priority for the bot
        chat, Do Not Disturb exception for Telegram, Telegram excluded from
        battery optimization [LIKELY available on Samsung phones; verify].
FR-5.8 (P0) Failure handling: if Telegram cannot be reached, messages are
        queued in the database and sent when it can; a daily count of failed
        sends is reported.
FR-5.9 (P1) Second recipient or email as a backup channel for critical health
        problems only.

------------------------------------------------------------------------------
FR-6  VOLUME BASELINE (TIME-OF-DAY AVERAGE)
------------------------------------------------------------------------------
FR-6.1 (P0) AvgCum(t) = average cumulative IEX volume traded by minute t after
        the open, over the last 20 regular sessions (setting 10-60), excluding
        early-close days and sessions marked as extreme outliers (setting).
        RVOL(t) = today's cumulative volume / AvgCum(t). The volume rule
        threshold = multiple x AvgCum(t); default multiple 2.0.
FR-6.2 (P0) The Baseline Job runs inside the scheduled runs before the open,
        handling ONE stock per run (a few hundred bars at a time) so no run
        exceeds the processor limit. Bar size (5 or 15 minutes) is chosen in
        Phase 0 from the measured processor time. Progress ("baselines 18/30")
        is visible on the dashboard. Adding a stock mid-day queues its baseline
        for the next pre-open window and shows "BUILDING" meanwhile.
FR-6.3 (P0) Previous Close, yesterday's high/low and volume are fetched once
        per day before the open and stored (consolidated daily bar).
FR-6.4 (P0) Guards (editable, zero allowed): no volume alert in the first 5
        minutes after the open; AvgCum(t) of at least 10,000 shares; at least 10
        baseline sessions. They prevent false crossings from tiny numbers.
FR-6.5 (P0) If a baseline is missing or implausible, that stock's volume rule
        shows NO BASELINE and does not alert; a Telegram notice lists the
        stock. The system never alerts from a broken baseline.
FR-6.6 (P1) Corporate actions (split, symbol change) are detected; the stock
        is flagged for the day and its Previous Close and baseline are not
        trusted until rebuilt.

------------------------------------------------------------------------------
FR-7  OPENING BRIEFING (FIRST MESSAGE OF THE DAY)
------------------------------------------------------------------------------
FR-7.1 (P0) About 60 seconds after the open (when opening prices exist) the
        system sends the Opening Briefing to Telegram and stores it on the
        dashboard. If the open is delayed, wait up to 10 minutes. Information
        only: no acknowledgment, no repeats.
FR-7.2 (P0) Fields per stock (requested by Salim):
        - Previous Close
        - Opening Price, with the gap from Previous Close in percent
        - Volume reference: average full-day volume, the 2x level in shares,
          and what 2x-to-this-time equals at key times (for example 10:00,
          11:00, 13:00 ET); labelled IEX
        - Yesterday's High
FR-7.3 (P0) Additions recommended:
        - Yesterday's Low and Volume
        - Salim's LOW and HIGH thresholds in dollars and their distance from the
          opening price
        - Stocks whose gap already crosses a threshold: listed first, marked,
          and they raise a normal threshold alert (FR-4)
        - Data-basis note (IEX) and any stock with no baseline, no data, or a
          corporate-action flag
        - Session facts: close time (flags an early close), time in ET and
          Muscat
FR-7.4 (P0) Compact layout, ordered by absolute gap, largest first; readable on
        the narrow screen; split into several messages if over Telegram's
        message length limit.
FR-7.5 (P1) 52-week high/low distance; earnings date flag (availability on the
        free data [UNVERIFIED]).

------------------------------------------------------------------------------
FR-8  DASHBOARD (HTML WEB APP SERVED BY THE WORKER)
------------------------------------------------------------------------------
FR-8.1 (P0) A single installable web app ("Add to Home screen"), files served
        by the Worker as static assets (free and unlimited requests
        [VERIFIED]). The page shell must NOT be routed through Worker code, so
        it still loads if the daily request allowance is ever exhausted
        [VERIFIED behaviour].
FR-8.2 (P0) Header: market status, data status (LIVE / DELAYED / NO DATA with
        the age of the last successful poll), number of unacknowledged alerts,
        time to the next reminder, "server last poll 12 s ago".
FR-8.3 (P0) REQUIRED FIELDS PER STOCK, visible without opening a detail screen:
        - Symbol
        - LAST RECORDED: price, time of that trade (ET and Muscat) and its age,
          with the freshness colour from section 5.3
        - PREVIOUS CLOSE
        - OPENING price
        - LOW alert threshold (dollars and % from Previous Close)
        - HIGH alert threshold (dollars and % from Previous Close)
        - Status: OK / NEAR (within 20% of the distance to a threshold, setting)
          / CROSSED - UNACKNOWLEDGED / ACKNOWLEDGED / MUTED / PAUSED / NO DATA /
          BUILDING
FR-8.4 (P0) Additional fields (compact): change from Previous Close in percent
        and dollars; distance to the nearest threshold; a range gauge from LOW
        to HIGH with markers for Previous Close, Opening and Last; volume line
        (cumulative volume, the multiple of the time-of-day average, the volume
        threshold, labelled IEX); day high and low (P1).
FR-8.5 (P0) Editing: tap LOW, HIGH or volume value to edit in place; input as a
        dollar price or percent from Previous Close with a live preview; saving
        applies at once (FR-2.4).
FR-8.6 (P0) Add and remove stocks, mute, pause rule, acknowledge, acknowledge
        all.
FR-8.7 (P0) Tabs: WATCHLIST (default), ALERTS (unacknowledged first, then
        history), BRIEFING, SETTINGS, LOG.
FR-8.8 (P0) Refresh: the page asks the server for the current state every 15
        seconds while visible (setting) and pauses when hidden. The page does no
        monitoring itself.
FR-8.9 (P0) Fold-aware layout: single column cards on the narrow screen, table
        or two columns on the wide screen; folding or rotating never reloads
        the page or loses an edit in progress. Touch targets of 48 dp or more;
        text scales with the phone's font setting.
FR-8.10 (P0) Authentication: a long random access code (32 characters or more),
        entered once and kept on the phone; sent with every request; the server
        limits wrong attempts (lock for 15 minutes after 10 failures); a
        "sign out everywhere" action replaces the code.
FR-8.11 (P0) Offline start: the shell opens without a network and shows NO
        CONNECTION; it never shows stale numbers as live.
FR-8.12 (P1) Suggestions: a "Suggest" button fills a proposed band (for
        example Previous Close plus/minus twice the stock's typical daily
        move) for Salim to accept or edit; never applied automatically.
FR-8.13 (P2) In-page alarm sound while the dashboard is open.

------------------------------------------------------------------------------
FR-9  MISSED-RUN CATCH-UP (GAP SCAN)
------------------------------------------------------------------------------
FR-9.1 (P0) Every run stores the time of its last successful poll.
FR-9.2 (P0) If a run starts more than 2 minutes after the previous successful
        poll while the market was open (a skipped schedule, a failed run, a data
        outage), it fetches the one-minute bars for the gap (high, low, volume)
        and tests every enabled rule against them.
FR-9.3 (P0) Any crossing found in the gap that has not been alerted or
        acknowledged raises a LATE alert at once, stating the minute it
        happened and the price at that bar, and starts the reminder cycle.
FR-9.4 (P0) The scan covers only time inside the market session and uses the
        same false-crossing protection (FR-3.4).
FR-9.5 (P1) End-of-session audit: after the close, the system re-checks the
        whole day's one-minute bars against all thresholds and reports any
        crossing that did not produce an alert (target: none).

------------------------------------------------------------------------------
FR-10  HEALTH, WATCHDOG AND BUDGET GUARD
------------------------------------------------------------------------------
FR-10.1 (P0) Silent messages: "READY" at about 09:00 ET (with stocks active,
        baselines complete/incomplete, calendar status) and "SESSION ENDED"
        after the close. If the READY message does not arrive, Salim knows the
        system is not running.
FR-10.2 (P1) Independent watchdog: a free external uptime monitor checks a
        health address every 5 minutes during market hours and messages Salim
        if it fails [service to be chosen; free terms UNVERIFIED]. The health
        address reports the last poll time and never reveals data.
FR-10.3 (P0) Operational notices (rate-limited to one per 30 minutes per type):
        data provider errors, stale data over 2 minutes, baseline failures,
        Telegram send failures, database errors, calendar problems.
FR-10.4 (P0) Budget guard: the system tracks its own database writes and
        requests for the day; at 70% of any free allowance it sends a warning
        and reduces non-essential writes; it never lets logging crowd out
        alert state.
FR-10.5 (P0) Processor guard: each run measures its own elapsed work; if a run
        approaches the limit it drops optional work (logging, tidy-up) first
        and records the event. Phase 0 sets the measured budget.
FR-10.6 (P0) /status and the dashboard header show the same health facts.

------------------------------------------------------------------------------
FR-11  LOG AND HISTORY
------------------------------------------------------------------------------
FR-11.1 (P0) Every first alert, reminder, acknowledgment, late alert, settings
        change, error and suppressed event (with reason) is logged with
        timestamps (UTC stored; ET and Muscat shown).
FR-11.2 (P0) Retention: 90 days, purged daily; stays well under the free
        storage limit.
FR-11.3 (P0) The LOG tab and /why XYZ HH:MM answer "why did or didn't I get an
        alert": price, thresholds in force and rule state at that time.
FR-11.4 (P0) Export as CSV or JSON.

------------------------------------------------------------------------------
FR-12  SETTINGS
------------------------------------------------------------------------------
FR-12.1 (P0) Settings: reminder interval (default 10 min); auto-clear toggle;
        re-arm buffers; volume guards; baseline window; "near" distance;
        dashboard refresh; reminder tidy-up; mute defaults; calendar status; app
        version.
FR-12.2 (P0) Secrets (data keys, bot token, webhook secret, dashboard access
        code) are held only in the Worker's secret store, not in the database,
        repository or logs, and are never shown after entry.
FR-12.3 (P0) A written key-rotation procedure for every secret.

------------------------------------------------------------------------------
FR-13  TEST MODE
------------------------------------------------------------------------------
FR-13.1 (P0) /test (and a dashboard button) sends a clearly labelled TEST alert
        through the real path (message, buttons, reminder, acknowledge) with
        reminders accelerated (every minute), using a fake symbol, isolated
        from real alert state and logs.
FR-13.2 (P0) Automated tests with a fake clock and recorded market data cover
        the rule engine and the state machine (crossing, reminders,
        acknowledgment race, re-arm, close, gap scan, duplicate runs).
FR-13.3 (P1) Replay tool: run recorded one-minute data through the same engine
        to measure missed crossings and alert counts.

------------------------------------------------------------------------------
FR-14  DEPLOYMENT AND MAINTAINABILITY
------------------------------------------------------------------------------
FR-14.1 (P0) Code lives in a PUBLIC GitHub repository named Market-Monitor and holds
        no secret, threshold, watchlist or personal data. Automated tests run on
        every change. Deployment to Cloudflare happens from GitHub using a
        narrowly scoped deploy token stored as a GitHub secret, or by command
        from a developer machine. Using GitHub Actions only for testing and
        deployment of this project is the use the terms allow; the monitor
        itself never runs on GitHub.
FR-14.2 (P0) Deploy freeze: no deployment between 08:30 and 16:30 New York time
        on trading days unless an explicit emergency override is used.
FR-14.3 (P0) Database changes are backward compatible; a deployment can be rolled
        back without data loss.
FR-14.4 (P0) PORTABILITY: the rule engine, alert state machine and message
        formatting are independent of Cloudflare; data access, time, storage and
        Telegram sending are behind small interfaces, so the same engine can run
        on a Mac mini or a cloud server if DG-1 chooses the escalation path.
FR-14.5 (P0) Version number visible in the dashboard and in /status.
FR-14.6 (P0) A short runbook: set-up, daily checks, what each health message
        means, rotating keys, restoring from export.


==============================================================================
7. NON-FUNCTIONAL REQUIREMENTS
==============================================================================
7.1  Cost: zero. If any component would need payment at the chosen scale, the
     developer flags it before using it.
7.2  Detection delay: a crossing is detected within one poll interval (target
     15 seconds) and the Telegram message is sent within 5 seconds of
     detection, 95th percentile, excluding the data feed's own delay [targets
     to be confirmed by the Phase 0 measurement].
7.3  Reminder timing: within 60 seconds of the due time.
7.4  Availability: at least one successful poll in 99% of session minutes over
     a month; no silent misses (FR-9).
7.5  Processor time per run: 8 ms or less, 99th percentile.
7.6  Free-tier use: under 50% of every free allowance on a normal day.
7.7  Dashboard: loads in under 2 seconds on the phone; no third-party scripts,
     fonts or trackers; works on current Chrome on the Samsung phone.
7.8  Accessibility: colour never the only signal; sufficient contrast; large
     touch targets.
7.9  Zero AI dependency: no Claude or other LLM call, key or SDK in the product
     or build. (Using an AI assistant to write the code is separate.)
7.10 Provider terms: data used only for Salim's personal monitoring; no
     redistribution.


==============================================================================
8. SECURITY AND PRIVACY
==============================================================================
S-1  Account protection: two-step verification on the Cloudflare account AND on
     the Gmail account used to register it (the email account can reset the
     Cloudflare password); strong unique passwords; recovery codes stored
     offline.
S-2  Secrets only in the Worker's secret store and GitHub's secret store; never
     in code, config, database, logs or messages. Deploy token limited to this
     Worker and database.
S-3  Data keys are read-only market-data keys from a paper-trading account; the
     system contains no order-placing code.
S-4  Telegram: webhook protected by a secret header; only Salim's chat id is
     served; the bot token is rotated if exposed. Telegram bot chats are not
     end-to-end encrypted, so alerts contain only tickers, prices and volumes,
     nothing identifying.
S-5  Dashboard: access code of 32+ random characters, login attempt limits,
     strict Content Security Policy, no third-party requests, all displayed
     text inserted as text (never as HTML). Anyone can load the page shell but
     can read or change nothing without the code.
S-6  Public repository holding code only; branch protection; secret scanning and push protection
     on; two-step verification on GitHub; dependency changes reviewed.
S-7  Privacy: Alpaca, Cloudflare and Telegram necessarily see the symbols,
     thresholds or alerts they process. Nothing else is shared.
S-8  If the phone is lost: sign out everywhere (dashboard), remove the Telegram
     session from another device, rotate the dashboard code.
S-9  Failure mode: missing or rejected secrets stop alerting and produce one
     clear message; the system never appears live when it is not.


==============================================================================
9. UX ALTERNATIVES - REQUIRED BEFORE ANY COMMITMENT (DECISION GATE DG-3)
==============================================================================
9.1 Rule
The developer must present THREE materially different experiences for the
Telegram messages and the dashboard, and get Salim's written choice before
building message layouts, buttons or screens. Engine, storage, calendar, data
and rule work may proceed in parallel.

9.2 What each alternative must show (as the exact text and buttons Telegram
    would display, using a throwaway test bot, plus clickable dashboard
    mock-ups on Salim's phone; static images at minimum)
  a) Opening Briefing for 6 sample stocks
  b) A HIGH alert, a LOW alert and a VOLUME alert (first message)
  c) Reminder 3 and the acknowledge flow, including "Acknowledge and move
     threshold"
  d) A LATE alert; an "Unacknowledged at close" summary
  e) The READY and SESSION ENDED messages; an operational error notice
  f) Dashboard on the narrow cover screen and the wide inner screen with 8
     sample stocks: normal, NEAR, CROSSED - UNACKNOWLEDGED, ACKNOWLEDGED,
     stale data
  g) The five required numbers (Last recorded, Previous Close, Opening, LOW,
     HIGH) visible for every stock
  h) Editing a threshold (dollar and percent entry) and the "already crossed"
     confirmation
  i) /status and one /set command exchange
  j) Trade-offs: strengths, weaknesses, number of messages on a quiet and on a
     busy day, implementation effort
9.3 Constraints to design around: Telegram edits do not notify; messages have a
    length limit; the narrow screen allows about 38 characters per line;
    reminders must be impossible to mistake for the first alert.
9.4 Minimum differentiation: structure, not styling. Suggested starting
    directions (the developer may propose better ones, with reasons):
  ALTERNATIVE A - "GLANCE LINE"
     Each alert is two or three lines (icon, symbol, rule, price, change,
     multiple, time) with an Acknowledge button; a "Details" button expands the
     full card. Lowest reading effort; most messages.
  ALTERNATIVE B - "DECISION CARD"
     Each alert is a compact card with everything from FR-5.5 grouped in short
     blocks (Price / Levels / Volume / Time) and action buttons. Highest
     information per alert; fewer, longer messages.
  ALTERNATIVE C - "LIVE BOARD"
     One pinned status message per session, edited in place, listing every
     stock's state and the alerts needing action; a new short, notifying
     message appears only when a threshold is crossed or a reminder is due.
     Fewest notifications and best overview; risk: edits do not notify.
9.5 Evaluation criteria for Salim: five numbers readable in 3 seconds or less;
    clear which alert needs action now; one-tap acknowledge with no mis-taps at
    night; readable on both screens; quiet when quiet, unmistakable when not;
    effort and risk.
9.6 Gate output: a one-page decision record naming the chosen alternative and
    any hybrid changes; the developer may not change it without new approval.


==============================================================================
10. TESTING AND ACCEPTANCE CRITERIA
==============================================================================
Rules and lifecycle (fake clock, recorded data)
  AT-1  A valid price at or beyond HIGH or LOW sends the first alert in the
        same run; a price inside the band sends nothing.
  AT-2  A one-minute bar whose high or low crosses a threshold while the latest
        trade has moved back is detected and labelled "touched at HH:MM".
  AT-3  Over 20 replayed sessions with Salim's real thresholds: every real
        crossing produced an alert and every alert was a real crossing (zero
        false, zero missed), shown by an audit report.
  AT-4  Unacknowledged alert: reminders at T0+10, +20, +30 minutes, each within
        60 seconds of due, including after price returns inside the band.
  AT-5  Acknowledge by button, dashboard, /ack and "acknowledge all" each stops
        reminders within 2 seconds; the Telegram message shows "Acknowledged".
  AT-6  Acknowledgment race: acknowledging at the moment a reminder is due
        causes at most one extra reminder and none afterwards.
  AT-7  After acknowledgment no new alert until the re-arm condition is met and
        the threshold is crossed again; editing a threshold re-arms at once.
  AT-8  Volume: with a replayed volume spike the alert fires at the first poll
        where the multiple reaches the threshold; none before open + 5 minutes
        or for a stock with no baseline.
  AT-9  Two overlapping runs produce no duplicate alerts or reminders.
Market hours and calendar
  AT-10 No alert and no reminder on weekends, holidays or outside the session,
        over a full calendar month including one holiday.
  AT-11 Early close day: session ends at the right time; unacknowledged alerts
        stop reminding at the close and are flagged.
  AT-12 Simulated US clock change and an expired calendar behave as in FR-1.3
        and FR-1.5.
Opening Briefing
  AT-13 The briefing shows Previous Close, Opening Price, the 2x average volume
        reference and Yesterday's High for every enabled stock within 90 seconds
        of the open.
Resilience (the point of v3.0)
  AT-14 Phone locked for the whole session: alerts and reminders arrive and
        sound; phone in airplane mode for 30 minutes during an alert: messages
        are waiting on return and only the latest reminder remains (FR-4.12).
  AT-15 Skipped schedule runs (simulate 5 missed minutes): a crossing inside the
        gap yields a LATE alert with the right minute; reminders resume.
  AT-16 Cadence: over at least 3 live sessions, 99% or more of session minutes
        have at least one successful poll; the median poll interval is
        reported; if the target is missed DG-1 is reopened.
  AT-17 Processor time per run 8 ms or less at the 99th percentile; calls per
        run 45 or fewer; daily free-tier use under 50% of each allowance.
  AT-18 Telegram rate limit and outage: alerts queue and are sent in priority
        order; none lost.
  AT-19 Data provider outage of 2 minutes: NO DATA shown, one notice sent, gap
        scan on recovery.
Security and quality
  AT-20 Webhook calls without the secret header, and messages from any other
        chat, are rejected silently; the dashboard rejects requests without the
        access code and locks after repeated failures.
  AT-21 Repository, logs and messages contain no secrets; starting without
        valid secrets fails safely (S-9).
  AT-22 Deploy freeze (FR-14.2) blocks a deployment at 10:00 ET.
  AT-23 No AI/LLM SDK or call appears in the code or build.
  AT-24 Restore: wiping and importing the exported configuration reproduces the
        same watchlist and thresholds.
Shadow trial
  AT-25 Two live trading weeks with real thresholds. The end-of-session audit
        (FR-9.5) shows zero missed crossings; Salim confirms the messages and
        reminders behave as intended before relying on the system.


==============================================================================
11. DELIVERY PLAN
==============================================================================
SALIM'S SET-UP CHECKLIST (before or during Phase 0)
  1. Cloudflare account: registered. Turn on two-step verification there and
     on the Gmail account used.
  2. Telegram: create the bot in BotFather (name it as you like); keep the
     token private; message the bot once so its chat id can be read.
  3. Alpaca: open the free paper-trading account; create data keys.
  4. GitHub: sign in once on the build computer (section 16); Claude creates
     the repository.
  5. Phone: allow Telegram notifications, set a loud sound for the bot chat,
     add a Do Not Disturb exception, exclude Telegram from battery
     optimization.
PHASE 0 - FEASIBILITY SPIKES (about 3-5 working days)
  - Alpaca account and fields (section 5.4); Finnhub fallback fields.
  - Worker schedule: processor time per run, achievable polls per minute, start
    delay (jitter), behaviour of failed runs, call counting for the database.
  - Database write/read usage; baseline build at 5- vs 15-minute bars.
  - Telegram: webhook from the Worker, button callbacks, sound/Do Not Disturb
    on the Fold with the phone locked and in airplane mode.
  - IEX volume stability on Salim's stocks.
  - Deploy pipeline from the repository.
  - Output: short findings report; DG-1 and DG-2 decided.
PHASE 1 - UX DECISION (in parallel with Phase 2, about 1 week): section 9.
PHASE 2 - ENGINE: calendar, storage, data adapter, baseline job, rule engine,
  state machine, lock, gap scan, automated tests.
PHASE 3 - TELEGRAM AND DASHBOARD: chosen UX, webhook, commands, buttons,
  Opening Briefing, dashboard, authentication.
PHASE 4 - RESILIENCE: health messages, budget and processor guards, audit,
  backup/restore, failure-injection tests, security checks, runbook.
PHASE 5 - SHADOW TRIAL AND GO-LIVE: two weeks (AT-25), then go/no-go.


==============================================================================
12. RISKS AND MITIGATIONS
==============================================================================
R-1  Minute-level polling is too coarse for fast spikes. Mitigation: 10-15
     second polling inside each run, bar high/low evidence, gap scan, DG-1
     escalation path to an always-on host.
R-2  The 10 ms processor limit is exceeded as the watchlist grows. Mitigation:
     tiny code, one batched data call per poll, processor guard, measured
     capacity, stock cap, escalation path.
R-3  A schedule run is skipped and never retried. Mitigation: FR-9 gap scan,
     external watchdog (P1), READY message.
R-4  Free allowances change or are enforced differently. Mitigation: budget
     guard, portability (FR-14.4), quarterly check of provider terms.
R-5  IEX-only data: stale last price, noisy volume. Mitigation: age display,
     labels, stability check, bar high/low evidence.
R-6  Telegram outage or phone settings silence alerts. Mitigation: setup
     checklist, test alert, reminders, health messages, optional backup channel.
R-7  Cloudflare or Gmail account takeover would expose alerting and keys.
     Mitigation: section 8 S-1/S-2, data-only paper keys.
R-8  The dashboard address is public. Mitigation: access code, rate limiting,
     no data without the code.
R-9  Alpaca sign-up unavailable from Oman. Mitigation: Phase 0; Finnhub fallback
     for price rules; revisit volume rule.
R-10 Reminder fatigue overnight. Mitigation: this is the requested behaviour;
     controls are the interval and "Acknowledge and move threshold".
R-11 Expired holiday calendar or clock-change error. Mitigation: FR-1.3, AT-12.
R-12 A bad deployment during the session. Mitigation: FR-14.2 deploy freeze and
     rollback.


==============================================================================
13. OPEN QUESTIONS FOR SALIM
==============================================================================
Q1  How many stocks, and are they large liquid names? (Thin names make IEX
    prices and volume unreliable.)
Q2  Is checking every 10-15 seconds (guaranteed at least once a minute) fast
    enough, or do you need every trade?
Q3  Should reminders continue after the price returns inside the band (as
    written) or stop automatically?
Q4  Are the re-arm buffers (0.2% price, 10% volume) acceptable?
Q5  Should volume alerts also require acknowledgment and repeat every 10
    minutes (as written)?
Q6  Dollars or percent from Previous Close as the default way you enter
    thresholds?
Q7  Is "yesterday max" the previous day's high price?
Q8  Do you want the dashboard served by the Worker (recommended) or GitHub Pages?
Q9  Do you want a backup alert channel (second Telegram chat or email) for
    system-health problems?
Q10 Is a daily end-of-session summary message wanted?


==============================================================================
14. GLOSSARY
==============================================================================
Previous Close      Official closing price of the last regular session.
Opening price       First regular-session price of the day (IEX-based here).
Last recorded       Last valid trade price received, with its time and age.
Threshold           A LOW or HIGH price level, or a volume level, set by Salim.
Crossed             Price at or beyond a threshold; volume at or above it.
RVOL                Cumulative volume today divided by the average cumulative
                    volume at the same time of day.
Reminder            Repeat message every 10 minutes while unacknowledged.
Acknowledge         Explicit tap or command that stops reminders for a rule.
Re-arm              The condition after which a rule may alert again.
Poll                One request to the data provider for current market data.
Run                 One execution of the Worker's schedule (one per minute).
Worker              Small program hosted by Cloudflare that runs on a schedule
                    and answers web requests.
D1                  Cloudflare's SQL database used for all stored state.
IEX                 One US stock exchange; the free real-time data covers its
                    trades only.
Late alert          Alert raised after a missed run for a crossing that
                    happened earlier.
DG                  Decision gate: requires Salim's approval.


==============================================================================
15. SOURCES CHECKED (24 NOVEMBER 2026)
==============================================================================
- Cloudflare Workers documentation: limits (free plan: 100,000 requests a day,
  10 ms processor time, 50 external requests per run; scheduled runs up to 15
  minutes of elapsed time; waiting on the network is not processor time),
  Cron Triggers (every-minute schedule, 5 per account on the free plan, UTC),
  static assets (free and unlimited; avoid routing the page shell through
  Worker code), D1 pricing and limits (free: 100,000 rows written and 5 million
  rows read a day, 5 GB; queries fail past the limit; enforced since 1 Sep
  2026), changelog on subrequest limits.
- Telegram Bot API: setWebhook secret token header, callback queries, sending
  and rate-limit guidance (about one message per second per chat, 30 per second
  overall).
- Alpaca docs: Market Data plans (free IEX data, 200 REST calls a minute, SIP
  history delayed 15 minutes) and FAQ (IEX vs consolidated volume example).
- Finnhub pricing (60 calls a minute, candles premium).
- GitHub terms for additional products and features, version of 27 Aug 2026
  (Actions not to be used for serverless computing, also with self-hosted
  runners): the reason the monitor does not run on GitHub.
Not checked in this session (developer to verify in Phase 0): Alpaca account
from Oman and the exact snapshot fields on the free feed; the achievable poll
rate and jitter of scheduled runs; D1 call counting per run; Telegram
notification settings on the phone; halt data on the free feed; 2026-2027
exchange calendar dates; free external uptime monitors; Finnhub earnings
calendar on the free plan.


==============================================================================
16. BUILD INSTRUCTIONS FOR CLAUDE CODE AND DIVISION OF WORK
==============================================================================
16.1 Principle: Claude Code does everything that can be automated. Salim is
asked only for what a human must do (16.4). Claude Code never asks Salim to
paste a secret into chat, a file, a commit or a Gist.

16.2 Working method
- Work in a project folder on Salim's computer, cloned from the repository.
  Commit in small steps and push after each working piece (calendar, rules,
  state machine, Telegram, dashboard), not only at the end.
- Present the three UX alternatives (section 9) and wait for approval before
  building messages or screens. Engine work may proceed meanwhile.

16.3 What Claude Code does by itself (after Salim completes 16.4 item 1)
  a) Create the public repository "Market-Monitor" under Salim's account with
     the GitHub command-line tool (GitHub names cannot contain a space, so
     "Market Monitor" becomes "Market-Monitor"). Add README, licence note,
     .gitignore (must list .dev.vars, .env, wrangler secrets files), branch
     protection and secret scanning with push protection.
  b) Create the Cloudflare database, the Worker configuration, the every-
     minute schedule and the static dashboard assets with the Cloudflare
     command-line tool, using the deploy token from 16.4.
  c) Generate the two random secrets (webhook secret, dashboard access code)
     locally, store them straight into the Worker's secret store, and show
     the dashboard code to Salim once on screen only. Never write either to
     a file, commit, log or message.
  d) Register the Telegram webhook with the secret header (FR-5.2).
  e) Write code, automated tests, the deploy workflow (tests and deploy only,
     never the monitor itself) and the runbook (FR-14.6).
  f) Create the GIST (16.5).
  g) Run the Phase 0 spikes that need no human and report findings.

16.4 What only Salim can do (Claude Code asks for exactly these, nothing else)
  1. On the build computer, run the GitHub sign-in once (gh auth login) and
     approve it in the browser. Turn on two-step verification on GitHub.
  2. Cloudflare: turn on two-step verification (and on the Gmail account);
     create ONE API token with "Edit Workers" and database permissions,
     restricted to this account; type it into the terminal prompt that Claude
     Code opens (not into chat).
  3. Telegram: create the bot in BotFather; message the bot once; enter the
     bot token at a terminal prompt so it goes straight to the Worker's secret
     store.
  4. Alpaca: open the free paper-trading account and create the data keys
     (the key id and secret are entered at a terminal prompt; the secret is
     shown only once on Alpaca's page).
  5. Optional: Finnhub free key, entered the same way.
  6. Phone: allow Telegram notifications, loud sound, Do Not Disturb
     exception, no battery optimization; install the dashboard to the home
     screen; run /test and confirm sound.
  7. Decisions only Salim makes: UX alternative (DG-3), cadence (DG-1),
     data source (DG-2), thresholds and watchlist.
  Anything else (accounts' technical set-up, commands, files, configuration,
  tests, deployment) is Claude Code's job and must not be handed to Salim.

16.5 The Gist (what it may and may not contain)
  Purpose: a short, shareable SETUP CHECKLIST for Salim's own reference.
  Contents allowed: the list of secret NAMES (ALPACA_KEY_ID,
  ALPACA_SECRET_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
  TELEGRAM_WEBHOOK_SECRET, DASHBOARD_ACCESS_CODE, optional FINNHUB_API_KEY,
  and the two deploy values CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID),
  where each one is created, where it is stored, and the rotation steps.
  Contents FORBIDDEN: any secret value, key, token, access code or chat id.
  Reason: a secret Gist is only unlisted; anyone with its link can read it,
  and the Worker cannot use it at run time. All real secret values live only
  in the Worker's secret store and in GitHub's Actions secret store (deploy
  token only), and in Salim's password manager.
  Claude Code creates the Gist (secret/unlisted setting, names only) with the
  GitHub command-line tool and gives Salim its link.

16.6 Acceptance for this section
  AT-26 The repository Market-Monitor exists, is public, has secret scanning
        and push protection on, and a scan of the whole history finds no secret.
  AT-27 The Gist exists and contains names and instructions only (no values).
  AT-28 Salim was asked only for the items in 16.4 during the build.

==============================================================================
END OF DOCUMENT
==============================================================================
