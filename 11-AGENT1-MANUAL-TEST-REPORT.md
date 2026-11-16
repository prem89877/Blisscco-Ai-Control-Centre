# Agent 1 - Manual Test Report (Phase 2 / Part 1)

Date: 2026-11-16. Status: **Manual testing DONE (owner-reported). Agent 1 complete.**
Follows `10-AGENT1-VERIFICATION-REPORT.md`. Results below are reported by the owner from the live dashboard (Android, Termux + Vercel).

## Results
| # | Test | Result |
|---|---|---|
| 1 | Dashboard: Setup badges, read buttons, Tasks/Logs/API Usage/Health entries | **Pass** |
| 2 | Run SQL on `ai_control.agent1_test` (approve -> confirm -> run) | **Pass** |
| 3 | Run SQL error case (duplicate key): error shown, error logged, approval released | **Pass** |
| 4 | Blocked SQL (`public.` schema, DELETE without WHERE) rejected | **Pass** |
| 5 | Redeploy on a **preview** deployment (request -> approve -> redeploy) | **Pass** |
| 6 | Env change on preview (optional) | **Not run** |

## Verified in this session (from owner's output)
- RLS check ran live: `ai_control` 9/9 tables RLS on; anon probe on all 8 control tables = blocked (401).
- Failed SQL stayed in "Approved - ready to apply" (approval correctly released after error).
- Redeploy card now has dropdowns: environment (Preview/Production), project, deployment (filtered by environment). Server rejects a target/deployment mismatch. 26/26 tests pass (sandbox, `tsx --test`).

## Changes since report 10
- New read-only action `vercel_options` (projects + recent deployments, for dropdowns; not logged as a task).
- `request_redeploy` accepts `target` (`preview`/`production`); mismatch -> 400.
- Files: `src/Agent1.jsx`, `agent1/agent.ts`, `agent1/agent1.test.ts`.

## Open items
- `agent1_supabase` health row showed **Degraded** (Health tab). Cause not yet identified.
- Delete test table: `drop table ai_control.agent1_test;` (propose -> approve -> Run SQL). Confirm done.
- Env change flow is only covered by automated tests, not live.
- Production redeploy / production env change not tested live (by design).

## Live findings (not Agent 1 bugs; owner decision: no action now)
- `public.customer_push_subscriptions`: open anon INSERT, no condition (critical).
- `public.visit_requests`: anon write possible (error).
- `public.admins`, `public.products`, `public.push_subscriptions`: anon write GRANT, RLS blocks (warn).
- Note: preview and production share the same Supabase project, so these apply to live data.

## Next
- Agent 2 (role to be decided).
- Later: semi-automation across Agents 1-3 (approval-gated).
