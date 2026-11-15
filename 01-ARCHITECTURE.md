# Architecture

## Diagram

```
 Android phone (browser / PWA)
        |
        | HTTPS
        v
 +-------------------------+
 | Vercel (free)           |
 |  - Static dashboard     |  <- React UI, only PUBLIC keys
 |  - /api serverless fns  |  <- server-side secrets live here
 +-----------+-------------+
             |                         
   anon key + user JWT        service-role key / Gemini key
   (browser -> Supabase)      (server only, never in browser)
             |                         |
             v                         v
 +-------------------------------------------------+
 | Supabase TEST project "Denim Hub Bsl"           |
 |  schema ai_control (isolated)  + Auth + RLS     |
 |  public / private / storage: UNTOUCHED          |
 +-------------------------------------------------+
             ^
             | (Phase 2+, not now)
   Agent 1 / Agent 2 / Agent 3  -> write status, logs,
   tasks, approvals, usage via /api (server-side)

 Blisscco-Ad-network- project: NOT CONNECTED
 Existing ad-network tables in Denim Hub (public schema): NOT TOUCHED
```

## Dashboard sections (8)
1. Overview - counts, agent status cards, recent activity
2. Agents - 3 placeholder slots (offline until Phase 2)
3. Tasks - create, list, filter, history, success/fail badges
4. Activity Logs - append-only, filter by level/agent
5. Approvals - pending list, Approve / Reject with note
6. API Usage - tokens/requests per day, per agent, per model
7. System Health - component status + latency
8. Settings - profile, theme, thresholds, sign out

## Data flows
- Login: Supabase Auth -> JWT -> RLS checks every query.
- Live updates: Supabase Realtime on agents, tasks, approvals, activity_logs.
- Agent status: agent heartbeat -> /api/heartbeat -> agents.last_heartbeat_at.
  UI shows "offline" if heartbeat older than 2 min.
- Task: user creates task -> pending -> (Phase 2) agent picks up -> running -> succeeded/failed.
- Approval: agent requests -> approvals(pending) -> user taps Approve/Reject -> agent reads decision.
- Gemini: browser never calls Gemini. Only /api functions (Phase 2+).

## Isolation model
- Separate DB schema `ai_control` inside Denim Hub Bsl (TEST). Own tables, functions, policies.
- Shared auth.users, so access = allowlist table ai_control.owners, not just "logged in".
- No references to billing, payment, payout or ledger objects.
- Separate Vercel project and GitHub repo; existing Vercel Preview config untouched.
- Browser client uses db schema `ai_control`; service-role key only in server env vars.
