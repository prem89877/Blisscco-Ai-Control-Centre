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

## Test data (Supabase SQL editor)
```
insert into ai_control.approvals (title, details)
values ('Test approval', '{"note":"demo"}');
```
