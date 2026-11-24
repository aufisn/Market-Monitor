// Rebuilds ux/index.html and ux/alternatives.md from ux/src/*. Run: node ux/build.mjs
// Plain Node, no dependencies, no network.
import fs from 'node:fs';
import vm from 'node:vm';

const dir = new URL('./', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, dir), 'utf8');
const msgSrc = read('src/messages.js');
const ctx = { module: {} };
vm.createContext(ctx);
vm.runInContext(msgSrc + ';this.MM=MM;', ctx);
const MM = ctx.MM;

/* ---------- index.html ---------- */
const html = read('src/shell.html')
  .replace('{{CSS}}', () => read('src/style.css'))
  .replace('{{MESSAGES}}', () => msgSrc)
  .replace('{{APP}}', () => read('src/app.js'));
fs.writeFileSync(new URL('index.html', dir), html);

/* ---------- alternatives.md ---------- */
const clone = (o) => JSON.parse(JSON.stringify(o));
const out = [];
const w = (s = '') => out.push(s);

function keyboard(m, buttons) {
  return buttons.map((row) => row.map((b) => (b.url ? { text: b.t, url: b.url } : { text: b.t, callback_data: `${b.cb}:${m.id}`.slice(0, 64) })));
}
function rows(buttons) { return buttons.map((r) => r.map((b) => `[${b.t}]`).join(' ')).join('\n'); }

w('# Market Monitor: UX alternatives for decision gate DG-3');
w();
w('Version: mock-up 1 · Date of sample day: Mon 30 Nov 2026 · Status: **waiting for Salim\'s choice** (PRD section 9)');
w();
w('All tickers, prices, thresholds and volumes below are **invented sample data**. Muscat time is ET + 9 h in winter. Open `ux/index.html` in any browser (phone or laptop, straight from disk) to click through the same messages, the dashboards, the threshold editor and the trade-offs.');
w();
w('## How to send these through a throwaway test bot');
w();
w('1. Create a separate test bot in BotFather (never the real bot). Keep its token private; do not paste it into any file.');
w('2. Put the token and your chat id in your shell only, for example `export BOT=...` and `export CHAT=...` (not in the repository).');
w('3. For each message below, send the text exactly as shown with `parse_mode=HTML`. Silent messages use `disable_notification=true`. Buttons go in `reply_markup` (the JSON is given for every message).');
w();
w('```');
w('curl -s "https://api.telegram.org/bot$BOT/sendMessage" \\');
w('  --data-urlencode "chat_id=$CHAT" \\');
w('  --data-urlencode "parse_mode=HTML" \\');
w('  --data-urlencode "disable_notification=false" \\');
w('  --data-urlencode "text@message.txt" \\');
w('  --data-urlencode "reply_markup@keyboard.json"');
w('```');
w();
w('Put the message text in `message.txt` and the `inline_keyboard` JSON in `keyboard.json` (as `{"inline_keyboard": ...}`). The "Dashboard" button uses a placeholder URL (`https://example.com/dashboard`); replace it or drop that button for the test. Text only uses the Telegram HTML subset (`<b>`, `<i>`, `<code>`), no ampersands or angle brackets in the content, and no monospace tables.');
w();
w('## Rules every alternative follows (PRD 9.3)');
w();
w('- Lines are **38 characters or fewer**, counting each emoji as 2 (checked by `ux/check.mjs`). No wide tables.');
w('- Telegram edits do not notify. Anything that must make a sound is a **new** message ("🔔 notifies"). Edits are marked "🔕 silent edit".');
w('- A reminder always starts with **🔁 REMINDER n** and says it is not new; a first alert always starts with **🚨 NEW** (A, C) or **🚨 NEW ALERT** (B). The mock-up also gives them different left borders (solid versus dashed), so colour is never the only signal.');
w('- Volume is always **IEX volume**; the opening price is always **Opening (IEX)** (shortened to `Open(IEX)` or `Op` only where space forces it, with a legend line).');
w('- Times are ET and Muscat. Telegram draws its own inline buttons (about 40 dp high, not controllable); the Acknowledge button is therefore always on its own row so a night-time mis-tap lands on something harmless. On the dashboard every target is 48 dp or more.');
w('- Dashboard: colour is never the only signal (icon + word + outline style), dark mode follows the system, five required numbers are on every stock without opening details (FR-8.3).');
w();
w('## Assumptions to confirm (they affect every alternative)');
w();
w('1. **"+1%" and "+2%" in Acknowledge and move threshold** are taken as a move of the crossed threshold further out by that percentage of the threshold itself (HIGH 145.00 → 146.45, LOW 200.00 → 198.00). If you want it relative to Previous Close, say so.');
w('2. **Volume rules** have no sensible "+1%" step. The mock-ups offer "Ack + move" on price alerts only; for VOLUME the proposal is "+0.5x / +1.0x / typed". Not drawn yet.');
w('3. **Typed value** must be beyond the latest price, otherwise it would alert at once (the bot answers "not understood" or "would alert at once").');
w('4. The Opening Briefing is sent with a notification (it is the one planned morning message). READY and SESSION ENDED are silent (FR-10.1).');
w('5. Muscat date: the session ends after midnight in Muscat; messages show the New York trading date.');
w();

const ORDER = ['A', 'B', 'C'];
for (const key of ORDER) {
  const A = MM.ALTS[key];
  w('---');
  w();
  w(`## Alternative ${key}: "${A.name}"`);
  w();
  w(`*${A.tag}.*`);
  w();
  w(A.idea);
  w();
  w(`**What I sharpened compared with PRD 9.4:** ${A.sharpened}`);
  w();
  for (const sc of MM.scenes(key)) {
    const lab = sc.letter === 'a2' ? 'a+' : sc.letter;
    w(`### ${key} · ${lab}) ${sc.title}`);
    w();
    w(sc.note);
    w();
    for (const m of sc.items) {
      const mark = m.from === 'user' ? '⌨ you type' : (m.notify ? '🔔 notifies' : (m.edit ? '🔕 silent / edit (no notification)' : '🔕 silent'));
      w(`#### ${m.title}  \`${mark}\``);
      w();
      const variants = m.variants && m.variants.length ? m.variants : [{ label: 'As sent', s: {} }];
      variants.forEach((v, i) => {
        const s = Object.assign(clone(m.init), clone(v.s));
        const r = m.view(s);
        if (variants.length > 1) w(`*State ${i + 1}: ${v.label}*`);
        w('```');
        w(r.text);
        w('```');
        if (r.buttons && r.buttons.length) {
          w();
          w('Buttons (one row per line):');
          w();
          w('```');
          w(rows(r.buttons));
          w('```');
          w();
          w('<details><summary>reply_markup JSON</summary>');
          w();
          w('```json');
          w(JSON.stringify({ inline_keyboard: keyboard(m, r.buttons) }));
          w('```');
          w();
          w('</details>');
        }
        w();
      });
    }
  }
  w(`### ${key} · f, g, h) Dashboard`);
  w();
  const dashText = {
    A: 'Cover screen: a list sorted by what needs action; each stock is one card with status word + icon, **Last recorded** (price, ET and Muscat time, age badge) and a 2x2 grid with **Prev Close, Opening (IEX), LOW, HIGH**. LOW and HIGH are tappable (edit in place). Crossed stocks get an Acknowledge button and "Ack + move…". Inner screen: one table, same five numbers in columns, IEX volume column.\n\nStates shown: normal (AAPL, JPM, TSLA), NEAR (AMZN), CROSSED – UNACKNOWLEDGED (NVDA), ACKNOWLEDGED (MSFT), stale amber 74 s (XOM), stale red 6 min (GOOGL).\n\nEditing: bottom sheet.',
    B: 'Cover screen: one card per stock with blocks PRICE (Last, Prev Close, Opening (IEX)), LEVELS (range gauge LOW to HIGH with P/O/▲ markers, LOW and HIGH tappable) and VOLUME (IEX volume, multiple, alert level). Inner screen: two columns of the same cards.\n\nStates shown as in A. Editing: centred dialog.',
    C: 'Cover screen: an ACTION NEEDED panel on top (with Acknowledge and "Ack + move…"), a DATA PROBLEMS panel (stale feeds), then the board: two lines per stock, the same two lines as the Telegram board. Inner screen: the board on the left, the pinned Telegram board preview on the right.\n\nStates shown as in A. Editing: side panel on the inner screen, bottom area on the cover screen.'
  }[key];
  w(dashText);
  w();
  w('Threshold editing (all alternatives): tap LOW or HIGH → choose **$ price** or **% from Previous Close** → type → live preview ("= $148.00 · +7.1% from Prev Close 138.20 · +1.7% from Last 145.60"). If the latest price has already crossed the new value, a confirmation appears: **"This will alert immediately. Save?"** with "Yes, save and alert" and "No, go back". Saving re-arms the rule at once and is logged.');
  w();
  w(`### ${key} · j) Trade-offs`);
  w();
  w('**Strengths**');
  w();
  A.strengths.forEach((t) => w(`- ${t}`));
  w();
  w('**Weaknesses**');
  w();
  A.weaknesses.forEach((t) => w(`- ${t}`));
  w();
  w('| Measure | Estimate |');
  w('|---|---|');
  w(`| Quiet day (1 alert, acknowledged after 1 reminder) | ${A.quiet} |`);
  w(`| Busy day (8 alerts incl. 1 late, 3 reminders each, 1 error) | ${A.busy} |`);
  w(`| Implementation effort | ${A.effort} |`);
  w(`| Risk | ${A.risk} |`);
  w();
  w('Against the PRD 9.5 criteria:');
  w();
  w('| Criterion | This alternative |');
  w('|---|---|');
  A.score.forEach((r) => w(`| ${r[0]} | ${r[1]} |`));
  w();
}

w('---');
w();
w('## Side by side');
w();
w('| | A Glance Line | B Decision Card | C Live Board |');
w('|---|---|---|---|');
for (const [lab, k] of [['Quiet day', 'quiet'], ['Busy day', 'busy'], ['Effort', 'effort'], ['Risk', 'risk']]) {
  w(`| ${lab} | ${MM.ALTS.A[k]} | ${MM.ALTS.B[k]} | ${MM.ALTS.C[k]} |`);
}
w();
w('Estimates use the PRD rules: reminder every 10 minutes, reminder tidy-up on (FR-4.12), one combined message per stock per minute (FR-4.13). Real counts will be measured in the shadow trial (AT-25).');
w();
w('## Recommendation');
w();
w('**A, the Glance Line**, with two borrowings: use C\'s combined reminder when two or more alerts are due in the same minute (a message per alert on a busy day is the loudest failure mode), and keep B\'s full card as the content of A\'s **Details** button. Reasons: the lock-screen preview shows the first lines, and A puts type, symbol, rule and price there; it is the cheapest to build and test (about 3 days against 6 for C); Acknowledge sits alone on its row; and the five numbers are one tap away on Telegram and always visible on the dashboard. B is the safe fallback if you would rather never tap Details. C has the best overview and the fewest pings, but its main screen is a message that can be stale without any sound, it carries the highest risk and effort, and it needs a PRD change (FR-5.5 content partly on the board). A board-style view already exists in the dashboard (C\'s dashboard layout can be borrowed at no Telegram risk).');
w();
w('## Decision record (PRD 9.6): copy, fill in, sign');
w();
w('```');
w('MARKET MONITOR - UX DECISION RECORD (DG-3)');
w('Date of decision : ____ / ____ / ________');
w('Decided by       : Salim');
w('Chosen alternative (tick one):');
w('  [ ] A  Glance Line');
w('  [ ] B  Decision Card');
w('  [ ] C  Live Board');
w('Hybrid changes (what to take from the others, in words):');
w('  1. ____________________________________________');
w('  2. ____________________________________________');
w('  3. ____________________________________________');
w('Answers to the assumptions in this document:');
w('  "+1% / +2%" relative to  [ ] the threshold  [ ] Previous Close');
w('  Volume alerts: "Ack + move" steps  ______________');
w('  Briefing sent with notification  [ ] yes  [ ] no (silent)');
w('Changes to PRD wording needed (e.g. FR-5.5, FR-4.2 if C or a hybrid):');
w('  ________________________________________________');
w('Tested on the Fold with the throwaway bot:');
w('  [ ] cover screen readable   [ ] inner screen readable   [ ] lock-screen preview useful');
w('Signature / written confirmation : ____________________');
w('Rule: the developer may not change this layout without a new approval.');
w('```');
w();
fs.writeFileSync(new URL('alternatives.md', dir), out.join('\n'));
console.log('wrote ux/index.html (' + html.length + ' bytes) and ux/alternatives.md');
