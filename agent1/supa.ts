import type { Config } from './config.js'
import { AgentError, jfetch } from './util.js'
import { assertReadOnlySql, type PolicyRow, type TableRow } from './checks.js'

const SCHEMAS = "('public','ai_control','storage','private')"
const priv = (role: string, p: string) => `pg_catalog.has_table_privilege('${role}', c.oid, '${p}')`

export const Q = {
  counts: `select n.nspname as schema, (count(*) filter (where c.relkind in ('r','p')))::int as tables, (count(*) filter (where c.relkind = 'v'))::int as views from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg\\_%' group by 1 order by 1`,
  functions: `select n.nspname as schema, count(*)::int as functions from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','private','ai_control') group by 1 order by 1`,
  tables: `select n.nspname as schema, c.relname as tbl, c.relrowsecurity as rls, c.relforcerowsecurity as rls_forced, ${priv('anon', 'SELECT')} as anon_select, ${priv('anon', 'INSERT')} as anon_insert, ${priv('anon', 'UPDATE')} as anon_update, ${priv('anon', 'DELETE')} as anon_delete, ${priv('anon', 'TRUNCATE')} as anon_truncate, ${priv('authenticated', 'SELECT')} as auth_select, ${priv('authenticated', 'INSERT')} as auth_insert, ${priv('authenticated', 'UPDATE')} as auth_update, ${priv('authenticated', 'DELETE')} as auth_delete, ${priv('authenticated', 'TRUNCATE')} as auth_truncate from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','p') and n.nspname in ${SCHEMAS} order by 1, 2`,
  policies: `select schemaname as schema, tablename as tbl, policyname as policy, cmd, roles::text as roles, left(coalesce(qual, ''), 300) as using_expr, left(coalesce(with_check, ''), 300) as check_expr from pg_catalog.pg_policies where schemaname in ${SCHEMAS} order by 1, 2, 3`,
  columns: (schema: string) => `select table_name, column_name, data_type, is_nullable from information_schema.columns where table_schema = '${schema}' order by table_name, ordinal_position`
}

export const SCHEMA_ALLOW = ['ai_control', 'public', 'private', 'storage']

export class SupaMgmt {
  constructor(private cfg: Config, private calls: Record<string, number>) {}

  // The ONLY database path Agent 1 has: Supabase's read-only query endpoint + static SQL guard.
  async roQuery<T = any>(sql: string): Promise<T[]> {
    if (!this.cfg.supaToken || !this.cfg.supabaseRef) throw new AgentError('AGENT1_SUPABASE_ACCESS_TOKEN (and project ref) not set', 503, 'not_configured')
    try { assertReadOnlySql(sql) } catch (e) { throw new AgentError('Blocked SQL: ' + (e as Error).message, 400, 'sql_blocked') }
    this.calls.supabase_mgmt = (this.calls.supabase_mgmt || 0) + 1
    const r = await jfetch(`https://api.supabase.com/v1/projects/${this.cfg.supabaseRef}/database/query/read-only`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this.cfg.supaToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql })
    }, 20000)
    if (r.status === 401 || r.status === 403) throw new AgentError('Supabase access token invalid or lacks Database read (' + r.status + ')', 502, 'supa_auth')
    if (!r.ok) throw new AgentError('Supabase Management API ' + r.status, 502, 'supa')
    return Array.isArray(r.body) ? r.body : []
  }

  // Write path. Used ONLY by apply_db_change, after approval + classifyExecutableSql. Wrapped in one transaction pinned to ai_control.
  async rwExec(sql: string): Promise<any[]> {
    if (!this.cfg.supaToken || !this.cfg.supabaseRef) throw new AgentError('AGENT1_SUPABASE_ACCESS_TOKEN (and project ref) not set', 503, 'not_configured')
    const body = sql.trim().replace(/;\s*$/, '')
    const wrapped = `BEGIN; SET LOCAL search_path = ai_control, pg_catalog; SET LOCAL statement_timeout = '15s'; ${body}; COMMIT;`
    this.calls.supabase_mgmt = (this.calls.supabase_mgmt || 0) + 1
    const r = await jfetch(`https://api.supabase.com/v1/projects/${this.cfg.supabaseRef}/database/query`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this.cfg.supaToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: wrapped })
    }, 30000)
    if (r.status === 401 || r.status === 403) throw new AgentError('Supabase access token invalid or lacks Database write (' + r.status + ')', 502, 'supa_auth')
    if (!r.ok) throw new AgentError('SQL failed (Supabase ' + r.status + '): ' + String(r.body && (r.body.message || r.body.error) || 'error').slice(0, 300), 502, 'sql_failed')
    return Array.isArray(r.body) ? r.body : []
  }

  tables() { return this.roQuery<TableRow>(Q.tables) }
  policies() { return this.roQuery<PolicyRow>(Q.policies) }
}

// Proves the anon key cannot read ai_control tables.
export async function probeAnon(cfg: Config, calls: Record<string, number>, tables: string[]) {
  const res: { table: string; status: number; verdict: 'blocked' | 'empty' | 'LEAK' }[] = []
  if (!cfg.anonKey) return res
  for (const t of tables) {
    calls.supabase_rest = (calls.supabase_rest || 0) + 1
    const r = await jfetch(`${cfg.supabaseUrl}/rest/v1/${t}?select=*&limit=1`, { headers: { apikey: cfg.anonKey, Authorization: 'Bearer ' + cfg.anonKey, 'Accept-Profile': 'ai_control' } })
    const rows = Array.isArray(r.body) ? r.body.length : 0
    res.push({ table: t, status: r.status, verdict: rows > 0 ? 'LEAK' : r.ok ? 'empty' : 'blocked' })
  }
  return res
}
