export type Sev = 'critical' | 'error' | 'warn' | 'info'
export interface Issue { severity: Sev; area: 'vercel' | 'supabase' | 'github' | 'config' | 'agent'; message: string; target?: string }
export interface EnvItem { id?: string; key: string; type: string; targets: string[] }
export interface DeployItem { id: string; state: string; target: string; createdAt: number; error?: string | null; branch?: string | null }

export const PUBLIC_PREFIX = /^(VITE_|NEXT_PUBLIC_|REACT_APP_|PUBLIC_|EXPO_PUBLIC_|NUXT_PUBLIC_)/
const HARD_SECRET = /(SERVICE_ROLE|SECRET|PRIVATE|PASSWORD|TOKEN|GEMINI|OPENAI|ANTHROPIC|CREDENTIAL)/i
const SOFT_SECRET = /API_KEY/i
export const SENSITIVE_NAME = /(ledger|payout|payment|billing|wallet|invoice|audit|secret|credential)/i

export function analyzeProject(name: string, deployments: DeployItem[] | null, env: EnvItem[] | null, required: string[] = [], now = Date.now()): Issue[] {
  const out: Issue[] = []
  const add = (severity: Sev, message: string) => out.push({ severity, area: 'vercel', message, target: name })

  if (deployments) {
    const prod = deployments.filter(d => d.target === 'production')
    if (prod.length && prod[0].state === 'ERROR') add('error', 'Latest production deployment failed' + (prod[0].error ? ': ' + prod[0].error : ''))
    if (!prod.length) add('info', 'No production deployment found in recent history')
    const last5 = deployments.slice(0, 5)
    if (last5.length >= 3 && last5.filter(d => d.state === 'ERROR').length >= 3) add('warn', 'Repeated deployment failures (3+ of last ' + last5.length + ')')
    for (const d of deployments) {
      if (['BUILDING', 'QUEUED', 'INITIALIZING'].includes(d.state) && now - d.createdAt > 15 * 60000) add('warn', 'Deployment ' + d.id + ' stuck in ' + d.state + ' for over 15 minutes')
    }
  }

  if (env) {
    for (const e of env) {
      if (PUBLIC_PREFIX.test(e.key)) {
        if (HARD_SECRET.test(e.key)) add('critical', e.key + ' looks like a secret but has a browser-public prefix (it ships to every visitor)')
        else if (SOFT_SECRET.test(e.key)) add('warn', e.key + ' is browser-public; confirm it is meant to be public')
      } else if (HARD_SECRET.test(e.key) && e.type === 'plain') {
        add('warn', e.key + ' is stored as plain text; use type encrypted/sensitive')
      }
    }
    for (const key of required) {
      const hits = env.filter(e => e.key === key)
      if (!hits.length) add('error', 'Required env var missing: ' + key)
      else {
        if (!hits.some(h => h.targets.includes('production'))) add('error', key + ' is not set for Production')
        if (!hits.some(h => h.targets.includes('preview'))) add('warn', key + ' is not set for Preview')
      }
    }
  }
  return out
}

export interface TableRow {
  schema: string; tbl: string; rls: boolean; rls_forced?: boolean
  anon_select: boolean; anon_insert: boolean; anon_update: boolean; anon_delete: boolean; anon_truncate?: boolean
  auth_select: boolean; auth_insert: boolean; auth_update: boolean; auth_delete: boolean; auth_truncate?: boolean
}
export interface PolicyRow { schema: string; tbl: string; policy: string; cmd: string; roles: string; using_expr: string; check_expr: string }

export function analyzeRls(tables: TableRow[], policies: PolicyRow[]): Issue[] {
  const out: Issue[] = []
  const add = (severity: Sev, message: string, target: string) => out.push({ severity, area: 'supabase', message, target })
  const polCount = new Map<string, number>()
  const anonPol = new Map<string, { write: boolean; read: boolean }>()
  for (const p of policies) {
    const id = p.schema + '.' + p.tbl
    polCount.set(id, (polCount.get(id) || 0) + 1)
    if (/(anon|public)/.test(p.roles)) {
      const a = anonPol.get(id) || { write: false, read: false }
      if (['ALL', 'INSERT', 'UPDATE', 'DELETE'].includes(p.cmd)) a.write = true
      if (['ALL', 'SELECT'].includes(p.cmd)) a.read = true
      anonPol.set(id, a)
    }
  }
  const denyAll: string[] = []

  for (const t of tables) {
    const id = t.schema + '.' + t.tbl
    const sens = SENSITIVE_NAME.test(t.tbl)
    const ap = anonPol.get(id) || { write: false, read: false }
    if (!t.rls && t.schema !== 'storage') {
      add(t.schema === 'ai_control' || sens ? 'critical' : t.schema === 'public' ? 'error' : 'warn', 'RLS is disabled', id)
    }
    const anonAny = t.anon_select || t.anon_insert || t.anon_update || t.anon_delete || !!t.anon_truncate
    if (t.schema === 'ai_control' && anonAny) add('critical', 'anon role has privileges on an ai_control table', id)
    if (t.schema === 'ai_control' && (t.auth_delete || t.auth_truncate)) add('error', 'authenticated role can delete/truncate (Phase 1 design grants none)', id)
    if (t.schema !== 'ai_control' && t.schema !== 'storage') {
      const live = !t.rls || ap.write // anon writes can actually succeed
      if (t.anon_insert || t.anon_update || t.anon_delete || t.anon_truncate) {
        if (live) add(sens ? 'critical' : 'error', 'anon role has write privileges AND no RLS barrier (writes can succeed)', id)
        else add('warn', 'anon has write GRANT but RLS currently blocks it (defense-in-depth only; check the app before revoking)', id)
      } else if (t.anon_select && sens) {
        if (!t.rls || ap.read) add('error', 'anon role can read a sensitive table', id)
        else add('warn', 'anon has SELECT GRANT on a sensitive table but RLS blocks it (defense-in-depth only)', id)
      }
      if (t.auth_truncate && sens) add('warn', 'authenticated role has TRUNCATE on a sensitive table', id)
    }
    if (t.rls && !polCount.get(id)) denyAll.push(id)
  }
  if (denyAll.length) out.push({ severity: 'info', area: 'supabase', target: denyAll.length + ' tables', message: 'RLS on with no policies = deny-all (normal for server-only tables): ' + denyAll.join(', ').slice(0, 700) })

  for (const p of policies) {
    const id = p.schema + '.' + p.tbl + ' / ' + p.policy
    const open = /^\(?\s*true\s*\)?$/i.test(p.using_expr.trim()) || /^\(?\s*true\s*\)?$/i.test(p.check_expr.trim())
    const pub = /(anon|public)/.test(p.roles)
    const write = ['ALL', 'INSERT', 'UPDATE', 'DELETE'].includes(p.cmd)
    if (open && pub && write) add('critical', `Policy allows anonymous/public ${p.cmd} with no condition (fine only if intentional, e.g. a public signup form; add rate limits)`, id)
    else if (open && pub && SENSITIVE_NAME.test(p.tbl)) add('error', 'Policy exposes a sensitive table to anon/public with no condition', id)
    if (p.schema === 'ai_control' && p.policy !== 'owners_select_self' && !/is_owner/.test(p.using_expr + p.check_expr)) {
      add('error', 'ai_control policy does not use is_owner()', id)
    }
  }
  return out
}

const RANK: Record<Sev, number> = { critical: 0, error: 1, warn: 2, info: 3 }
export function sortIssues(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => RANK[a.severity] - RANK[b.severity])
}

export function countIssues(issues: Issue[]) {
  const c = { critical: 0, error: 0, warn: 0, info: 0 }
  for (const i of issues) c[i.severity]++
  return c
}

export function overall(issues: Issue[]): 'healthy' | 'attention' | 'critical' {
  const c = countIssues(issues)
  return c.critical ? 'critical' : c.error || c.warn ? 'attention' : 'healthy'
}

// Static guard for SQL Agent 1 may run. Used by the read-only Supabase client.
const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do|vacuum|reindex|cluster|refresh|comment|lock|listen|notify|set|reset|execute|prepare|merge|import|into)\b/i
export function assertReadOnlySql(sql: string): void {
  const s = sql.trim().replace(/;\s*$/, '')
  if (/--|\/\*/.test(s)) throw new Error('SQL comments are not allowed')
  if (s.includes(';')) throw new Error('Multiple statements are not allowed')
  if (!/^(select|with)\b/i.test(s)) throw new Error('Only SELECT/WITH queries are allowed')
  const noStrings = s.replace(/'([^']|'')*'/g, "''")
  if (FORBIDDEN.test(noStrings)) throw new Error('Query contains a forbidden keyword')
}

// Classifier for DB change proposals (Agent 1 never executes them).
export function classifyDbChange(sql: string): { ok: boolean; reason?: string } {
  if (!sql.trim() || sql.length > 4000) return { ok: false, reason: 'SQL must be 1-4000 characters' }
  if (!/\bai_control\./i.test(sql)) return { ok: false, reason: 'Only ai_control schema changes can be proposed' }
  if (/\b(public|private|auth|storage|extensions|vault|cron|realtime)\s*\./i.test(sql)) return { ok: false, reason: 'References a protected schema (public/private/auth/storage...)' }
  if (/(ledger|payout|billing|payment|wallet|invoice)/i.test(sql)) return { ok: false, reason: 'Touches billing/payout/ledger objects' }
  if (/\b(drop\s+schema|truncate)\b/i.test(sql)) return { ok: false, reason: 'DROP SCHEMA / TRUNCATE are not allowed' }
  return { ok: true }
}
