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
