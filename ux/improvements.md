# Dashboard improvements: design decisions

Five changes requested after the first live use (2026-11-25). Each is designed and agreed before any code is written. Mock-ups: `ux/stack-mockup.html`, `ux/form-mockup.html`.

## 1. Watchlist as a card stack (accepted)
- One card in focus, the neighbouring cards peeking behind it. Swipe or drag sideways to move. Only a mostly sideways drag changes cards, so vertical scrolling still works.
- A symbol strip above the stack: tap a symbol to jump to it. A red dot marks an active alert; a struck-through symbol means alerts are off for that stock.
- No arrow buttons and no "1 of 5" counter. Left/right keys work on a keyboard.
- No wrap-around: at the first or last card a drag gives a little and springs back.
- Opens on the most urgent stock, then the order stays fixed while in use. A new alert shows a "TSLA crossed – Show" banner instead of reordering.
- Same stack on every screen size; it replaces the wide-screen table. The wide card lays the data out in three columns (prices / alert levels and volume / range gauge).
- Alert cards have a red border.

## 4. Alerts on/off per stock (accepted with step 1)
- Each card has an Alerts switch. Turning one stock off doesn't affect the others; the card dims and shows "Alerts off".
- "Disable all alerts" at the top turns every card's switch off and shows a banner. There is no "Enable all": stocks are turned back on one by one with their card switch.
- Replaces the per-stock Pause option. Card actions: Edit, Mute, Remove.

## 2. Only Cancel closes a form (accepted)
Applies to every form (add, edit, mute, remove, ...).
- Tapping outside the form does nothing. Esc does nothing.
- Cancel with no changes closes at once. Cancel after any change asks "Discard your changes?" with Keep editing / Discard.
- The phone back gesture behaves like Cancel: closes at once if nothing changed, otherwise asks the same question.
- Save closes the form only when the save works; on an error the form stays open with the entries and shows the error.
- Background price refreshes never reset or close an open form.

## 3. Volume alert when adding a stock (accepted)
- One form for adding and editing a stock: Symbol (read-only when editing), Alerts switch, LOW, HIGH, Volume, Note.
- Volume: "x usual at this time" or a number of shares. Every alert is optional, but at least one of LOW, HIGH or Volume is required.
- A plain sentence under each field says what the alert will do.
- A "x usual" alert on a newly added stock starts on the next trading day (the average is built before the open); the form says so. A shares alert works at once.
- Replaces the separate per-field edit forms.

## 5. End-of-day summary per stock (accepted)
- Sent silently once, at about 16:20 ET (01:20 Muscat), using official prices from all US exchanges (free plan: SIP data once it is 15 minutes old). Early-close days follow the same rule.
- Keeps the counts (alerts, reminders, acknowledged, open at close), then one block per stock:
  - Close and the day's change
  - Prev Close · Open
  - Low · High
  - Volume (official full day) · x the usual (average over recent sessions of official daily volume)
  - One line per alert that fired that day, with its time and whether it was acknowledged
- Stocks that alerted come first, then A to Z. Stocks with alerts off are included, marked "(alerts off)".
- Split into two messages if it doesn't fit in one.
