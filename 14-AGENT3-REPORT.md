# Agent 3 - QA, Testing & Security Agent (Phase 2 / Part 3)

Date: 2026-11-16. Status: **Code verified (83/83 tests incl. 25 new). Live run PENDING (needs your env vars).**

## What it tests
| Area | Checks |
|---|---|
| Website | smoke (status, speed, title, error leaks), mobile UA, viewport/zoom/fixed-width, 404 handling |
| Auth | login page, anonymous access to admin/advertiser/publisher paths (bypass = critical) |
| API | no key, invalid key, malformed input, wrong method, valid test key (non-billing only), JSON validity, error leaks, CORS |
| Rate limit | 10-30 anonymous GET burst, **approval + APPROVE-PRODUCTION tick** |
| Database | Supabase REST/Auth up, RLS, grants, open policies, schema vs Phase 1, primary keys, live anon read probe, billing integrity (NULL refs, duplicates, negatives), data isolation |
| Security | secrets in public JS/HTML, service_role key, exposed .env/.git, auth bypass, headers, hostile input (SQLi/XSS/traversal/long), repo secrets, committed .env, npm dependency advisories |
| Browser (Playwright) | desktop + Pixel 7, JS errors, sideways scroll, tap size, logins, role separation (GitHub Actions only) |

Workflow: task -> allow-listed target -> tests -> evidence -> findings (severity, evidence, fix) -> Gemini summary -> **Retest** (fixed / still failing / new).

## Billing safety (enforced in code, covered by tests)
- Billing-risk paths (serve, impression, click, track, postback, payout, payment, ledger, ...) get **only no-key / invalid-key / malformed** requests. A valid key is never sent there unless YOU list the exact path in `AGENT3_NONBILLABLE_PATHS`.
- An ad-serve response is never treated as a billable impression; nothing is counted or written as billing.
- Database: read-only SQL guard + Supabase read-only endpoint. Only aggregate counts leave the DB; row values never stored.
- Playwright blocks every billing-looking URL in the browser.
- No PUT/PATCH/DELETE ever sent to a target. Only https, public hosts, exact origins in `AGENT3_TARGETS`.
- Own Gemini key (`AGENT3_GEMINI_API_KEY`). All outputs redacted. Secret values never in reports.

## Verified
| Check | Evidence | Result |
|---|---|---|
| Unit + integration tests with fake site/Supabase/GitHub/npm/Gemini | `npm test` | **83/83 pass** (Agent 3: 25) |
| TypeScript strict build of agent1+2+3 | `tsc` | Pass |
| Dashboard panel, Playwright spec syntax | esbuild parse | Pass |
| Valid key never reaches billing path | test 11 | Pass |
| Secrets not leaked to DB/report | tests 13-15 | Pass |
| Rate test needs approval, ack, single use, 24h expiry | tests 17-19 | Pass |

## NOT verified (honest)
- **No live scan was run.** I have no access to your sites, Supabase or keys. Real findings appear when you run `report` (Termux) or press **Full report** in the dashboard.
- Playwright tests not executed yet (run the QA Playwright workflow).
- Dependency scan with `package.json` only (no lock file) is approximate.

## Not built (as requested)
Orchestrator, automatic/scheduled workflows. Agent 3 runs only when you press a button or run a command.
