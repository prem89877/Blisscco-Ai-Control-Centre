# Inspection Report - Denim Hub Bsl (read-only, nothing modified)

Project: Denim Hub Bsl  (ref ficwuieqjdhrrxbvuqot, ap-northeast-2, Postgres 17, ACTIVE_HEALTHY)
Blisscco-Ad-network- project (other project in the org): NOT accessed.
Only SELECT queries were run. No migration, no DDL.

## Existing objects found (must stay untouched)
- Schemas: auth, cron, extensions, graphql, graphql_public, private, public, realtime, storage, supabase_migrations, vault
- `ai_control` schema: does NOT exist yet (no name collision)
- public: 35 tables (ads, campaigns, advertisers, publishers, financial_ledger, advertiser_payments, payment_*, payout_*, payments_audit_log, safety_audit_log, profiles, admins, products ...). All have RLS enabled; 26 policies.
- private: 40+ guard/ledger/payout functions. public + private: 103 functions. 60 triggers.
- Storage buckets: products, creative-assets (7 storage policies)
- Realtime publication supabase_realtime contains only public.visit_requests
- Extensions: pg_cron, pg_stat_statements, pgcrypto, plpgsql, supabase_vault, uuid-ossp
- auth.users: 20 users (profiles: 14 advertiser, 4 publisher, 2 admin). public.admins is empty.

## Baseline snapshot (to prove nothing changed after migration)
| item | value |
|---|---|
| public tables | 35 |
| public policies | 26 |
| storage policies | 7 |
| functions (public+private) | 103 |
| triggers (public/auth/storage) | 60 |
| event triggers | 7 |
| buckets | 2 |
| profiles rows / auth.users | 20 / 20 |
| policy md5 (public+storage) | d3f120da6185a2b27386f29b9c23a7f6 |
| function md5 (public+private) | 40c4139ecb6770ae177e630e17fdbc11 |

08-VERIFY.sql re-computes these after the migration; all must match.

## Risks found and how the SQL handles them
1. SHARED AUTH: the 20 ad-network users can log in with the same anon key.
   -> "authenticated" grants nothing by itself; every policy requires ai_control.is_owner() (allowlist table ai_control.owners).
2. TRIGGER ON auth.users (on_auth_user_created -> handle_new_user) writes to public.profiles.
   -> Do NOT sign up a new user. Reuse an existing admin auth user as owner (needs your decision: which email?).
3. DEFAULT PRIVILEGES give new tables to anon/authenticated/service_role.
   -> Script revokes all, then grants least privilege. No anon access at all.
4. ensure_rls event trigger covers only schema public.
   -> RLS enabled explicitly on all 8 ai_control tables.
5. Name collisions: public.is_admin(), public.set_updated_at(), public.profiles exist.
   -> ai_control uses its own functions, schema-qualified, never touches the public ones.
6. API exposure: ai_control must be added to "Exposed schemas" in Dashboard (project-level API setting). Needs your OK. Frontend client uses db: { schema: 'ai_control' }.
7. Realtime publication is shared (has visit_requests). Adding our tables edits that publication -> kept optional; default is polling.
8. Vercel: existing Vercel Preview config of Denim Hub / Blisscco is NOT touched. Use a NEW Vercel project with its own env vars.

## Rollback (only if you ask; ai_control only, destructive so needs approval)
`drop schema ai_control cascade;` removes only what this migration created.
