# Technology Stack (all free-tier compatible)

| Layer        | Choice                          | Why |
|--------------|---------------------------------|-----|
| Frontend     | Vite + React + plain CSS        | Light, fast builds, mobile-first, easy on Termux |
| Hosting      | Vercel Hobby                    | Free, GitHub auto-deploy, Preview URLs |
| Serverless   | Vercel Functions (/api)         | Holds secrets, future agent endpoints |
| Auth         | Supabase Auth (email+password)  | Built in, JWT, optional TOTP 2FA |
| Database     | Supabase Postgres + RLS         | Free tier, SQL editor in browser |
| Realtime     | Supabase Realtime               | Live status without extra service |
| AI (Phase 2) | Gemini API via server only      | Key never in browser |
| Source       | GitHub                          | Branch per phase |
| Editing      | SPCK Editor                     | Edit/commit from Android |
| Terminal     | Termux (git, node, npm)         | Build/test from phone |
| Charts       | Lightweight (CSS bars / small lib) | Keep bundle small for mobile |
| PWA          | Web manifest                    | "Add to Home screen" on Android |

Not used: Docker, desktop apps, Supabase CLI local stack (needs Docker).
Schema changes are applied via the Supabase dashboard SQL Editor.

Free-tier notes: Supabase free projects pause after inactivity; Vercel Hobby has function time limits. Both are fine for Phase 1.
