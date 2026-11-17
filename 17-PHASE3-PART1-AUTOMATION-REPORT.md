# Phase 3 Part 1 (update) — Intelligent Orchestrator: automation with sensitive-only approval — Completion report

Extends the existing Orchestrator. Nothing was rebuilt. Agent 1 / Agent 2 / Agent 3 code is untouched.

## 1. Files
| File | Change |
|---|---|
| `orchestrator/policy.ts` | **new** – routing table, sensitive-operation policy, transient-error rules, recovery guidance, task-dependency pipeline |
| `orchestrator/workflow.ts` | modified – `advance` + `retry` actions, owner-decision check/record, SQL approval expiry, read-only retry, minimal logging, richer failure record, new `view()` |
| `orchestrator/store.ts` | modified – `isOwner()` (plus the durable-lock methods from the earlier fix) |
| `orchestrator/orchestrator.test.ts` | modified – 12 new tests (+ the 6 durable-lock tests from the earlier fix) |
| `src/Orchestrator.jsx` | modified – auto-advance polling, task pipeline, pending approvals, failure details + recovery + Retry, "Successful"-only view |
| `17-PHASE3-PART1-AUTOMATION-REPORT.md` | this report |

## 2. Existing functionality preserved
All 143 earlier tests pass unchanged (the one helper `approve()` now also sets `decided_by`, because approvals are now checked for an owner). Manual actions `start`, `upload_zip`, `apply`, `check_ci`, `apply_sql`, `verify`, `cancel` behave as before. Agent allow-lists (`A2_ALLOWED`, `A1_ALLOWED`, `A1_SQL_ALLOWED`), `ai_control` restrictions, Phase 3 Part 2 code approval, ZIP/SQL checks, durable duplicate locks: unchanged.

## 3. Automatic coordination
New action `advance` (also called by the dashboard every 8 s). It moves a workflow through every stage that needs no owner decision and stops at the first that does:
* routing (`ROUTES` in `policy.ts`): proposal / commit / CI → Agent 2; SQL run / verification → Agent 1. Agent 3 is not in it.
* owner approved code → Agent 2 commits (no extra "Apply" tap) → CI is read automatically → CI green → Agent 1 verifies → report.
* ZIP with SQL: after CI, Agent 1 raises its approvals; once the owner approved **all** of them, non-destructive SQL runs by itself, then Agent 1 verifies.
* Dependencies: stored state is shown as a task pipeline; if a task fails, dependants are `Blocked` (e.g. CI failed → Agent 1 verification `Blocked`, never started).
* Duplicate prevention: revision lock + atomic claims; parallel `advance` calls produce exactly one commit / SQL run (tested).
* Interrupted detection (existing, 5 min) now says whether the step is safe to retry.
Limit: Vercel functions have no background worker, so progression happens when the dashboard is open (or `advance` is called). A closed dashboard just means the workflow waits; nothing is lost or repeated.

## 4/5. Sensitive-only owner approval
Still always needs the authorized owner:
1. Code change before Agent 2 writes to GitHub (mandatory, Phase 3 Part 2 – kept for every workflow, because Agent 2's own gate cannot be bypassed).
2. Sensitive files: Agent 2's list **plus** `api/`, `orchestrator/`, auth/login/security/permissions/owners/RLS/policy/billing/payout/ledger/secrets/credentials paths → explicit confirmation, never automatic.
3. Every SQL file (Agent 1's own `db_change` approval – the Orchestrator never creates, edits or decides an approval).
4. Destructive SQL (DELETE / UPDATE / ALTER … DROP / ALTER COLUMN TYPE) → extra destructive confirmation; never runs automatically.
5. Production promotion, protected-branch merge, workflow runs, env changes, rollback: not reachable from the Orchestrator at all (allow-list), so they stay in Agent 2 / Agent 1 with their own approvals.
Rules enforced: an unreadable approval is **not** approval (workflow waits, nothing runs); an approval is accepted only if `decided_by` is a listed owner/admin; code and SQL approvals expire after 24 h (SQL expiry is now also checked by the Orchestrator); the owner decision and the operation it authorised are stored in the workflow (`steps.approval.decision`, `steps.sql.items[].decision`).
Routine, automatic (no owner action): proposal build, CI status reads, Agent 1 health/verification, the commit **after** the owner's approval, non-destructive SQL **after** the owner's approval (the Orchestrator supplies Agent 1's `RUN-SQL` acknowledgement only in that case; the manual `apply_sql` button path still demands it from you).

## 6. Failure handling and logging
* Success: `outcome = "Successful"`, event history is not returned, no `success`/`info` log rows are written (removed: workflow-started, change-applied, sql-applied, healthy-completed). Dashboard shows only "Successful" (report is behind a collapsed "Report").
* Failure: the dashboard shows agent, stage, task (+ agent task id), error code, the **actual** error text (e.g. failed CI job/step), and recovery guidance; dependants `Blocked`. One `error` log row per failure. Warnings (non-healthy verdict, blocked SQL) are still logged.
* Retry: only read-only stages (CI status read, Agent 1 verification). Transient errors (429/503/504, timeouts, network) retry inline up to 2×, then up to 3 polls, then the workflow fails with a Retry button (max 5). Commit, SQL, real CI failures, rejected/expired approvals and anything interrupted mid-commit/SQL are never retried automatically; a retry resumes at the failed stage and never repeats a completed one.

## 7. Dashboard
Mobile-first, same component: outcome badge, running agent/action, task pipeline, "needs your approval" box (sensitive items flagged), pending-approvals banner on the list, failure box with recovery + Retry, confirm checkboxes only for sensitive/destructive steps.

## 8. Agent 3 independence
No import, env var, call or auto-start in `orchestrator/*` (source scan test + no Agent 3 request + agent row stays `offline`).

## 9/10. Tests and build — executed here
* `tsc` (real, with `@types/node`) for agent1, agent2, agent3, orchestrator: **0 errors**.
* `node --test`: **161 tests, 161 pass, 0 fail** (agent1 26, agent2 32, agent3 36, orchestrator 67). All services mocked; no real GitHub/Supabase/Vercel/Gemini call, no production change.
* New tests cover: routine stages without approval, only "Successful" + no success/info logs, mandatory code approval + decision record, sensitive files (4 paths), SQL never auto-approved / destructive never auto-runs, unauthorized caller/actions, non-owner approval, unreadable approval, failed-task details + blocked dependants + Agent 1 not started, transient retry without a second commit, verification retry, expired code/SQL approvals, Agent 3 independence, parallel advance, interrupted retry rules.
* `vite build` was **not** run (Vite is not installed in this environment); `src/Orchestrator.jsx` was only syntax-checked by transpiling. Run `npm run build` locally.

## 11. Manual verification before use
1. `npm install && npm test && npm run build`.
2. Preview deployment, non-production repo: upload a ZIP; confirm nothing is written to GitHub until you approve; after approving, confirm the commit, CI check and Agent 1 verification happen without further taps and the card ends at "Successful".
3. Upload a change touching `.github/` or `api/`: confirm it waits for the confirmation checkbox.
4. Break CI on purpose: confirm agent/stage/task/error/recovery are shown and Agent 1 never starts.
5. ZIP with a harmless `ai_control` migration: approve it in Approvals; confirm it runs by itself once. With a `DELETE ... WHERE`: confirm it waits for the destructive confirmation.
6. No database migration is needed.
