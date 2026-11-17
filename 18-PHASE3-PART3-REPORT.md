# Phase 3 Part 3 — Reliability, Persistent Monitoring, Recovery, Notifications — Report

Extends the existing Orchestrator / Deployment Control Center. No new application, no new tables or migrations (uses the existing `ai_control.tasks`, `approvals`, `activity_logs`). All Part 1 and Part 2 safeguards, approvals, duplicate locks and the Agent 3 separation are unchanged.

> This ZIP is cumulative: it also contains the Part 2 hardening files (`agent2/gemini.ts`, `agent2/agent.ts`, `16-PHASE3-PART2-REPORT.md`) because `orchestrator/workflow.ts` depends on them. Applying this ZIP alone is enough.

## 1. Files
| File | Change |
|---|---|
| `orchestrator/monitor.ts` | **new** – task visibility, recovery plans, health checks (pure/cached) |
| `orchestrator/workflow.ts` | modified – actions `monitor`, `health`, `resume`, `resolve_sql`; retry policy; failure de-dup; richer history; already-applied SQL skipped |
| `orchestrator/policy.ts` | modified – `retryPolicy`, `backoffMs`, protected ZIP paths, SQL outcome classification |
| `orchestrator/store.ts` | modified – read helpers: active workflows, pending approvals, task row |
| `orchestrator/orchestrator.test.ts` | modified – 10 Part 3 tests + mock routes |
| `src/Monitor.jsx` | **new** – green dot hook/component + monitor panel |
| `src/App.jsx`, `src/Approvals.jsx`, `src/Orchestrator.jsx`, `src/styles.css` | modified – dot in nav/Approvals, monitor panel, richer history |
| `.env.example`, docs | optional settings, this report |

## 2–3. Persistent task visibility and five-minute retention
`monitor` rebuilds the task list from the persisted workflow rows and the **server clock** on every call. Running/waiting tasks are shown for as long as they run (no relation to any timeout). A finished or failed task is shown until `its stored end time + retention`; retention is 300 s and cannot be configured lower (`ORCH_VISIBILITY_SECONDS` may only raise it). The countdown is computed by the server (`remaining_s`) from the stored timestamp, so refresh/restart/another device never restarts it. Expired entries are only left out of the view: workflow rows, approvals and `activity_logs` are never deleted. Each entry: task, agent, status, execution time, remaining time.

## 4. Approval green indicator
Derived only from persisted approvals with `status = 'pending'` (frontend hook re-reads every 8 s, on focus, visibility and reconnect; `monitor` returns the same list server-side). Several pending requests are counted; approved / rejected / expired / cancelled are not. Shown on the Approvals nav item, the Approvals page heading and the monitor card (tap opens the Approvals tab where the real details are). Nothing is ever approved by this code; decisions stay in the Approvals tab (RLS + server-side owner verification).

## 5. Refresh / restart persistence
No dashboard state is authoritative: indicator, task list, countdown, interrupted list and notifications are recomputed from database rows. Verified by tests that call `monitor` again with no in-memory state after each change.

## 6. Crash recovery
A transient stage (`proposing`, `applying`, `applying_sql`, `verifying`) with no progress for 5 min (`ORCH_STALE_MS`) is marked **interrupted** (this existed; now surfaced). `monitor` lists interrupted workflows with a recovery plan; `resume` acts only when safe:
* read-only stage (CI / verification) → resumes, finished stages are kept, not repeated;
* interrupted commit → GitHub is asked first: commit found (message carries the approval id) → continue at CI, **no second commit**; branch absent → proven not committed, commit lock released; anything else → stops with a message;
* uncertain / failed SQL → decided from recorded facts only (Agent 1 task result, approval claim state, Supabase status): *applied* → continue (never re-run); *not applied* (rejected 4xx / never claimed) → back to the SQL approval stage (24 h rule, `RUN-SQL`, and `APPROVE-DESTRUCTIVE` for destructive SQL still required; never automatic); *uncertain* → stays stopped. The owner then records what he saw in Supabase with `resolve_sql` (needs `VERIFIED-IN-SUPABASE`); “applied” continues, “not applied” releases the lock and requires a corrected new upload (the used approval cannot be reused).
* proposing → nothing was written; start again.

## 7. Retry and resume
Read-only calls only: `ORCH_RETRY_MAX_ATTEMPTS` (1–6, default 3), exponential backoff from `ORCH_RETRY_BASE_MS` (default 250 ms, doubling), hard cap `ORCH_RETRY_MAX_TOTAL_MS` (default 15 s). Permanent / unauthorized / security errors are never retried; commit and SQL are never auto-retried. After exhaustion the workflow shows a clear failed state; manual Retry/Resume remain (max 5 manual retries).

## 8. Health monitoring
`health`: Orchestrator (workflow DB), Agent 1, Agent 2 (derived from their integrations, “busy” while running a stage), Gemini, GitHub, Supabase, Vercel — states Healthy / Busy / Unavailable / Failed / Unknown. Lightweight metadata calls (GitHub `/rate_limit`, Vercel `projects?limit=1`, Gemini model list, Supabase REST ping), 4 s timeout each, cached 30–300 s, failing services back off 30 s → 5 min. Responses carry only states and short reasons (no keys, no provider error bodies). Agent 3 is not probed or started; shown as “independent”.

## 9. Workflow history / notifications
History rows: workflow id, agents, status, started, finished, retries, approval status, failure details + recovery guidance. Success = “Successful” only, no logs, no notification. One failure notification per failure event (`event_id`; the failure is logged once even if two requests report it concurrently); shows agent, stage, reason, recovery. The dashboard remembers dismissed ids only in `localStorage` as a convenience.

## 10. Security
Owner check on every action (unchanged); `monitor`/`health` are read-only; `resume` and `resolve_sql` write only through the existing CAS-protected workflow row and the existing locks; all approval/SQL/commit gates, ai_control restriction, protected paths, duplicate locks and idempotency are untouched. Parallel workers: stage changes use the `rev` compare-and-set, tests prove one commit / one SQL execution.

## 11. Agent 3
Not imported, not called, not probed (source-scan + request-log tests).

## 12. Tests and build (executed here)
* `tsc --noEmit` agent1/2/3/orchestrator: 0 errors. * `tsx --test` all suites: **177 / 177 pass** (run twice). New Part 3 tests cover items 1–3, 6–19 of the brief (backend side).
* **Not executed:** `npm test`, `vite build` (no network, vite / `@types/node` not installed here). The new React files compile with esbuild, but the **dot, countdown and buttons were not exercised in a browser or jsdom**; “survives refresh/restart” is verified on the server data they read, not by driving the UI.

## 13. Manual checks
1. `npm install && npm test && npm run build`.
2. Create any approval → green dot appears on Approvals within ~8 s; approve/reject → disappears; reload the page → same.
3. Run a workflow, reload during/after: tasks still listed; a finished one counts down from its real end time.
4. Preview env only: kill the server during “applying”, reopen → “Interrupted”, press Verify.
5. Check Health card; confirm no secrets in `/api/orchestrator` `health` response.
