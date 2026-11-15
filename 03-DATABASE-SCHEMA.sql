-- =====================================================================
-- PROPOSED MIGRATION - NOT EXECUTED - WAITING FOR USER APPROVAL
-- Target: Supabase TEST project "Denim Hub Bsl" (ficwuieqjdhrrxbvuqot)
-- Creates ONLY the new schema "ai_control". Touches nothing else.
--   * no ALTER/DROP/UPDATE/DELETE on public, private, storage or auth
--   * no change to existing functions, triggers, policies, buckets
--   * no billing / payment / payout / ledger object is referenced
--   * only external reference: FK to auth.users(id) from ai_control.owners
-- Fully idempotent (IF NOT EXISTS / OR REPLACE) and contains no DROP.
-- =====================================================================

-- ---------- 1. schema + access ----------
create schema if not exists ai_control;
revoke all on schema ai_control from public, anon;
grant usage on schema ai_control to authenticated, service_role;

-- ---------- 2. own helper functions (never reuse public.* ones) ----------
create or replace function ai_control.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;

-- ---------- 3. owners allowlist ----------
-- auth.users is SHARED with the ad-network (20 existing users), so being
-- "authenticated" must grant NOTHING. Only users listed here get access.
create table if not exists ai_control.owners (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner','admin','viewer')),
  created_at timestamptz not null default now()
);

create or replace function ai_control.is_owner()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from ai_control.owners o
    where o.user_id = (select auth.uid()) and o.role in ('owner','admin')
  );
$$;
revoke all on function ai_control.is_owner() from public, anon;
grant execute on function ai_control.is_owner() to authenticated, service_role;

-- ---------- 4. tables ----------
create table if not exists ai_control.agents (
  id uuid primary key default gen_random_uuid(),
  slot int not null unique check (slot between 1 and 3),
  name text not null,
  description text,
  status text not null default 'offline'
    check (status in ('offline','idle','running','error','disabled')),
  last_heartbeat_at timestamptz,
  config jsonb not null default '{}'::jsonb,      -- NEVER store secrets
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ai_control.tasks (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references ai_control.agents(id) on delete set null,
  title text not null,
  description text,
  status text not null default 'pending'
    check (status in ('pending','queued','running','awaiting_approval','succeeded','failed','cancelled')),
  priority int not null default 3 check (priority between 1 and 5),
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  error_message text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists idx_aic_tasks_status on ai_control.tasks(status, created_at desc);
create index if not exists idx_aic_tasks_agent  on ai_control.tasks(agent_id);

create table if not exists ai_control.approvals (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references ai_control.tasks(id) on delete set null,
  agent_id uuid references ai_control.agents(id) on delete set null,
  title text not null,
  details jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','expired')),
  requested_at timestamptz not null default now(),
  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  decision_note text
);
create index if not exists idx_aic_appr_status on ai_control.approvals(status, requested_at desc);

create table if not exists ai_control.activity_logs (
  id bigint generated always as identity primary key,
  agent_id uuid references ai_control.agents(id) on delete set null,
  task_id uuid references ai_control.tasks(id) on delete set null,
  actor_type text not null check (actor_type in ('user','agent','system')),
  actor_id uuid,
  level text not null default 'info' check (level in ('info','success','warn','error')),
  action text not null,
  message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_aic_logs_created on ai_control.activity_logs(created_at desc);
create index if not exists idx_aic_logs_agent   on ai_control.activity_logs(agent_id, created_at desc);

create table if not exists ai_control.api_usage (
  id bigint generated always as identity primary key,
  agent_id uuid references ai_control.agents(id) on delete set null,
  provider text not null default 'gemini',
  model text,
  endpoint text,
  request_count int not null default 1,
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  status_code int,
  cost_estimate numeric(12,6) not null default 0,
  occurred_at timestamptz not null default now()
);
create index if not exists idx_aic_usage_time on ai_control.api_usage(occurred_at desc);

create table if not exists ai_control.system_health (
  id bigint generated always as identity primary key,
  component text not null,
  status text not null check (status in ('ok','degraded','down')),
  latency_ms int,
  details jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default now()
);
create index if not exists idx_aic_health_comp on ai_control.system_health(component, checked_at desc);

create table if not exists ai_control.settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

-- ---------- 5. triggers (all on ai_control tables only) ----------
drop trigger if exists aic_agents_updated on ai_control.agents;
create trigger aic_agents_updated before update on ai_control.agents
  for each row execute function ai_control.set_updated_at();

drop trigger if exists aic_tasks_updated on ai_control.tasks;
create trigger aic_tasks_updated before update on ai_control.tasks
  for each row execute function ai_control.set_updated_at();

-- approvals: stamp decision time server-side
create or replace function ai_control.approvals_stamp()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'pending' and new.status in ('approved','rejected') then
    new.decided_at = now();
  end if;
  return new;
end $$;
drop trigger if exists aic_approvals_stamp on ai_control.approvals;
create trigger aic_approvals_stamp before update on ai_control.approvals
  for each row execute function ai_control.approvals_stamp();

-- activity_logs: append-only, even for service_role
create or replace function ai_control.block_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'ai_control.% is append-only', tg_table_name; end $$;
drop trigger if exists aic_logs_no_update on ai_control.activity_logs;
create trigger aic_logs_no_update before update or delete on ai_control.activity_logs
  for each row execute function ai_control.block_mutation();

-- ---------- 6. seed (3 placeholder agents, ai_control only) ----------
insert into ai_control.agents (slot, name, description) values
  (1,'Agent 1','Placeholder - not built yet'),
  (2,'Agent 2','Placeholder - not built yet'),
  (3,'Agent 3','Placeholder - not built yet')
on conflict (slot) do nothing;

-- ---------- 7. Row Level Security (explicit: the project's ensure_rls
--            event trigger only covers schema public) ----------
alter table ai_control.owners        enable row level security;
alter table ai_control.agents        enable row level security;
alter table ai_control.tasks         enable row level security;
alter table ai_control.approvals     enable row level security;
alter table ai_control.activity_logs enable row level security;
alter table ai_control.api_usage     enable row level security;
alter table ai_control.system_health enable row level security;
alter table ai_control.settings      enable row level security;

-- owners: a user may read only their own allowlist row; no writes from clients
create policy "owners_select_self" on ai_control.owners
  for select to authenticated using (user_id = (select auth.uid()));

create policy "agents_select" on ai_control.agents
  for select to authenticated using (ai_control.is_owner());
create policy "agents_update" on ai_control.agents
  for update to authenticated
  using (ai_control.is_owner()) with check (ai_control.is_owner());

create policy "tasks_select" on ai_control.tasks
  for select to authenticated using (ai_control.is_owner());
create policy "tasks_insert" on ai_control.tasks
  for insert to authenticated
  with check (ai_control.is_owner() and created_by = (select auth.uid()));
create policy "tasks_update" on ai_control.tasks
  for update to authenticated
  using (ai_control.is_owner()) with check (ai_control.is_owner());

create policy "approvals_select" on ai_control.approvals
  for select to authenticated using (ai_control.is_owner());
create policy "approvals_decide" on ai_control.approvals
  for update to authenticated
  using (ai_control.is_owner() and status = 'pending')
  with check (ai_control.is_owner()
              and decided_by = (select auth.uid())
              and status in ('approved','rejected'));

create policy "logs_select" on ai_control.activity_logs
  for select to authenticated using (ai_control.is_owner());
create policy "logs_insert_user" on ai_control.activity_logs
  for insert to authenticated
  with check (ai_control.is_owner() and actor_type = 'user'
              and actor_id = (select auth.uid()));

create policy "usage_select" on ai_control.api_usage
  for select to authenticated using (ai_control.is_owner());
create policy "health_select" on ai_control.system_health
  for select to authenticated using (ai_control.is_owner());

create policy "settings_select" on ai_control.settings
  for select to authenticated using (ai_control.is_owner());
create policy "settings_insert" on ai_control.settings
  for insert to authenticated with check (ai_control.is_owner());
create policy "settings_update" on ai_control.settings
  for update to authenticated
  using (ai_control.is_owner()) with check (ai_control.is_owner());

-- ---------- 8. Privileges (least privilege) ----------
-- Project default ACLs auto-grant new tables to anon/authenticated, so strip
-- everything first, then grant back only what is needed.
revoke all on all tables    in schema ai_control from public, anon, authenticated;
revoke all on all sequences in schema ai_control from public, anon, authenticated;
revoke all on all functions in schema ai_control from public, anon;

-- authenticated (still gated by RLS + owners allowlist)
grant select on ai_control.owners, ai_control.agents, ai_control.tasks,
                ai_control.approvals, ai_control.activity_logs,
                ai_control.api_usage, ai_control.system_health,
                ai_control.settings to authenticated;
grant insert on ai_control.tasks, ai_control.activity_logs, ai_control.settings to authenticated;
grant update (name, description, config)                      on ai_control.agents    to authenticated;
grant update (title, description, priority, status)           on ai_control.tasks     to authenticated;
grant update (status, decided_by, decision_note)              on ai_control.approvals to authenticated;
grant update (value, updated_by, updated_at)                  on ai_control.settings  to authenticated;
-- no DELETE and no TRUNCATE granted to anyone from the browser

-- service_role (server-side only: Vercel /api functions, future agents)
grant all on all tables in schema ai_control to service_role;
grant execute on all functions in schema ai_control to service_role;

-- ---------- 9. OPTIONAL, needs separate approval ----------
-- (a) Dashboard: Settings > API > Exposed schemas -> add "ai_control"
--     (project-level setting; required for the browser/serverless to reach it)
-- (b) Realtime: this ADDS tables to the existing publication that currently
--     contains public.visit_requests. Skip it and the UI polls every 10s.
-- alter publication supabase_realtime add table
--   ai_control.agents, ai_control.tasks, ai_control.approvals, ai_control.activity_logs;

-- ---------- 10. Owner bootstrap (run AFTER approval, ONE row) ----------
-- Reuse an EXISTING auth user. Do NOT sign up a new user: the existing trigger
-- on_auth_user_created -> handle_new_user would write into public.profiles.
-- insert into ai_control.owners (user_id, role)
--   select id, 'owner' from auth.users where email = 'YOUR_EXISTING_ADMIN_EMAIL'
--   on conflict (user_id) do nothing;
