# Agent 1 - Infrastructure & Deployment Agent (Phase 2 / Part 1)

## Integration (from Phase 1 inspection)
- Reuses Phase 1 tables as-is: `agents` (slot 1), `tasks`, `approvals`, `activity_logs`, `api_usage`, `system_health`. **No SQL migration.**
- Runs server-side only: `/api/agent1` (Vercel function, 2nd of 12 Hobby slots) and Termux CLI. Browser never sees any key.
- Auth: same as `/api/health` (Supabase JWT + `ai_control.owners`).
- Dashboard: Agents tab -> "Agent 1 console" (run buttons, report view, env/DB requests, apply approved). Overview, Tasks, Logs, Approvals, API Usage, Health tabs fill automatically from the rows Agent 1 writes. Heartbeat every 60s while dashboard is open.
- Not built: Orchestrator, automatic workflows, Agents 2-3.

## Safety model
| Rule | How it is enforced |
|---|---|
| Read-only default | Vercel/GitHub: GET only. Supabase: only `/database/query/read-only` + static SQL guard (SELECT/WITH only). |
| Env changes need approval | `request_env_change` -> approval (pending). `apply_env_change` runs only if status=approved, <24h old, not executed, value fingerprint matches. |
| Production | Extra explicit confirmation (`APPROVE-PRODUCTION`) on top of approval. |
| DB modifications | Agent only *proposes* (ai_control-only, blocked for public/private/auth/storage/billing/payout/ledger). It never executes SQL; you run it in the SQL Editor after approving. |
| No secrets exposed | Values never read/returned/stored (env list = names only; env values are re-entered at apply time, only an HMAC fingerprint is kept). All DB writes and responses are redacted. |
| Gemini | Dedicated `AGENT1_GEMINI_API_KEY`, server only, no tools; report text treated as data. Usage logged to `api_usage`. |

## Evidence (`npm test`, 17/17 pass, TypeScript compiles clean)
Run against an in-memory fake of Vercel, Supabase (REST/Auth/Mgmt), GitHub and Gemini:
- 401 no/invalid token, 403 non-owner, 405 wrong method, 500 unconfigured, 400 unknown action.
- `health_report`: task succeeded, logs, usage rows (gemini tokens + vercel calls), 3 health rows, agent idle; every Vercel/GitHub call was GET, every Supabase Mgmt call was `.../read-only`; zero Vercel writes.
- Detects: failed prod deploy (with error), missing required env, secret under `VITE_` prefix, plain-text secrets, RLS off, anon grants, open anon policies.
- Secret scan: none of the 5 provider keys appear in any response or DB row.
- Env change: blocked before approval (409), without production ack (403), with wrong value (409); applied once; second apply 409; **value absent from all DB writes and responses**.
- DB proposal: blocked for `public.*`, creates approval only for `ai_control.*`, no SQL executed.
- Failure path: bad Vercel token -> task failed, agent status `error`, error log.

## Not verified (no internet in build sandbox)
- Live calls to Vercel / Supabase Mgmt / GitHub / Gemini (endpoints checked against current docs; Supabase read-only endpoint is Beta).
- `vite build` and on-device run: do `npm install && npm test && npm run build` in Termux.
