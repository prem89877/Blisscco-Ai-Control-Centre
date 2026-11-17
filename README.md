# Blisscco AI Control Center

Vite + React + Supabase (schema `ai_control`). Deploy on Vercel.

## Vercel env vars (Production)
- VITE_SUPABASE_URL
- VITE_SUPABASE_ANON_KEY
- SUPABASE_SERVICE_ROLE_KEY  (server only)

Build command: `npm run build`  Output: `dist`  Framework: Vite

## Termux
```
npm install
npm run build
git add . && git commit -m "update" && git push
```

## Agent 1 (Infrastructure & Deployment)
Code: `agent1/*.ts` -> built to `agent1/dist` by `npm run build`. API: `/api/agent1`. UI: Agents tab.
Env vars: see `.env.example` (AGENT1_*). No SQL migration needed.
Termux: `npm install && npm test` then `npm run agent1 -- health` (secrets in `.env.agent1`, git-ignored).
Details and test evidence: `09-AGENT1-REPORT.md`.

## Agent 2 (Development & GitHub)
Code: `agent2/*.ts` -> built to `agent2/dist` by `npm run build`. API: `/api/agent2` (GitHub API actions). UI: Agents tab -> slot 2 console.
Env vars: see `.env.example` (AGENT2_*). No SQL migration needed.
Termux (real git, lint/tests, commands): `npm run agent2 -- <command>` (secrets in `.env.agent2`, git-ignored). Run `npm run agent2` for the command list.
Flow: `local-apply --file=change.json` -> `checks` -> `commit --message="..."` -> `request-push` -> approve in dashboard -> `apply-push --approval=<id>`.
Details and test evidence: `12-AGENT2-REPORT.md`.


## Orchestrator (Phase 3 Part 1)
Limited, semi-automatic coordination of Agent 2 (dev) and Agent 1 (infra). Agent 3 is NOT part of it (manual QA only).
Code: `orchestrator/*.ts` -> `orchestrator/dist` by `npm run build`. API: `/api/orchestrator`. UI: Orchestrator tab.
No new env vars, no DB migration: it reuses the Agent 1 / Agent 2 settings and the existing `ai_control.tasks` / `approvals` / `activity_logs`.
Flow: Create task -> Agent 2 proposal -> you approve (Approvals tab) -> Apply (agent2/* branch + commit) -> Check CI -> Agent 1 verifies GitHub/Vercel/Supabase -> combined report. Production promotion stays a separate Agent 2 approval.


## Phase 3 Part 2 ZIP Deployment Control Center

The existing Orchestrator dashboard accepts a ZIP of changed files (and optional `ai_control` SQL migrations). The ZIP is validated on the server only; Gemini sees only a compact bounded diff summary (max 14,000 chars). Code needs your approval before Agent 2 commits to its own `agent2/*` branch; SQL needs a separate Agent 1 approval after CI passes. Agent 3 and production promotion stay manual. See `16-PHASE3-PART2-REPORT.md`.

## Orchestrator automation (Phase 3 Part 1 update)
The Orchestrator now advances routine stages by itself (`advance` action, dashboard auto-polls) and asks the owner only for sensitive or mandatory steps. Successful runs show only "Successful"; failures show agent, stage, task, the real error and recovery guidance. See `17-PHASE3-PART1-AUTOMATION-REPORT.md`.
