# Security Architecture

## Secrets
| Secret | Where it lives | In browser? |
|---|---|---|
| Supabase URL | VITE_SUPABASE_URL (public) | yes (safe) |
| Supabase anon key | VITE_SUPABASE_ANON_KEY (public, RLS protected) | yes (safe) |
| Supabase service-role key | Vercel env var SUPABASE_SERVICE_ROLE_KEY, server only | NEVER |
| Gemini API key | Vercel env var GEMINI_API_KEY, server only | NEVER |

- Never prefix secrets with VITE_ (Vite exposes those to the browser).
- .env is in .gitignore; only .env.example (placeholders) is committed.
- Set env vars in the Vercel dashboard, scoped to Preview first. Production scope untouched.
- If a key ever leaks: rotate it in the provider dashboard immediately.

## Authentication
- Supabase Auth (shared with the ad-network users). Public signup setting is NOT changed (it would affect the ad network).
- Access is restricted by ai_control.owners allowlist + RLS, so ad-network users get zero rows.
- Owner = an EXISTING admin auth user (no new signup, avoids the handle_new_user trigger on auth.users).
- Optional TOTP 2FA for owner.
- Every route in the UI is behind a session check; RLS is the real enforcement.

## Authorization
- ai_control.owners.role (owner/admin/viewer). ai_control.is_owner() used in every policy.
- anon: all privileges revoked (project default ACLs would otherwise grant them) and no policies.
- Column-level UPDATE grants; no DELETE/TRUNCATE for browser roles.
- No DELETE policies. Logs are append-only.
- Agents (Phase 2) write only through /api functions using the service role, after validating a per-agent secret.

## Other controls
- HTTPS only (Vercel default). Add security headers in vercel.json (CSP, X-Frame-Options, nosniff).
- Input validation in /api functions.
- Rate-limit sensitive endpoints in Phase 2.
- Separate Supabase + Vercel projects from Blisscco production.
- Approval required before any sensitive operation (design principle for agents).

## Verification planned for Prompt 3
Secret scan of repo and built bundle, anon-key access test against every table, unauthenticated request tests, RLS policy review.
