# Market Monitor — project rules

The full requirements are in `docs/PRD.md` (v3.1). Requirement ids (FR-x.y, AT-x, DG-x) refer to it.

## Hard rules
- **Public repo.** Never commit any secret, token, chat id, access code, watchlist, threshold or personal data. Secrets live only in the Worker secret store (`wrangler secret put`) and, for the deploy token, GitHub Actions secrets. Local dev values go in git-ignored `.dev.vars`.
- **No AI/LLM** SDK, call or key anywhere in the product or build (PRD 7.9, AT-23).
- **No order-placing code.** Market data only (S-3).
- **Free plan limits** (PRD section 1): 10 ms CPU per run, at most 45 outbound/binding calls per run, batch D1 statements, write only on change.
- **No runtime dependencies.** Dev dependencies only (TypeScript, Vitest, Wrangler).
- **DG-3 gate:** do not build production Telegram message layouts or dashboard screens until Salim chooses a UX alternative. The mock-ups live in `ux/`.
- **Deploy freeze** 08:30–16:30 New York time on trading days (FR-14.2).

## Layout
- `src/core/` — portable engine (calendar, time, rules, alert state machine, baseline maths, gap scan). Must NOT import Cloudflare types or call `fetch`. Talks to the outside only through `src/core/ports.ts`.
- `src/adapters/` — Cloudflare/Alpaca/Telegram implementations of the ports (D1 store, Alpaca REST, Telegram Bot API).
- `src/worker/` — Worker entry: `scheduled` (cron) and `fetch` (webhook + dashboard API).
- `migrations/` — D1 SQL migrations, backward compatible (FR-14.3).
- `public/` — static dashboard assets (served without Worker code, FR-8.1).
- `test/` — Vitest, fake clock and recorded data.
- `ux/` — DG-3 mock-ups (three alternatives), not production code.

## Conventions
- TypeScript strict, ES modules. All stored times are UTC epoch ms; display in ET and Muscat (FR-1.6). Trading date = New York date `YYYY-MM-DD`.
- `src/core/ports.ts` is the contract between core and adapters. Change it only deliberately and note the change in your report.
- Run `npm run check` before declaring work done.
