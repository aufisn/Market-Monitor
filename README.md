# Market Monitor

Alerts for US stocks when the price or volume crosses thresholds you set. While a regular US session is open, the monitor polls market data from a Cloudflare Worker (free plan). It sends alerts to Telegram with an Acknowledge button and repeats every 10 minutes until the alert is acknowledged. The same Worker serves a small installable dashboard.

- Requirements: [docs/PRD.md](docs/PRD.md)
- Phase 0 findings: [docs/phase0-findings.md](docs/phase0-findings.md)
- Chosen UX (decision gate DG-3): [ux/DECISION.md](ux/DECISION.md)

## Layout

| Path | What |
|---|---|
| `src/core/` | Portable engine: calendar, rules, alert state machine, baseline, gap scan |
| `src/adapters/` | D1 storage, Alpaca market data, Telegram Bot API, message rendering |
| `src/worker/` | Worker entry: cron, Telegram webhook, dashboard API |
| `public/` | Dashboard static files |
| `migrations/` | D1 schema |

## Development

```bash
npm install
npm run check   # repo scan + typecheck + tests
```

Local test of the dashboard against a mock API: `node test/ui/serve.mjs`.

## Security

This repository is public and holds **code only**. Secrets live only in the Cloudflare Worker secret store and in GitHub Actions secrets, never in this repository. `.dev.vars.example` lists the secret names. `npm run check` scans the repository for secret-like strings and AI SDKs.

The project contains no trading or order-placing code and no AI/LLM calls.

## Licence

Copyright © 2026 the repository owner. All rights reserved. The source is public so it can be read and reviewed; no licence to reuse it is granted.
