# Local Policy — checkin

Repository-specific extensions and exceptions to the pinned harness profile.
This file is **hand-maintained** and referenced from `.agentic/harness.yaml`.

## Architecture

Cloudflare Worker (TypeScript) with D1 persistence.

- `src/index.ts` — Worker entry (`/health`, `/c/:token`, `/checkin`, `/api/responses`, `/report`, scheduled loop)
- `src/scheduler.ts` — idempotent Europe/London scheduler
- `src/weekly-summary.ts` — weekly Pushover mood summary (Sunday 20:00 London)
- `src/answer-rate-alert.ts` — standing G1 answer-rate drift alert
- `src/record-response.ts` — single write path for prompted and manual responses
- `src/export.ts` — bearer-token JSON export; report Basic-or-bearer auth
- `src/health-strip.ts` — answer-rate and extract-freshness health strip
- `src/health-facts.ts` — D1 + R2 reads for the health strip
- `migrations/` — D1 schema (checkin_prompt, checkin_response, weekly_summary, checkin_alert_state)
- `test/` — Vitest worker tests

## Commands

| Task | Command |
|------|---------|
| Deploy | Automated on push to `main` — see [docs/deploy.md](../docs/deploy.md) |
| Local CI | `bash scripts/ci-local.sh` |
| Dev server | `npm run dev` |
| Deploy | `npm run deploy` |
| Install | `npm ci` |

## Issue tracking

This repo does **not** use GitHub milestones.

| Role | Issue |
|------|-------|
| Scope epic / "milestone" | [#1 Project MVP](https://github.com/chewcorp/checkin/issues/1) |
| Stories, tasks, bugs | Sub-issues of #1 |

When filing new work:

1. Create the issue as a **sub-issue** of #1.
2. Do not assign GitHub milestones.
3. Parent stories under #1 directly; nest tasks under their story when the hierarchy helps.

The MVP requirements live in #1's body; `docs/mvp-scope.md` (when present) is a mirror.

## Exceptions

None yet.

## Review extras

None yet.
