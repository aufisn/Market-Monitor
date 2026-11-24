# Market Monitor: UX alternatives for decision gate DG-3

Version: mock-up 1 · Date of sample day: Mon 30 Nov 2026 · Status: **waiting for Salim's choice** (PRD section 9)

All tickers, prices, thresholds and volumes below are **invented sample data**. Muscat time is ET + 9 h in winter. Open `ux/index.html` in any browser (phone or laptop, straight from disk) to click through the same messages, the dashboards, the threshold editor and the trade-offs.

## How to send these through a throwaway test bot

1. Create a separate test bot in BotFather (never the real bot). Keep its token private; do not paste it into any file.
2. Put the token and your chat id in your shell only, for example `export BOT=...` and `export CHAT=...` (not in the repository).
3. For each message below, send the text exactly as shown with `parse_mode=HTML`. Silent messages use `disable_notification=true`. Buttons go in `reply_markup` (the JSON is given for every message).

```
curl -s "https://api.telegram.org/bot$BOT/sendMessage" \
  --data-urlencode "chat_id=$CHAT" \
  --data-urlencode "parse_mode=HTML" \
  --data-urlencode "disable_notification=false" \
  --data-urlencode "text@message.txt" \
  --data-urlencode "reply_markup@keyboard.json"
```

Put the message text in `message.txt` and the `inline_keyboard` JSON in `keyboard.json` (as `{"inline_keyboard": ...}`). The "Dashboard" button uses a placeholder URL (`https://example.com/dashboard`); replace it or drop that button for the test. Text only uses the Telegram HTML subset (`<b>`, `<i>`, `<code>`), no ampersands or angle brackets in the content, and no monospace tables.

## Rules every alternative follows (PRD 9.3)

- Lines are **38 characters or fewer**, counting each emoji as 2 (checked by `ux/check.mjs`). No wide tables.
- Telegram edits do not notify. Anything that must make a sound is a **new** message ("🔔 notifies"). Edits are marked "🔕 silent edit".
- A reminder always starts with **🔁 REMINDER n** and says it is not new; a first alert always starts with **🚨 NEW** (A, C) or **🚨 NEW ALERT** (B). The mock-up also gives them different left borders (solid versus dashed), so colour is never the only signal.
- Volume is always **IEX volume**; the opening price is always **Opening (IEX)** (shortened to `Open(IEX)` or `Op` only where space forces it, with a legend line).
- Times are ET and Muscat. Telegram draws its own inline buttons (about 40 dp high, not controllable); the Acknowledge button is therefore always on its own row so a night-time mis-tap lands on something harmless. On the dashboard every target is 48 dp or more.
- Dashboard: colour is never the only signal (icon + word + outline style), dark mode follows the system, five required numbers are on every stock without opening details (FR-8.3).

## Assumptions to confirm (they affect every alternative)

1. **"+1%" and "+2%" in Acknowledge and move threshold** are taken as a move of the crossed threshold further out by that percentage of the threshold itself (HIGH 145.00 → 146.45, LOW 200.00 → 198.00). If you want it relative to Previous Close, say so.
2. **Volume rules** have no sensible "+1%" step. The mock-ups offer "Ack + move" on price alerts only; for VOLUME the proposal is "+0.5x / +1.0x / typed". Not drawn yet.
3. **Typed value** must be beyond the latest price, otherwise it would alert at once (the bot answers "not understood" or "would alert at once").
4. The Opening Briefing is sent with a notification (it is the one planned morning message). READY and SESSION ENDED are silent (FR-10.1).
5. Muscat date: the session ends after midnight in Muscat; messages show the New York trading date.

---

## Alternative A: "Glance Line"

*Two or three lines per alert, details on demand.*

Every alert is 3 lines you can read on the lock screen. A Details button expands the message in place (an edit, so no extra notification). Acknowledge is always the first, full-width button.

**What I sharpened compared with PRD 9.4:** Added: Details expands in place (no new message), Acknowledge on its own row so a night-time mis-tap lands on the harmless Details button, and the dashboard is a sorted list with the five numbers on every row.

### A · a) Opening Briefing, 6 sample stocks

Sent about 60 s after the open: 09:31 ET / 18:31 Muscat. Information only, no acknowledge, no repeats.

#### Opening Briefing (6 stocks)  `🔔 notifies`

*State 1: As sent (collapsed)*
```
☀️ <b>OPENING BRIEFING</b>
Mon 30 Nov · 09:31 ET / 18:31 Muscat
Close 16:00 ET / 01:00 Muscat
Sorted by gap · prices IEX
PC = Previous Close

<b>NVDA</b> +2.06% Open(IEX) 141.05
PC 138.20 · yHigh 139.40

⚠️ <b>MSFT</b> -0.76% Open(IEX) 418.60
PC 421.80 · yHigh 424.30
<b>LOW 420.00 crossed at open</b>

<b>JPM</b> -0.37% Open(IEX) 240.20
PC 241.10 · yHigh 243.00

<b>AAPL</b> +0.32% Open(IEX) 237.15
PC 236.40 · yHigh 238.10

<b>AMZN</b> -0.29% Open(IEX) 206.90
PC 207.50 · yHigh 209.00

<b>XOM</b> +0.22% Open(IEX) 111.55
PC 111.30 · yHigh 112.40

<i>Tap Details for volume levels.</i>
```

Buttons (one row per line):

```
[ℹ️ Details] [📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"ℹ️ Details","callback_data":"details:a-brief"},{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

*State 2: After Details (expanded in place)*
```
☀️ <b>OPENING BRIEFING</b>
Mon 30 Nov · 09:31 ET / 18:31 Muscat
Close 16:00 ET / 01:00 Muscat
Sorted by gap · prices IEX
PC = Previous Close

<b>NVDA</b> +2.06% Open(IEX) 141.05
PC 138.20 · yHigh 139.40 · yLow 136.80
Yesterday IEX volume 6.10M
LOW 130.00 (-7.8% vs open)
HIGH 145.00 (+2.8% vs open)
IEX avg/day 6.80M · 2x = 13.6M
2x IEX by 10:00 2.31M · 11:00 4.08M
2x IEX by 13:00 7.48M

⚠️ <b>MSFT</b> -0.76% Open(IEX) 418.60
PC 421.80 · yHigh 424.30 · yLow 419.10
Yesterday IEX volume 1.30M
LOW 420.00 (+0.3% vs open) ⚠️
HIGH 435.00 (+3.9% vs open)
IEX avg/day 1.40M · 2x = 2.80M
2x IEX by 10:00 0.48M · 11:00 0.84M
2x IEX by 13:00 1.54M
<b>LOW crossed at open - alert follows</b>

<b>JPM</b> -0.37% Open(IEX) 240.20
PC 241.10 · yHigh 243.00 · yLow 239.20
Yesterday IEX volume 0.80M
LOW 235.00 (-2.2% vs open)
HIGH 250.00 (+4.1% vs open)
IEX avg/day 0.90M · 2x = 1.80M
2x IEX by 10:00 0.31M · 11:00 0.54M
2x IEX by 13:00 0.99M

<b>AAPL</b> +0.32% Open(IEX) 237.15
PC 236.40 · yHigh 238.10 · yLow 234.90
Yesterday IEX volume 1.90M
LOW 230.00 (-3.0% vs open)
HIGH 245.00 (+3.3% vs open)
IEX avg/day 2.10M · 2x = 4.20M
2x IEX by 10:00 0.71M · 11:00 1.26M
2x IEX by 13:00 2.31M

<b>AMZN</b> -0.29% Open(IEX) 206.90
PC 207.50 · yHigh 209.00 · yLow 205.20
Yesterday IEX volume 1.70M
LOW 200.00 (-3.3% vs open)
HIGH 215.00 (+3.9% vs open)
IEX avg/day 1.80M · 2x = 3.60M
2x IEX by 10:00 0.61M · 11:00 1.08M
2x IEX by 13:00 1.98M

<b>XOM</b> +0.22% Open(IEX) 111.55
PC 111.30 · yHigh 112.40 · yLow 110.40
Yesterday IEX volume 1.00M
LOW 108.00 (-3.2% vs open)
HIGH 115.00 (+3.1% vs open)
IEX avg/day 1.10M · 2x = 2.20M
2x IEX by 10:00 0.37M · 11:00 0.66M
2x IEX by 13:00 1.21M
```

Buttons (one row per line):

```
[ℹ️ Details] [📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"ℹ️ Details","callback_data":"details:a-brief"},{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

### A · b) First alerts: HIGH, LOW, VOLUME

Each first alert is sent in the same run as the crossing. Tap the buttons to try them.

#### HIGH alert (NVDA)  `🔔 notifies`

*State 1: As sent*
```
🚨 NEW 📈 <b>NVDA HIGH</b> 145.60
+5.35% · IEX vol 1.3x
10:22 ET / 19:22 Muscat
```

Buttons (one row per line):

```
[✅ Acknowledge]
[ℹ️ Details] [↗ Ack + move]
[🔕 Mute 1h] [📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"✅ Acknowledge","callback_data":"ack:a-high"}],[{"text":"ℹ️ Details","callback_data":"details:a-high"},{"text":"↗ Ack + move","callback_data":"ackmove:a-high"}],[{"text":"🔕 Mute 1h","callback_data":"mute:a-high"},{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

*State 2: After tapping Details (message edited, no new notification)*
```
🚨 NEW 📈 <b>NVDA HIGH</b> 145.60
Limit: HIGH 145.00 (LOW 130.00)
Last 145.60 · +7.40 (+5.35%)
Prev Close 138.20
Opening (IEX) 141.05
IEX volume 1.62M · 1.3x avg
Crossed 10:22 ET / 19:22 Muscat
Unacknowledged 0 min · alert #1
```

Buttons (one row per line):

```
[✅ Acknowledge]
[ℹ️ Details] [↗ Ack + move]
[🔕 Mute 1h] [📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"✅ Acknowledge","callback_data":"ack:a-high"}],[{"text":"ℹ️ Details","callback_data":"details:a-high"},{"text":"↗ Ack + move","callback_data":"ackmove:a-high"}],[{"text":"🔕 Mute 1h","callback_data":"mute:a-high"},{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

*State 3: After Acknowledge*
```
✅ <b>NVDA HIGH</b> acknowledged
Acknowledged 19:23 Muscat (10:23 ET)
No more reminders for this alert.
```

#### LOW alert (AMZN)  `🔔 notifies`

*State 1: As sent*
```
🚨 NEW 📉 <b>AMZN LOW</b> 199.85
-3.69% · IEX vol 1.2x
13:15 ET / 22:15 Muscat
```

Buttons (one row per line):

```
[✅ Acknowledge]
[ℹ️ Details] [↗ Ack + move]
[🔕 Mute 1h] [📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"✅ Acknowledge","callback_data":"ack:a-low"}],[{"text":"ℹ️ Details","callback_data":"details:a-low"},{"text":"↗ Ack + move","callback_data":"ackmove:a-low"}],[{"text":"🔕 Mute 1h","callback_data":"mute:a-low"},{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

*State 2: After tapping Details (message edited, no new notification)*
```
🚨 NEW 📉 <b>AMZN LOW</b> 199.85
Limit: LOW 200.00 (LOW 200.00)
Last 199.85 · -7.65 (-3.69%)
Prev Close 207.50
Opening (IEX) 206.90
IEX volume 1.10M · 1.2x avg
Crossed 13:15 ET / 22:15 Muscat
Unacknowledged 0 min · alert #1
```

Buttons (one row per line):

```
[✅ Acknowledge]
[ℹ️ Details] [↗ Ack + move]
[🔕 Mute 1h] [📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"✅ Acknowledge","callback_data":"ack:a-low"}],[{"text":"ℹ️ Details","callback_data":"details:a-low"},{"text":"↗ Ack + move","callback_data":"ackmove:a-low"}],[{"text":"🔕 Mute 1h","callback_data":"mute:a-low"},{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

*State 3: After Acknowledge*
```
✅ <b>AMZN LOW</b> acknowledged
Acknowledged 22:16 Muscat (13:16 ET)
No more reminders for this alert.
```

#### VOLUME alert (JPM)  `🔔 notifies`

*State 1: As sent*
```
🚨 NEW 📊 <b>JPM VOLUME</b> 2.0x
IEX volume 0.62M · avg 0.31M
10:42 ET / 19:42 Muscat
```

Buttons (one row per line):

```
[✅ Acknowledge]
[ℹ️ Details] [↗ Ack + move]
[🔕 Mute 1h] [📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"✅ Acknowledge","callback_data":"ack:a-vol"}],[{"text":"ℹ️ Details","callback_data":"details:a-vol"},{"text":"↗ Ack + move","callback_data":"ackmove:a-vol"}],[{"text":"🔕 Mute 1h","callback_data":"mute:a-vol"},{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

*State 2: After tapping Details (message edited, no new notification)*
```
🚨 NEW 📊 <b>JPM VOLUME</b> 2.0x
Limit: VOLUME ≥ 2.0x average
Last 241.75 · +0.65 (+0.27%)
Prev Close 241.10
Opening (IEX) 240.20
IEX volume 0.62M · 2.0x avg
Crossed 10:42 ET / 19:42 Muscat
Unacknowledged 0 min · alert #1
```

Buttons (one row per line):

```
[✅ Acknowledge]
[ℹ️ Details] [↗ Ack + move]
[🔕 Mute 1h] [📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"✅ Acknowledge","callback_data":"ack:a-vol"}],[{"text":"ℹ️ Details","callback_data":"details:a-vol"},{"text":"↗ Ack + move","callback_data":"ackmove:a-vol"}],[{"text":"🔕 Mute 1h","callback_data":"mute:a-vol"},{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

*State 3: After Acknowledge*
```
✅ <b>JPM VOLUME</b> acknowledged
Acknowledged 19:43 Muscat (10:43 ET)
No more reminders for this alert.
```

### A · c) Reminder 3 and the acknowledge flow

Sent 30 minutes after the first alert (10:22 ET). Try Acknowledge, Ack + move (+1%, +2%, Type a value).

#### Reminder 3 (NVDA HIGH)  `🔔 notifies`

*State 1: As sent*
```
🔁 <b>REMINDER 3</b> · not a new alert
📈 NVDA HIGH 145.00 · 30 min open
Now 144.80 · back inside band
10:52 ET / 19:52 Muscat
```

Buttons (one row per line):

```
[✅ Acknowledge]
[ℹ️ Details] [↗ Ack + move]
[🔕 Mute 1h] [📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"✅ Acknowledge","callback_data":"ack:a-rem3"}],[{"text":"ℹ️ Details","callback_data":"details:a-rem3"},{"text":"↗ Ack + move","callback_data":"ackmove:a-rem3"}],[{"text":"🔕 Mute 1h","callback_data":"mute:a-rem3"},{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

*State 2: Details*
```
🔁 <b>REMINDER 3</b> · not a new alert
📈 NVDA HIGH 145.00 · 30 min open
Now 144.80 · back inside band
Last 144.80 · +6.60 (+4.78%)
Prev Close 138.20
Opening (IEX) 141.05
IEX volume 2.40M · 1.3x avg
First alert 10:22 ET / 19:22 Muscat
Reminder 3 at 10:52 ET / 19:52 Muscat
```

Buttons (one row per line):

```
[✅ Acknowledge]
[ℹ️ Details] [↗ Ack + move]
[🔕 Mute 1h] [📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"✅ Acknowledge","callback_data":"ack:a-rem3"}],[{"text":"ℹ️ Details","callback_data":"details:a-rem3"},{"text":"↗ Ack + move","callback_data":"ackmove:a-rem3"}],[{"text":"🔕 Mute 1h","callback_data":"mute:a-rem3"},{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

*State 3: Ack + move chooser*
```
↗ <b>Acknowledge and move HIGH</b>
NVDA HIGH is 145.00 · last 144.80
Move it further out by:
```

Buttons (one row per line):

```
[+1% → 146.45] [+2% → 147.90]
[⌨ Type a value]
[← Cancel]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"+1% → 146.45","callback_data":"m1:a-rem3"},{"text":"+2% → 147.90","callback_data":"m2:a-rem3"}],[{"text":"⌨ Type a value","callback_data":"type:a-rem3"}],[{"text":"← Cancel","callback_data":"cancel:a-rem3"}]]}
```

</details>

*State 4: Typed-value prompt*
```
⌨ Reply with the new NVDA HIGH:
a price (148.00) or a percent (+3%)
Must be above last 144.80.
```

Buttons (one row per line):

```
[← Cancel]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"← Cancel","callback_data":"cancel:a-rem3"}]]}
```

</details>

*State 5: After Acknowledge*
```
✅ <b>NVDA HIGH</b> acknowledged
Acknowledged 19:52 Muscat (10:52 ET)
No more reminders for this alert.
```

*State 6: After Ack + move +1%*
```
✅ <b>NVDA HIGH</b> acknowledged
Acknowledged 19:52 Muscat (10:52 ET)
HIGH moved 145.00 → 146.45 (+1%)
Re-armed. Quiet until crossed again.
```

### A · d) LATE alert and Unacknowledged at close

LATE: two schedule runs were missed; the gap scan found the crossing.

#### LATE alert (XOM HIGH)  `🔔 notifies`

*State 1: As sent*
```
⏱ <b>LATE</b> 📈 <b>XOM HIGH</b> 115.00
Touched 14:07 ET · bar high 115.20
Found 14:11 ET · runs were missed
14:07 ET / 23:07 Muscat
```

Buttons (one row per line):

```
[✅ Acknowledge]
[ℹ️ Details] [↗ Ack + move]
[🔕 Mute 1h] [📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"✅ Acknowledge","callback_data":"ack:a-late"}],[{"text":"ℹ️ Details","callback_data":"details:a-late"},{"text":"↗ Ack + move","callback_data":"ackmove:a-late"}],[{"text":"🔕 Mute 1h","callback_data":"mute:a-late"},{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

*State 2: Details*
```
⏱ <b>LATE</b> 📈 <b>XOM HIGH</b> 115.00
Touched 14:07 ET · bar high 115.20
Found 14:11 ET · runs were missed
Now 114.60 · +3.30 (+2.96%)
Prev Close 111.30
Opening (IEX) 111.55
IEX volume 0.88M · 1.0x avg
Touched 14:07 ET / 23:07 Muscat
```

Buttons (one row per line):

```
[✅ Acknowledge]
[ℹ️ Details] [↗ Ack + move]
[🔕 Mute 1h] [📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"✅ Acknowledge","callback_data":"ack:a-late"}],[{"text":"ℹ️ Details","callback_data":"details:a-late"},{"text":"↗ Ack + move","callback_data":"ackmove:a-late"}],[{"text":"🔕 Mute 1h","callback_data":"mute:a-late"},{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

*State 3: After Acknowledge*
```
✅ <b>XOM HIGH</b> acknowledged
Acknowledged 23:12 Muscat (14:12 ET)
No more reminders for this alert.
```

#### Unacknowledged at close  `🔔 notifies`

*State 1: As sent*
```
🔕 <b>UNACKNOWLEDGED AT CLOSE</b>
2 alerts · no more reminders
📉 AMZN LOW · since 13:15 ET
📈 XOM HIGH · since 14:07 ET (late)
Closed 16:00 ET / 01:00 Muscat
They re-arm fresh at the next open.
```

Buttons (one row per line):

```
[✅ Mark all seen]
[📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"✅ Mark all seen","callback_data":"ackall:a-close"}],[{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

*State 2: After Mark all seen*
```
🔕 <b>UNACKNOWLEDGED AT CLOSE</b>
Marked as seen 01:02 Muscat
Nothing was sent after the close.
```

### A · e) READY, SESSION ENDED, operational error

READY and SESSION ENDED are silent. The error notice notifies, at most once per 30 minutes per type.

#### READY  `🔕 silent`

```
🟢 <b>READY</b> · Mon 30 Nov
8 stocks · 24 rules active
Baselines 8/8 · calendar OK
Open 09:30 ET / 18:30 Muscat
Close 16:00 ET / 01:00 Muscat
```

#### SESSION ENDED  `🔕 silent`

```
🏁 <b>SESSION ENDED</b> · Mon 30 Nov
Closed 16:00 ET / 01:00 Muscat
Alerts 5 (1 late) · reminders 11
Acknowledged 3 · open at close 2
Missed polls 3 min · gap scan OK
```

#### Operational error notice  `🔔 notifies`

```
⚠️ <b>DATA PROBLEM</b> · provider error
No prices for 2 min
Alerts may be late, not lost.
Gap scan runs when data returns.
Since 11:41 ET / 20:41 Muscat
Next notice of this type: 30 min
```

Buttons (one row per line):

```
[📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

### A · i) /status and /set exchanges

Commands you type are shown on the right.

#### /status (you type)  `⌨ you type`

```
/status
```

#### /status reply  `🔔 notifies`

```
<b>STATUS</b> · v0.1.0 (sample)
Market OPEN · closes 16:00 ET
Data LIVE · last poll 12 s ago
Unacknowledged: 1
Next reminder 10:42 ET / 19:42 Muscat
Baselines 8/8 · calendar valid
Free tier: 3% writes · 2% requests
```

#### /set (you type)  `⌨ you type`

```
/set NVDA high 148
```

#### /set reply  `🔔 notifies`

```
✅ <b>NVDA HIGH</b> set to 148.00
+7.1% from Prev Close 138.20
Was 145.00 · last 145.60
Re-armed now.
```

#### /set that is already crossed (you type)  `⌨ you type`

```
/set NVDA high 145
```

#### /set confirmation (already crossed)  `🔔 notifies`

*State 1: As sent*
```
⚠️ <b>NVDA HIGH 145.00</b>
Last 145.60 is already above it.
<b>This will alert immediately. Save?</b>
```

Buttons (one row per line):

```
[✅ Save and alert]
[← Cancel]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"✅ Save and alert","callback_data":"save:a-set2"}],[{"text":"← Cancel","callback_data":"cancel:a-set2"}]]}
```

</details>

*State 2: After Save*
```
✅ <b>NVDA HIGH</b> saved: 145.00
Alert sent now (see above).
```

### A · f, g, h) Dashboard

Cover screen: a list sorted by what needs action; each stock is one card with status word + icon, **Last recorded** (price, ET and Muscat time, age badge) and a 2x2 grid with **Prev Close, Opening (IEX), LOW, HIGH**. LOW and HIGH are tappable (edit in place). Crossed stocks get an Acknowledge button and "Ack + move…". Inner screen: one table, same five numbers in columns, IEX volume column.

States shown: normal (AAPL, JPM, TSLA), NEAR (AMZN), CROSSED – UNACKNOWLEDGED (NVDA), ACKNOWLEDGED (MSFT), stale amber 74 s (XOM), stale red 6 min (GOOGL).

Editing: bottom sheet.

Threshold editing (all alternatives): tap LOW or HIGH → choose **$ price** or **% from Previous Close** → type → live preview ("= $148.00 · +7.1% from Prev Close 138.20 · +1.7% from Last 145.60"). If the latest price has already crossed the new value, a confirmation appears: **"This will alert immediately. Save?"** with "Yes, save and alert" and "No, go back". Saving re-arms the rule at once and is logged.

### A · j) Trade-offs

**Strengths**

- Fastest to read: type, symbol, rule and price are in the first line, which is what the phone shows on the lock screen.
- Shortest reminders, so ten of them in a row stay tolerable.
- Details expands in place, so the chat stays short and nothing extra buzzes.
- Small formatter, easy to test; closest to FR-5.5 with the least text.

**Weaknesses**

- Previous Close, Opening and both thresholds are not visible until Details is tapped (the five numbers are one tap away on Telegram, always visible on the dashboard).
- Three buttons per row and a second tap for the full card.
- Briefing is collapsed by default, so volume levels need a tap.

| Measure | Estimate |
|---|---|
| Quiet day (1 alert, acknowledged after 1 reminder) | 5 messages (3 notify): READY, Briefing, 1 alert, 1 reminder, SESSION ENDED. Plus 1 silent edit when acknowledged. |
| Busy day (8 alerts incl. 1 late, 3 reminders each, 1 error) | 37 messages (35 notify): READY, Briefing, 8 first alerts, 24 reminders, 1 close summary, 1 error, SESSION ENDED. Tidy-up (FR-4.12) keeps only the newest reminder per rule in the chat. |
| Implementation effort | Low to medium, about 3 days. Formatter plus one stored "expanded" flag per message; callbacks edit the same message. |
| Risk | Low. Main risk: Salim acknowledges from the glance without seeing the opening price or levels (mitigation: Details is the second button, the dashboard shows all five numbers). |

Against the PRD 9.5 criteria:

| Criterion | This alternative |
|---|---|
| Five numbers in 3 s | Partial on Telegram (Last only), full on dashboard |
| Which alert needs action now | Good: NEW/REMINDER prefix and icon in line 1 |
| One-tap acknowledge, no night mis-tap | Good: Acknowledge alone on row 1 |
| Readable on both screens | Good: all lines are 38 characters or fewer |
| Quiet when quiet, loud when not | Good: 3 messages on a quiet day |
| Effort / risk | Low / low |

---

## Alternative B: "Decision Card"

*Everything in one grouped card.*

Every alert is a complete card in four labelled blocks (Price, Levels, Volume, Time), so the decision can be made without tapping anything but Acknowledge.

**What I sharpened compared with PRD 9.4:** Added: the first two lines repeat symbol, rule, price and limit so the lock-screen preview is still useful; Acknowledge is a full-width button on its own row; the briefing is split into two messages by gap size (FR-7.4).

### B · a) Opening Briefing, 6 sample stocks

Sent about 60 s after the open: 09:31 ET / 18:31 Muscat. Information only, no acknowledge, no repeats.

#### Opening Briefing 1/2  `🔔 notifies`

```
☀️ <b>OPENING BRIEFING</b> 1/2
Mon 30 Nov · 09:31 ET / 18:31 Muscat
Close 16:00 ET / 01:00 Muscat
Sorted by gap · all volume is IEX

<b>NVDA</b> ▲ gap +2.06%
PC 138.20 → Open(IEX) 141.05
Yest H 139.40 L 136.80 · 6.10M
LOW 130.00 (-7.8% vs open)
HIGH 145.00 (+2.8% vs open)
IEX avg/day 6.80M · 2x 13.6M
2x at 10/11/13h: 2.31M 4.08M 7.48M

⚠️ <b>MSFT</b> ▼ gap -0.76%
PC 421.80 → Open(IEX) 418.60
Yest H 424.30 L 419.10 · 1.30M
LOW 420.00 (+0.3% vs open)
HIGH 435.00 (+3.9% vs open)
IEX avg/day 1.40M · 2x 2.80M
2x at 10/11/13h: 0.48M 0.84M 1.54M
<b>LOW crossed at open - alert follows</b>

<b>JPM</b> ▼ gap -0.37%
PC 241.10 → Open(IEX) 240.20
Yest H 243.00 L 239.20 · 0.80M
LOW 235.00 (-2.2% vs open)
HIGH 250.00 (+4.1% vs open)
IEX avg/day 0.90M · 2x 1.80M
2x at 10/11/13h: 0.31M 0.54M 0.99M
```

Buttons (one row per line):

```
[📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

#### Opening Briefing 2/2  `🔕 silent`

```
☀️ <b>OPENING BRIEFING</b> 2/2
Mon 30 Nov · 09:31 ET / 18:31 Muscat
Close 16:00 ET / 01:00 Muscat
Sorted by gap · all volume is IEX

<b>AAPL</b> ▲ gap +0.32%
PC 236.40 → Open(IEX) 237.15
Yest H 238.10 L 234.90 · 1.90M
LOW 230.00 (-3.0% vs open)
HIGH 245.00 (+3.3% vs open)
IEX avg/day 2.10M · 2x 4.20M
2x at 10/11/13h: 0.71M 1.26M 2.31M

<b>AMZN</b> ▼ gap -0.29%
PC 207.50 → Open(IEX) 206.90
Yest H 209.00 L 205.20 · 1.70M
LOW 200.00 (-3.3% vs open)
HIGH 215.00 (+3.9% vs open)
IEX avg/day 1.80M · 2x 3.60M
2x at 10/11/13h: 0.61M 1.08M 1.98M

<b>XOM</b> ▲ gap +0.22%
PC 111.30 → Open(IEX) 111.55
Yest H 112.40 L 110.40 · 1.00M
LOW 108.00 (-3.2% vs open)
HIGH 115.00 (+3.1% vs open)
IEX avg/day 1.10M · 2x 2.20M
2x at 10/11/13h: 0.37M 0.66M 1.21M

<i>Y = yesterday · PC = Previous Close</i>
```

Buttons (one row per line):

```
[📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

### B · b) First alerts: HIGH, LOW, VOLUME

Each first alert is sent in the same run as the crossing. Tap the buttons to try them.

#### HIGH alert (NVDA)  `🔔 notifies`

*State 1: As sent*
```
🚨 <b>NEW ALERT</b> 📈 <b>NVDA HIGH</b>
<b>145.60</b> (+5.35%) · limit 145.00
▸ <b>PRICE</b>
Last 145.60 (+7.40 · +5.35%)
Prev Close 138.20
Opening (IEX) 141.05
▸ <b>LEVELS</b>
LOW 130.00 · HIGH 145.00  ◀ HIGH
▸ <b>VOLUME</b>
IEX volume 1.62M · 1.3x avg
▸ <b>TIME</b>
Crossed 10:22 ET / 19:22 Muscat
Unacknowledged 0 min · alert #1
```

Buttons (one row per line):

```
[✅ Acknowledge]
[↗ Ack + move]
[🔕 Mute 1h] [📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"✅ Acknowledge","callback_data":"ack:b-high"}],[{"text":"↗ Ack + move","callback_data":"ackmove:b-high"}],[{"text":"🔕 Mute 1h","callback_data":"mute:b-high"},{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

*State 2: After Acknowledge*
```
✅ <b>NVDA HIGH</b> acknowledged
Acknowledged 19:23 Muscat (10:23 ET)
No more reminders for this alert.
```

#### LOW alert (AMZN)  `🔔 notifies`

*State 1: As sent*
```
🚨 <b>NEW ALERT</b> 📉 <b>AMZN LOW</b>
<b>199.85</b> (-3.69%) · limit 200.00
▸ <b>PRICE</b>
Last 199.85 (-7.65 · -3.69%)
Prev Close 207.50
Opening (IEX) 206.90
▸ <b>LEVELS</b>
LOW 200.00 · HIGH 215.00  ◀ LOW
▸ <b>VOLUME</b>
IEX volume 1.10M · 1.2x avg
▸ <b>TIME</b>
Crossed 13:15 ET / 22:15 Muscat
Unacknowledged 0 min · alert #1
```

Buttons (one row per line):

```
[✅ Acknowledge]
[↗ Ack + move]
[🔕 Mute 1h] [📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"✅ Acknowledge","callback_data":"ack:b-low"}],[{"text":"↗ Ack + move","callback_data":"ackmove:b-low"}],[{"text":"🔕 Mute 1h","callback_data":"mute:b-low"},{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

*State 2: After Acknowledge*
```
✅ <b>AMZN LOW</b> acknowledged
Acknowledged 22:16 Muscat (13:16 ET)
No more reminders for this alert.
```

#### VOLUME alert (JPM)  `🔔 notifies`

*State 1: As sent*
```
🚨 <b>NEW ALERT</b> 📊 <b>JPM VOLUME</b>
<b>2.0x</b> IEX volume · price 241.75
▸ <b>PRICE</b>
Last 241.75 (+0.65 · +0.27%)
Prev Close 241.10
Opening (IEX) 240.20
▸ <b>LEVELS</b>
LOW 235.00 · HIGH 250.00
▸ <b>VOLUME</b>
IEX volume 0.62M · avg 0.31M
Multiple 2.0x · limit 2.0x
▸ <b>TIME</b>
Crossed 10:42 ET / 19:42 Muscat
Unacknowledged 0 min · alert #1
```

Buttons (one row per line):

```
[✅ Acknowledge]
[↗ Ack + move]
[🔕 Mute 1h] [📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"✅ Acknowledge","callback_data":"ack:b-vol"}],[{"text":"↗ Ack + move","callback_data":"ackmove:b-vol"}],[{"text":"🔕 Mute 1h","callback_data":"mute:b-vol"},{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

*State 2: After Acknowledge*
```
✅ <b>JPM VOLUME</b> acknowledged
Acknowledged 19:43 Muscat (10:43 ET)
No more reminders for this alert.
```

### B · c) Reminder 3 and the acknowledge flow

Sent 30 minutes after the first alert (10:22 ET). Try Acknowledge, Ack + move (+1%, +2%, Type a value).

#### Reminder 3 (NVDA HIGH)  `🔔 notifies`

*State 1: As sent*
```
🔁 <b>REMINDER 3</b> · NOT A NEW ALERT
📈 <b>NVDA HIGH</b> · now <b>144.80</b>
↩ Price is back inside your band
▸ <b>PRICE</b>
Last 144.80 (+6.60 · +4.78%)
Prev Close 138.20
Opening (IEX) 141.05
▸ <b>LEVELS</b>
LOW 130.00 · HIGH 145.00  ◀ HIGH
▸ <b>VOLUME</b>
IEX volume 2.40M · 1.3x avg
▸ <b>TIME</b>
First alert 10:22 ET / 19:22 Muscat
Unacknowledged 30 min · R3
```

Buttons (one row per line):

```
[✅ Acknowledge]
[↗ Ack + move]
[🔕 Mute 1h] [📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"✅ Acknowledge","callback_data":"ack:b-rem3"}],[{"text":"↗ Ack + move","callback_data":"ackmove:b-rem3"}],[{"text":"🔕 Mute 1h","callback_data":"mute:b-rem3"},{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

*State 2: Ack + move chooser*
```
↗ <b>Acknowledge and move HIGH</b>
NVDA HIGH is 145.00 · last 144.80
Move it further out by:
```

Buttons (one row per line):

```
[+1% → 146.45] [+2% → 147.90]
[⌨ Type a value]
[← Cancel]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"+1% → 146.45","callback_data":"m1:b-rem3"},{"text":"+2% → 147.90","callback_data":"m2:b-rem3"}],[{"text":"⌨ Type a value","callback_data":"type:b-rem3"}],[{"text":"← Cancel","callback_data":"cancel:b-rem3"}]]}
```

</details>

*State 3: Typed-value prompt*
```
⌨ Reply with the new NVDA HIGH:
a price (148.00) or a percent (+3%)
Must be above last 144.80.
```

Buttons (one row per line):

```
[← Cancel]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"← Cancel","callback_data":"cancel:b-rem3"}]]}
```

</details>

*State 4: After Acknowledge*
```
✅ <b>NVDA HIGH</b> acknowledged
Acknowledged 19:52 Muscat (10:52 ET)
No more reminders for this alert.
```

*State 5: After Ack + move +1%*
```
✅ <b>NVDA HIGH</b> acknowledged
Acknowledged 19:52 Muscat (10:52 ET)
HIGH moved 145.00 → 146.45 (+1%)
Re-armed. Quiet until crossed again.
```

### B · d) LATE alert and Unacknowledged at close

LATE: two schedule runs were missed; the gap scan found the crossing.

#### LATE alert (XOM HIGH)  `🔔 notifies`

*State 1: As sent*
```
⏱ <b>LATE ALERT</b> 📈 <b>XOM HIGH</b>
Missed runs · found by gap scan
Bar high <b>115.20</b> ≥ limit 115.00
▸ <b>PRICE</b>
Last 114.60 (+3.30 · +2.96%)
Prev Close 111.30
Opening (IEX) 111.55
▸ <b>LEVELS</b>
LOW 108.00 · HIGH 115.00  ◀ HIGH
▸ <b>VOLUME</b>
IEX volume 0.88M · 1.0x avg
▸ <b>TIME</b>
Touched 14:07 ET / 23:07 Muscat
Found 14:11 ET / 23:11 Muscat
Unacknowledged 0 min · alert #1
```

Buttons (one row per line):

```
[✅ Acknowledge]
[↗ Ack + move]
[🔕 Mute 1h] [📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"✅ Acknowledge","callback_data":"ack:b-late"}],[{"text":"↗ Ack + move","callback_data":"ackmove:b-late"}],[{"text":"🔕 Mute 1h","callback_data":"mute:b-late"},{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

*State 2: After Acknowledge*
```
✅ <b>XOM HIGH</b> acknowledged
Acknowledged 23:12 Muscat (14:12 ET)
No more reminders for this alert.
```

#### Unacknowledged at close  `🔔 notifies`

*State 1: As sent*
```
🔕 <b>UNACKNOWLEDGED AT CLOSE</b>
2 alerts · reminders have stopped

▸ <b>1 · 📉 AMZN LOW</b>
Limit 200.00 · low print 199.85
Crossed 13:15 ET / 22:15 Muscat
Reminders sent 8

▸ <b>2 · 📈 XOM HIGH (LATE)</b>
Limit 115.00 · bar high 115.20
Touched 14:07 ET / 23:07 Muscat
Reminders sent 5

Closed 16:00 ET / 01:00 Muscat
Both re-arm fresh at the next open.
```

Buttons (one row per line):

```
[✅ Mark all seen]
[📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"✅ Mark all seen","callback_data":"ackall:b-close"}],[{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

*State 2: After Mark all seen*
```
🔕 <b>UNACKNOWLEDGED AT CLOSE</b>
Marked as seen 01:02 Muscat
Nothing was sent after the close.
```

### B · e) READY, SESSION ENDED, operational error

READY and SESSION ENDED are silent. The error notice notifies, at most once per 30 minutes per type.

#### READY  `🔕 silent`

```
🟢 <b>READY</b> · Mon 30 Nov

▸ <b>STOCKS</b>
8 active · 24 rules
Baselines 8/8
▸ <b>SYSTEM</b>
Calendar OK · data LIVE
▸ <b>SESSION</b>
Open 09:30 ET / 18:30 Muscat
Close 16:00 ET / 01:00 Muscat
```

#### SESSION ENDED  `🔕 silent`

```
🏁 <b>SESSION ENDED</b> · Mon 30 Nov

▸ <b>ALERTS</b>
First alerts 5 (1 late)
Reminders 11
▸ <b>OUTCOME</b>
Acknowledged 3
Open at close 2
▸ <b>HEALTH</b>
Missed polls 3 min · gap scan OK
Closed 16:00 ET / 01:00 Muscat
```

#### Operational error notice  `🔔 notifies`

```
⚠️ <b>DATA PROBLEM</b>

▸ <b>WHAT</b>
Provider returned errors
No prices for 2 min
▸ <b>IMPACT</b>
Alerts may be late, not lost.
Gap scan runs on recovery.
▸ <b>WHEN</b>
Since 11:41 ET / 20:41 Muscat
Next notice of this type: 30 min
```

Buttons (one row per line):

```
[📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

### B · i) /status and /set exchanges

Commands you type are shown on the right.

#### /status (you type)  `⌨ you type`

```
/status
```

#### /status reply  `🔔 notifies`

```
<b>STATUS</b> · v0.1.0 (sample)

▸ <b>MARKET</b>
OPEN · closes 16:00 ET
Data LIVE · poll 12 s ago
▸ <b>ALERTS</b>
Unacknowledged 1
Next reminder 10:42 ET / 19:42 Muscat
▸ <b>SYSTEM</b>
Baselines 8/8 · calendar valid
Free tier 3% writes · 2% requests
```

#### /set (you type)  `⌨ you type`

```
/set NVDA high 148
```

#### /set reply  `🔔 notifies`

```
✅ <b>NVDA HIGH</b> saved

▸ <b>NEW</b>
HIGH 148.00 (+7.1% from PC)
▸ <b>BEFORE</b>
HIGH 145.00
▸ <b>NOW</b>
Last 145.60 · inside the band
Re-armed immediately
```

#### /set that is already crossed (you type)  `⌨ you type`

```
/set NVDA high 145
```

#### /set confirmation (already crossed)  `🔔 notifies`

*State 1: As sent*
```
⚠️ <b>CHECK BEFORE SAVING</b>

NVDA HIGH 145.00
Last 145.60 is already above it.
<b>This will alert immediately. Save?</b>
```

Buttons (one row per line):

```
[✅ Save and alert]
[← Cancel]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"✅ Save and alert","callback_data":"save:b-set2"}],[{"text":"← Cancel","callback_data":"cancel:b-set2"}]]}
```

</details>

*State 2: After Save*
```
✅ <b>NVDA HIGH</b> saved: 145.00
Alert sent now (see above).
```

### B · f, g, h) Dashboard

Cover screen: one card per stock with blocks PRICE (Last, Prev Close, Opening (IEX)), LEVELS (range gauge LOW to HIGH with P/O/▲ markers, LOW and HIGH tappable) and VOLUME (IEX volume, multiple, alert level). Inner screen: two columns of the same cards.

States shown as in A. Editing: centred dialog.

Threshold editing (all alternatives): tap LOW or HIGH → choose **$ price** or **% from Previous Close** → type → live preview ("= $148.00 · +7.1% from Prev Close 138.20 · +1.7% from Last 145.60"). If the latest price has already crossed the new value, a confirmation appears: **"This will alert immediately. Save?"** with "Yes, save and alert" and "No, go back". Saving re-arms the rule at once and is logged.

### B · j) Trade-offs

**Strengths**

- All five numbers, volume and times are in the message itself: no second tap, no hidden data.
- Most complete record in the chat: you can scroll back and see exactly what you knew at the time.
- Fixed layout, so you learn where each number is.
- No stored state besides the acknowledgment.

**Weaknesses**

- About 14 lines per alert; on the cover screen one card fills most of the display.
- Reminders repeat the whole card every 10 minutes, so a busy day is a lot of text.
- The notification preview shows only the first lines, so the card structure helps little on the lock screen.
- Briefing needs two messages for 6 stocks and more for 30.

| Measure | Estimate |
|---|---|
| Quiet day (1 alert, acknowledged after 1 reminder) | 6 messages (3 notify): READY, Briefing 1/2 (notifies), Briefing 2/2 (silent), 1 alert, 1 reminder, SESSION ENDED. |
| Busy day (8 alerts incl. 1 late, 3 reminders each, 1 error) | 38 messages (35 notify): as A, plus one extra briefing message. Same notification count as A, but about 3 times the text. |
| Implementation effort | Low, about 2 days. Static formatter; no expand/collapse state. |
| Risk | Low technically. Usability risk: long reminders lose urgency (a block of text looks the same as the last one). Mitigated by the 🔁 NOT A NEW ALERT banner. |

Against the PRD 9.5 criteria:

| Criterion | This alternative |
|---|---|
| Five numbers in 3 s | Good: three of five in PRICE, two in LEVELS, same place every time |
| Which alert needs action now | Good: banner line, but cards look alike when stacked |
| One-tap acknowledge, no night mis-tap | Good: Acknowledge alone on row 1 |
| Readable on both screens | Fair: long on the cover screen |
| Quiet when quiet, loud when not | Fair: loud text even for reminders |
| Effort / risk | Low / low |

---

## Alternative C: "Live Board"

*One pinned board plus short pings.*

One pinned message per session lists every stock (the five numbers on two lines) and the alerts needing action, and is edited in place. A short notifying ping is sent only for a first alert or a reminder; reminders due in the same minute share ONE message.

**What I sharpened compared with PRD 9.4:** Added: combined reminder digest (FR-4.13 extended across stocks), the board carries the full alert card for open alerts so pings can stay at 3 lines, and the board shows an "Updated HH:MM" line so a frozen board is visible.

### C · a) Opening Briefing, 6 sample stocks

Sent about 60 s after the open: 09:31 ET / 18:31 Muscat. Information only, no acknowledge, no repeats.

#### Opening Briefing (6 stocks)  `🔔 notifies`

```
☀️ <b>OPENING BRIEFING</b>
Mon 30 Nov · 09:31 ET / 18:31 Muscat
Close 16:00 ET / 01:00 Muscat
Prices and volume are IEX
PC = Prev Close · Op = Opening (IEX)

<b>PRICES</b> (sorted by gap)
<b>NVDA</b> +2.06% PC 138.20 Op 141.05
yH 139.40 yL 136.80 · L130.00 H145.00
⚠️ <b>MSFT</b> -0.76% PC 421.80 Op 418.60
yH 424.30 yL 419.10 · L420.00 H435.00
<b>LOW crossed at open - alert follows</b>
<b>JPM</b> -0.37% PC 241.10 Op 240.20
yH 243.00 yL 239.20 · L235.00 H250.00
<b>AAPL</b> +0.32% PC 236.40 Op 237.15
yH 238.10 yL 234.90 · L230.00 H245.00
<b>AMZN</b> -0.29% PC 207.50 Op 206.90
yH 209.00 yL 205.20 · L200.00 H215.00
<b>XOM</b> +0.22% PC 111.30 Op 111.55
yH 112.40 yL 110.40 · L108.00 H115.00

<b>2x IEX VOLUME</b> at 10:00 / 11:00 / 13:00
NVDA 2.31 / 4.08 / 7.48M
MSFT 0.48 / 0.84 / 1.54M
JPM 0.31 / 0.54 / 0.99M
AAPL 0.71 / 1.26 / 2.31M
AMZN 0.61 / 1.08 / 1.98M
XOM 0.37 / 0.66 / 1.21M

<i>Live numbers: pinned board ▲</i>
```

Buttons (one row per line):

```
[📋 Board] [📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"📋 Board","callback_data":"board:c-brief"},{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

### C · a+) The pinned Live Board (edited in place)

Edited silently on every state change and about every 5 minutes. Shown as of 10:40 ET / 19:40 Muscat. Edits never notify.

#### Live Board (pinned)  `🔕 silent / edit (no notification)`

```
📋 <b>LIVE BOARD</b> · Mon 30 Nov
Updated 10:40 ET / 19:40 Muscat
Market OPEN · data LIVE
<i>Op = Opening (IEX) · PC = Prev Close</i>

━━ <b>ACTION NEEDED (1)</b> ━━
🚨 <b>NVDA HIGH 145.00 crossed</b>
Last 145.60 · +7.40 (+5.35%)
PC 138.20 · Opening (IEX) 141.05
LOW 130.00 · HIGH 145.00
IEX volume 1.90M · 1.3x avg
Since 10:22 ET / 19:22 Muscat
Reminder 1 sent · next 10:42 ET

━━ <b>WATCHING (7)</b> ━━
<b>AAPL</b> 238.05 +0.70% ✓ OK
PC 236.40 Op 237.15 L230.00 H245.00
<b>MSFT</b> 417.95 -0.91% ✔ ACKED 18:44
PC 421.80 Op 418.60 L420.00 H435.00
<b>AMZN</b> 201.30 -2.99% ◔ NEAR
PC 207.50 Op 206.90 L200.00 H215.00
<b>JPM</b> 241.75 +0.27% ✓ OK
PC 241.10 Op 240.20 L235.00 H250.00
<b>XOM</b> 112.20 +0.81% ✓ OK
🟡 STALE 74 s
PC 111.30 Op 111.55 L108.00 H115.00
<b>GOOGL</b> 179.40 +0.45% ✓ OK
🔴 STALE 6 min
PC 178.60 Op 179.10 L172.00 H185.00
<b>TSLA</b> 357.20 +1.36% ✓ OK
PC 352.40 Op 355.90 L335.00 H370.00

<i>Edited silently. Alerts are pings.</i>
```

Buttons (one row per line):

```
[✅ Ack NVDA] [✅ Ack all]
[📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"✅ Ack NVDA","callback_data":"ack:c-board"},{"text":"✅ Ack all","callback_data":"ackall:c-board"}],[{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

### C · b) First alerts: HIGH, LOW, VOLUME

Each first alert is sent in the same run as the crossing. Tap the buttons to try them.

#### HIGH alert (NVDA)  `🔔 notifies`

*State 1: As sent*
```
🚨 NEW 📈 <b>NVDA HIGH</b> 145.60
10:22 ET / 19:22 Muscat
Full numbers: pinned board ▲
```

Buttons (one row per line):

```
[✅ Acknowledge]
[📋 Board] [↗ Ack + move]
[🔕 Mute 1h] [📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"✅ Acknowledge","callback_data":"ack:c-high"}],[{"text":"📋 Board","callback_data":"board:c-high"},{"text":"↗ Ack + move","callback_data":"ackmove:c-high"}],[{"text":"🔕 Mute 1h","callback_data":"mute:c-high"},{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

*State 2: After Acknowledge*
```
✅ <b>NVDA HIGH</b> acknowledged
Acknowledged 19:23 Muscat (10:23 ET)
No more reminders for this alert.
```

#### LOW alert (AMZN)  `🔔 notifies`

*State 1: As sent*
```
🚨 NEW 📉 <b>AMZN LOW</b> 199.85
13:15 ET / 22:15 Muscat
Full numbers: pinned board ▲
```

Buttons (one row per line):

```
[✅ Acknowledge]
[📋 Board] [↗ Ack + move]
[🔕 Mute 1h] [📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"✅ Acknowledge","callback_data":"ack:c-low"}],[{"text":"📋 Board","callback_data":"board:c-low"},{"text":"↗ Ack + move","callback_data":"ackmove:c-low"}],[{"text":"🔕 Mute 1h","callback_data":"mute:c-low"},{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

*State 2: After Acknowledge*
```
✅ <b>AMZN LOW</b> acknowledged
Acknowledged 22:16 Muscat (13:16 ET)
No more reminders for this alert.
```

#### VOLUME alert (JPM)  `🔔 notifies`

*State 1: As sent*
```
🚨 NEW 📊 <b>JPM VOLUME</b> 2.0x
10:42 ET / 19:42 Muscat
Full numbers: pinned board ▲
```

Buttons (one row per line):

```
[✅ Acknowledge]
[📋 Board] [↗ Ack + move]
[🔕 Mute 1h] [📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"✅ Acknowledge","callback_data":"ack:c-vol"}],[{"text":"📋 Board","callback_data":"board:c-vol"},{"text":"↗ Ack + move","callback_data":"ackmove:c-vol"}],[{"text":"🔕 Mute 1h","callback_data":"mute:c-vol"},{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

*State 2: After Acknowledge*
```
✅ <b>JPM VOLUME</b> acknowledged
Acknowledged 19:43 Muscat (10:43 ET)
No more reminders for this alert.
```

### C · c) Reminder 3 and the acknowledge flow

Reminder 3 of NVDA is due in the same minute as JPM reminder 1, so ONE combined message is sent. Try Acknowledge, "+move" and "Type a value".

#### Reminder 3 (NVDA HIGH, combined with JPM VOLUME)  `🔔 notifies`

*State 1: As sent (two alerts due in the same minute)*
```
🔁 <b>REMINDERS</b> · 2 open · NOT NEW
📈 NVDA HIGH · R3 · 30 min
now 144.80 · back inside band
📊 JPM VOLUME · R1 · 10 min
now 2.1x IEX volume
10:52 ET / 19:52 Muscat
Full numbers: pinned board ▲
```

Buttons (one row per line):

```
[✅ Ack NVDA] [↗ +move]
[✅ Ack JPM]
[✅ Acknowledge all]
[📋 Board] [📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"✅ Ack NVDA","callback_data":"ackn:c-rem3"},{"text":"↗ +move","callback_data":"ackmove:c-rem3"}],[{"text":"✅ Ack JPM","callback_data":"ackj:c-rem3"}],[{"text":"✅ Acknowledge all","callback_data":"ackall:c-rem3"}],[{"text":"📋 Board","callback_data":"board:c-rem3"},{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

*State 2: Ack + move chooser for NVDA*
```
↗ <b>Acknowledge and move NVDA HIGH</b>
HIGH is 145.00 · last 144.80
Move it further out by:
```

Buttons (one row per line):

```
[+1% → 146.45] [+2% → 147.90]
[⌨ Type a value]
[← Cancel]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"+1% → 146.45","callback_data":"m1:c-rem3"},{"text":"+2% → 147.90","callback_data":"m2:c-rem3"}],[{"text":"⌨ Type a value","callback_data":"type:c-rem3"}],[{"text":"← Cancel","callback_data":"cancel:c-rem3"}]]}
```

</details>

*State 3: NVDA acknowledged + moved +1%*
```
🔁 <b>REMINDERS</b> · 1 open · NOT NEW
✅ NVDA HIGH acknowledged 19:52
HIGH moved 145.00 → 146.45 (+1%)
📊 JPM VOLUME · R1 · 10 min
now 2.1x IEX volume
10:52 ET / 19:52 Muscat
Full numbers: pinned board ▲
```

Buttons (one row per line):

```
[✅ Ack JPM]
[📋 Board] [📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"✅ Ack JPM","callback_data":"ackj:c-rem3"}],[{"text":"📋 Board","callback_data":"board:c-rem3"},{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

*State 4: Both acknowledged*
```
🔁 <b>REMINDERS</b> · all done · NOT NEW
✅ NVDA HIGH acknowledged 19:52
✅ JPM VOLUME acknowledged 19:52
10:52 ET / 19:52 Muscat
```

### C · d) LATE alert and Unacknowledged at close

LATE: two schedule runs were missed; the gap scan found the crossing.

#### LATE alert (XOM HIGH)  `🔔 notifies`

*State 1: As sent*
```
⏱ <b>LATE</b> 📈 <b>XOM HIGH</b> 115.00
Touched 14:07 ET / 23:07 Muscat
Found 14:11 ET · runs were missed
Full numbers: pinned board ▲
```

Buttons (one row per line):

```
[✅ Acknowledge]
[📋 Board] [↗ Ack + move]
[🔕 Mute 1h] [📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"✅ Acknowledge","callback_data":"ack:c-late"}],[{"text":"📋 Board","callback_data":"board:c-late"},{"text":"↗ Ack + move","callback_data":"ackmove:c-late"}],[{"text":"🔕 Mute 1h","callback_data":"mute:c-late"},{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

*State 2: After Acknowledge*
```
✅ <b>XOM HIGH</b> acknowledged
Acknowledged 23:12 Muscat (14:12 ET)
No more reminders for this alert.
```

#### Unacknowledged at close  `🔔 notifies`

*State 1: As sent*
```
🔕 <b>UNACKNOWLEDGED AT CLOSE</b>
2 alerts · no more reminders
📉 AMZN LOW · since 13:15 ET
📈 XOM HIGH · since 14:07 ET (late)
Closed 16:00 ET / 01:00 Muscat
The board is frozen as of the close.
```

Buttons (one row per line):

```
[✅ Mark all seen]
[📋 Board] [📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"✅ Mark all seen","callback_data":"ackall:c-close"}],[{"text":"📋 Board","callback_data":"board:c-close"},{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

*State 2: After Mark all seen*
```
🔕 <b>UNACKNOWLEDGED AT CLOSE</b>
Marked as seen 01:02 Muscat
Nothing was sent after the close.
```

### C · e) READY, SESSION ENDED, operational error

READY and SESSION ENDED are silent. The error notice notifies, at most once per 30 minutes per type.

#### READY (also pins the new board)  `🔕 silent`

```
🟢 <b>READY</b> · Mon 30 Nov
8 stocks · 24 rules active
Baselines 8/8 · calendar OK
Open 09:30 ET / 18:30 Muscat
📌 Today's board is pinned ▲
```

#### SESSION ENDED  `🔕 silent`

```
🏁 <b>SESSION ENDED</b> · Mon 30 Nov
Closed 16:00 ET / 01:00 Muscat
Alerts 5 (1 late) · reminders 11
Acknowledged 3 · open at close 2
Missed polls 3 min · gap scan OK
📌 Board frozen at the close.
```

#### Operational error notice  `🔔 notifies`

```
⚠️ <b>DATA PROBLEM</b> · provider error
No prices for 2 min
Alerts may be late, not lost.
Board shows 🔴 STALE until fixed.
Since 11:41 ET / 20:41 Muscat
Next notice of this type: 30 min
```

Buttons (one row per line):

```
[📋 Board] [📊 Dashboard]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"📋 Board","callback_data":"board:c-err"},{"text":"📊 Dashboard","url":"https://example.com/dashboard"}]]}
```

</details>

### C · i) /status and /set exchanges

Commands you type are shown on the right.

#### /status (you type)  `⌨ you type`

```
/status
```

#### /status reply  `🔔 notifies`

```
<b>STATUS</b> · v0.1.0 (sample)
Market OPEN · closes 16:00 ET
Data LIVE · last poll 12 s ago
Board edited 19:40 Muscat
Unacknowledged: 1
Next reminder 10:42 ET / 19:42 Muscat
Baselines 8/8 · calendar valid
Free tier: 3% writes · 2% requests
```

Buttons (one row per line):

```
[📋 Board]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"📋 Board","callback_data":"board:c-status"}]]}
```

</details>

#### /set (you type)  `⌨ you type`

```
/set NVDA high 148
```

#### /set reply  `🔔 notifies`

```
✅ <b>NVDA HIGH</b> set to 148.00
+7.1% from Prev Close 138.20
Was 145.00 · last 145.60
Re-armed now. Board updated.
```

#### /set that is already crossed (you type)  `⌨ you type`

```
/set NVDA high 145
```

#### /set confirmation (already crossed)  `🔔 notifies`

*State 1: As sent*
```
⚠️ <b>NVDA HIGH 145.00</b>
Last 145.60 is already above it.
<b>This will alert immediately. Save?</b>
```

Buttons (one row per line):

```
[✅ Save and alert]
[← Cancel]
```

<details><summary>reply_markup JSON</summary>

```json
{"inline_keyboard":[[{"text":"✅ Save and alert","callback_data":"save:c-set2"}],[{"text":"← Cancel","callback_data":"cancel:c-set2"}]]}
```

</details>

*State 2: After Save*
```
✅ <b>NVDA HIGH</b> saved: 145.00
Alert sent now (see above).
```

### C · f, g, h) Dashboard

Cover screen: an ACTION NEEDED panel on top (with Acknowledge and "Ack + move…"), a DATA PROBLEMS panel (stale feeds), then the board: two lines per stock, the same two lines as the Telegram board. Inner screen: the board on the left, the pinned Telegram board preview on the right.

States shown as in A. Editing: side panel on the inner screen, bottom area on the cover screen.

Threshold editing (all alternatives): tap LOW or HIGH → choose **$ price** or **% from Previous Close** → type → live preview ("= $148.00 · +7.1% from Prev Close 138.20 · +1.7% from Last 145.60"). If the latest price has already crossed the new value, a confirmation appears: **"This will alert immediately. Save?"** with "Yes, save and alert" and "No, go back". Saving re-arms the rule at once and is logged.

### C · j) Trade-offs

**Strengths**

- Best overview: all stocks and all open alerts at a glance, on one screen.
- Fewest notifications on a busy day because reminders are combined.
- The chat stays short: one board, a few pings.
- Board and dashboard show the same structure, so learning one teaches the other.

**Weaknesses**

- Edits do not notify, so the board can be stale without any sound; Salim must trust the "Updated" time and the pings.
- Pings carry less than FR-5.5 requires: the rest sits on the board (needs a PRD wording change).
- Combined reminders break the one-alert-one-reminder-number rule (each line keeps its own R number).
- Two sources of truth to keep in step (board and pings).

| Measure | Estimate |
|---|---|
| Quiet day (1 alert, acknowledged after 1 reminder) | 6 messages (3 notify): READY, pinned Board, Briefing, 1 alert, 1 reminder, SESSION ENDED. Plus about 85 silent board edits. |
| Busy day (8 alerts incl. 1 late, 3 reminders each, 1 error) | 26 messages (23 notify): READY, Board, Briefing, 8 first alerts, about 12 combined reminders, 1 close summary, 1 error, SESSION ENDED. About 150 silent board edits. |
| Implementation effort | High, about 6 days. Board state machine, edit throttling, "message is not modified" handling, re-pin if deleted, digest scheduling, more Telegram calls per run (budget guard). |
| Risk | Highest. Edits never notify; Telegram can reject unchanged edits; the board is lost if Salim deletes it; more calls per run against the 45-call limit; combined reminders change FR-4.2 wording. |

Against the PRD 9.5 criteria:

| Criterion | This alternative |
|---|---|
| Five numbers in 3 s | Good: two lines per stock, all five numbers |
| Which alert needs action now | Best: ACTION NEEDED section on top, ping on new |
| One-tap acknowledge, no night mis-tap | Fair: several ack buttons in a combined reminder |
| Readable on both screens | Good: lines are 38 characters or fewer; board is tall (about 40 lines) |
| Quiet when quiet, loud when not | Best: fewest pings |
| Effort / risk | High / medium-high |

---

## Side by side

| | A Glance Line | B Decision Card | C Live Board |
|---|---|---|---|
| Quiet day | 5 messages (3 notify): READY, Briefing, 1 alert, 1 reminder, SESSION ENDED. Plus 1 silent edit when acknowledged. | 6 messages (3 notify): READY, Briefing 1/2 (notifies), Briefing 2/2 (silent), 1 alert, 1 reminder, SESSION ENDED. | 6 messages (3 notify): READY, pinned Board, Briefing, 1 alert, 1 reminder, SESSION ENDED. Plus about 85 silent board edits. |
| Busy day | 37 messages (35 notify): READY, Briefing, 8 first alerts, 24 reminders, 1 close summary, 1 error, SESSION ENDED. Tidy-up (FR-4.12) keeps only the newest reminder per rule in the chat. | 38 messages (35 notify): as A, plus one extra briefing message. Same notification count as A, but about 3 times the text. | 26 messages (23 notify): READY, Board, Briefing, 8 first alerts, about 12 combined reminders, 1 close summary, 1 error, SESSION ENDED. About 150 silent board edits. |
| Effort | Low to medium, about 3 days. Formatter plus one stored "expanded" flag per message; callbacks edit the same message. | Low, about 2 days. Static formatter; no expand/collapse state. | High, about 6 days. Board state machine, edit throttling, "message is not modified" handling, re-pin if deleted, digest scheduling, more Telegram calls per run (budget guard). |
| Risk | Low. Main risk: Salim acknowledges from the glance without seeing the opening price or levels (mitigation: Details is the second button, the dashboard shows all five numbers). | Low technically. Usability risk: long reminders lose urgency (a block of text looks the same as the last one). Mitigated by the 🔁 NOT A NEW ALERT banner. | Highest. Edits never notify; Telegram can reject unchanged edits; the board is lost if Salim deletes it; more calls per run against the 45-call limit; combined reminders change FR-4.2 wording. |

Estimates use the PRD rules: reminder every 10 minutes, reminder tidy-up on (FR-4.12), one combined message per stock per minute (FR-4.13). Real counts will be measured in the shadow trial (AT-25).

## Recommendation

**A, the Glance Line**, with two borrowings: use C's combined reminder when two or more alerts are due in the same minute (a message per alert on a busy day is the loudest failure mode), and keep B's full card as the content of A's **Details** button. Reasons: the lock-screen preview shows the first lines, and A puts type, symbol, rule and price there; it is the cheapest to build and test (about 3 days against 6 for C); Acknowledge sits alone on its row; and the five numbers are one tap away on Telegram and always visible on the dashboard. B is the safe fallback if you would rather never tap Details. C has the best overview and the fewest pings, but its main screen is a message that can be stale without any sound, it carries the highest risk and effort, and it needs a PRD change (FR-5.5 content partly on the board). A board-style view already exists in the dashboard (C's dashboard layout can be borrowed at no Telegram risk).

## Decision record (PRD 9.6): copy, fill in, sign

```
MARKET MONITOR - UX DECISION RECORD (DG-3)
Date of decision : ____ / ____ / ________
Decided by       : Salim
Chosen alternative (tick one):
  [ ] A  Glance Line
  [ ] B  Decision Card
  [ ] C  Live Board
Hybrid changes (what to take from the others, in words):
  1. ____________________________________________
  2. ____________________________________________
  3. ____________________________________________
Answers to the assumptions in this document:
  "+1% / +2%" relative to  [ ] the threshold  [ ] Previous Close
  Volume alerts: "Ack + move" steps  ______________
  Briefing sent with notification  [ ] yes  [ ] no (silent)
Changes to PRD wording needed (e.g. FR-5.5, FR-4.2 if C or a hybrid):
  ________________________________________________
Tested on the Fold with the throwaway bot:
  [ ] cover screen readable   [ ] inner screen readable   [ ] lock-screen preview useful
Signature / written confirmation : ____________________
Rule: the developer may not change this layout without a new approval.
```
