-- READ-ONLY verification, run AFTER the approved migration.

-- A. Existing objects unchanged (compare with 07-INSPECTION-REPORT.md baseline)
select
 (select count(*) from pg_tables where schemaname='public') as public_tables,            -- 35
 (select count(*) from pg_policies where schemaname='public') as public_policies,        -- 26
 (select count(*) from pg_policies where schemaname='storage') as storage_policies,      -- 7
 (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname in ('public','private')) as app_functions,                            -- 103
 (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid
   join pg_namespace n on n.oid=c.relnamespace
   where not t.tgisinternal and n.nspname in ('public','auth','storage')) as triggers,   -- 60
 (select count(*) from storage.buckets) as buckets,                                      -- 2
 (select count(*) from pg_event_trigger) as event_triggers,                              -- 7
 (select count(*) from public.profiles) as profiles_rows,                                -- 20
 (select md5(string_agg(schemaname||tablename||policyname||coalesce(qual,'')||coalesce(with_check,''),'|'
   order by schemaname,tablename,policyname)) from pg_policies
   where schemaname in ('public','storage')) as policy_md5,                              -- d3f120da...
 (select md5(string_agg(n.nspname||p.proname||md5(pg_get_functiondef(p.oid)),'|'
   order by n.nspname,p.proname,p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname in ('public','private') and p.prokind='f') as function_md5;           -- 40c4139e...

-- B. RLS enabled on every ai_control table (expect 8 rows, all true)
select c.relname, c.relrowsecurity from pg_class c
join pg_namespace n on n.oid=c.relnamespace
where n.nspname='ai_control' and c.relkind='r' order by 1;

-- C. anon must have NO privileges on ai_control (expect 0 rows)
select table_name, privilege_type from information_schema.role_table_grants
where table_schema='ai_control' and grantee in ('anon','PUBLIC');

-- D. authenticated must have no DELETE/TRUNCATE (expect 0 rows)
select table_name, privilege_type from information_schema.role_table_grants
where table_schema='ai_control' and grantee='authenticated'
  and privilege_type in ('DELETE','TRUNCATE');

-- E. Policies present
select tablename, policyname, cmd from pg_policies where schemaname='ai_control' order by 1,2;

-- F. Supabase security advisor should show no new ai_control findings (run get_advisors).
