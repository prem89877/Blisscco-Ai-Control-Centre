# Phase 3 Part 1 - Orchestrator Report
Date: 2026-11-17

## 1. Files
New: `orchestrator/{config,store,workflow,server,index}.ts`, `orchestrator/orchestrator.test.ts`, `orchestrator/tsconfig.json`, `api/orchestrator.js`, `src/Orchestrator.jsx`, this report.
Modified: `package.json` (build/test include orchestrator), `vercel.json` (new function), `src/App.jsx` (tab), `src/ui.jsx` (icon), `README.md`.
Unchanged: everything in `agent1/`, `agent2/`, `agent3/`, `api/agent*.js`, SQL files.

## 2. Database
No migration. Workflows are rows in existing `ai_control.tasks` (`payload.kind = 'orchestration'`, id = client request_id). Approvals are the existing Agent 2 approvals. Logs go to `activity_logs`. RLS/owners unchanged.

## 3. Workflow
start -> Agent 2 `propose_change`/`ai_fix` (nothing written to GitHub) -> stage `awaiting_approval` -> you approve in Approvals -> `apply` (Agent 2 `apply_change`, own agent2/* branch) -> `ci_waiting` -> `check_ci` (Agent 2 `actions_status`, per commit) -> only when CI passes: Agent 1 `health_report` -> `completed` + combined report. Any failure -> `failed`, reason shown, no further step. `cancel` available before commit/verification finishes.

## 4. Integrations
Agent 2 allowed calls: propose_change, ai_fix, apply_change, actions_status. Agent 1 allowed call: health_report (read-only). Everything else (promote, rollback, workflow run, env, SQL, redeploy) is not reachable.
Limitation: Agent 2's server-side API does not run lint/tests (Termux only); CI after the commit is the check.
Limitation: Agent 1 sees a Vercel preview for the branch only if Vercel built it and it appears in its recent deployments; otherwise the report warns.

## 5. Agent 3
Not imported, not configured, never called. Tests assert it.

## 6. Safety
Owner check on every request; approval must be approved, <24h, unused, linked to this workflow; Agent 2's own gates run again; sensitive-file tick required; optimistic lock (`rev`) + approval claim stop double execution; stale steps are marked interrupted; all output redacted with both agents' secrets.

## 7. Tests
`npm test` -> 121 pass / 0 fail (27 orchestrator + existing Agent 1/2/3). Fakes only; no live GitHub/Supabase/Vercel call was made.
Build: all four `tsc` projects compile. `vite build` was NOT run here (no network to install vite); run `npm run build` once.

## 8. Phase 3 Part 2
ZIP upload, file-change preview, Deployment Control Center.
