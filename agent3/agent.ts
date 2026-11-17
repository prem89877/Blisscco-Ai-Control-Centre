import { loadConfig, readiness, secretValues, type Config } from './config.js'
import { AgentError, clip, errMsg, probe, jfetch, redact, type Probe } from './util.js'
import { Store } from './store.js'
import { GitHub } from './github.js'
import { summarize, planCommand, type AiResult } from './gemini.js'
import { assertAuthorizedTarget, assertBillingSafe, assertReadOnlySql, isBillingRisk, validPath, validRepo, scanSecrets } from './guard.js'
import * as C from './checks.js'
import { parseCommand, runOne, runLocal, ensureProject, realExec, PRESET_IDS, ALLOWED_HELP, type ExecFn } from './local.js'
import type { Finding } from './checks.js'

export interface Actor { type: 'user' | 'system'; id: string | null }
export interface Ctx { cfg: Config; store: Store; actor: Actor; calls: Record<string, number>; adopt?: string; worker?: boolean; exec?: ExecFn }
export const ACTIONS = ['heartbeat', 'website_smoke', 'auth_check', 'api_test', 'db_test', 'security_scan', 'full_report', 'request_rate_test', 'apply_rate_test', 'retest', 'ai_command', 'queue_task', 'queue_local', 'request_local_command', 'queue_local_command', 'local_check', 'local_command'] as const
export type Action = typeof ACTIONS[number]
export function makeCtx(cfg: Config, actor: Actor): Ctx { return { cfg, store: new Store(cfg), actor, calls: {} } }
export const now = () => new Date().toISOString()
export interface Out { result: any; status?: 'succeeded' | 'awaiting_approval' }
export interface Ev { check: string; ok: boolean; detail: string }
const bump = (ctx: Ctx, k: string, n = 1) => { ctx.calls[k] = (ctx.calls[k] || 0) + n }

export async function withTask(ctx: Ctx, action: string, title: string, payload: Record<string, unknown>, fn: (taskId: string) => Promise<Out>) {
  const secrets = secretValues(ctx.cfg)
  await ctx.store.ensureAgent()
  await ctx.store.setStatus('running')
  // A task queued from the dashboard and claimed by the Termux worker is reused (no duplicate task row).
  const adopted = ctx.adopt; ctx.adopt = undefined
  const task = adopted ? { id: adopted } : await ctx.store.createTask({ title, description: 'Agent 3 - ' + action, status: 'running', payload: { action, ...payload }, created_by: ctx.actor.id, started_at: now() })
  await ctx.store.log('info', `agent3_${action}_start`, title, {}, task.id, ctx.actor.id)
  try {
    const out = await fn(task.id)
    const status = out.status || 'succeeded'
    const result = clip(redact(out.result, secrets))
    await ctx.store.updateTask(task.id, { status, result, finished_at: status === 'succeeded' ? now() : null })
    for (const [provider, n] of Object.entries(ctx.calls)) if (n > 0) await ctx.store.usage({ provider, endpoint: action, request_count: n })
    ctx.calls = {}
    await ctx.store.log(status === 'succeeded' ? 'success' : 'info', `agent3_${action}_${status}`, title, {}, task.id, ctx.actor.id)
    await ctx.store.setStatus('idle')
    return { task_id: task.id, status, result }
  } catch (e) {
    const msg = redact(errMsg(e), secrets) as string
    await ctx.store.updateTask(task.id, { status: 'failed', error_message: msg, finished_at: now() }).catch(() => {})
    await ctx.store.log('error', `agent3_${action}_failed`, msg, {}, task.id, ctx.actor.id)
    await ctx.store.setStatus('error').catch(() => {})
    const err = e instanceof AgentError ? e : new AgentError(msg, 500, 'internal')
    err.message = msg
    err.taskId = task.id
    throw err
  }
}

export async function recordAi(ctx: Ctx, endpoint: string, r: AiResult) {
  const cost = (r.tokensIn * ctx.cfg.priceIn + r.tokensOut * ctx.cfg.priceOut) / 1_000_000
  await ctx.store.usage({ provider: 'gemini', model: r.model, endpoint, tokens_in: r.tokensIn, tokens_out: r.tokensOut, status_code: r.status || null, cost_estimate: cost })
}

// ---------------------------------------------------------------- shared helpers
// Every HTTP call to a target goes through here: authorized origin, GET/HEAD/OPTIONS/POST only, counted for api_usage.
async function hit(ctx: Ctx, origin: string, path: string, init: RequestInit = {}): Promise<Probe> {
  const [base, ...q] = path.split('?')
  validPath(base)
  if (q.join('?').length > 6000 || /[\s\\\0]/.test(q.join('?'))) throw new AgentError('Bad query string', 400, 'bad_path')
  bump(ctx, 'target_http')
  return probe(origin + path, { ...init, headers: { 'User-Agent': 'BlisccoQA/1.0 (+read-only test)', ...(init.headers as any) } })
}
const report = (title: string, findings: Finding[], evidence: Ev[], extra: Record<string, unknown> = {}) => {
  const sorted = C.sortFindings(findings)
  return { title, verdict: C.verdict(sorted), counts: C.countFindings(sorted), findings: sorted, evidence, tests_run: evidence.length, tests_passed: evidence.filter(e => e.ok).length, generated_at: now(), ...extra }
}
const need = (cond: unknown, msg: string) => { if (!cond) throw new AgentError(msg, 503, 'not_configured') }
const pickTarget = (ctx: Ctx, p: any) => assertAuthorizedTarget(ctx.cfg.targets, p.target || ctx.cfg.targets[0])

// ---------------------------------------------------------------- 1. website smoke + mobile
async function websiteChecks(ctx: Ctx, origin: string) {
  const f: Finding[] = [], ev: Ev[] = []
  for (const path of ctx.cfg.webPaths) {
    const p = await hit(ctx, origin, path)
    const found = C.analyzePage(path, p)
    f.push(...found)
    ev.push({ check: 'GET ' + path, ok: p.status > 0 && p.status < 400 && !found.some(x => x.severity === 'critical' || x.severity === 'high'), detail: `HTTP ${p.status} ${p.ms}ms ${p.headers['content-type'] || ''}`.trim() })
  }
  const home = await hit(ctx, origin, '/')
  const mobile = await hit(ctx, origin, '/', { headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36' } })
  ev.push({ check: 'Mobile user-agent GET /', ok: mobile.status > 0 && mobile.status < 400, detail: `HTTP ${mobile.status} ${mobile.ms}ms` })
  const robots = await hit(ctx, origin, '/robots.txt'); ev.push({ check: 'robots.txt', ok: robots.status === 200, detail: 'HTTP ' + robots.status })
  const bad = await hit(ctx, origin, '/__qa_not_found_' + Date.now())
  ev.push({ check: 'Unknown route handled', ok: bad.status > 0 && bad.status < 500, detail: 'HTTP ' + bad.status })
  if (bad.status >= 500) f.push({ id: 'web.404_crash', area: 'website', severity: 'high', title: 'Unknown URL crashes the server', evidence: 'HTTP ' + bad.status, fix: 'Return a 404 page.', target: '/__qa_not_found' })
  return { f, ev, home }
}
async function websiteSmoke(ctx: Ctx, p: any): Promise<Out> {
  const origin = pickTarget(ctx, p)
  return withTask(ctx, 'website_smoke', 'Website smoke test ' + origin, { target: origin }, async () => {
    const { f, ev } = await websiteChecks(ctx, origin)
    return { result: report('Website smoke + mobile', f, ev, { target: origin, note: 'Pixel-level mobile and click-through tests run in Playwright (GitHub Actions: QA workflow).' }) }
  })
}

// ---------------------------------------------------------------- 2. login / auth / role pages
async function authChecks(ctx: Ctx, origin: string) {
  const f: Finding[] = [], ev: Ev[] = []
  const login = await hit(ctx, origin, '/login')
  const home = await hit(ctx, origin, '/')
  const hasLogin = (login.status === 200 && /(password|sign in|log in)/i.test(login.text)) || /(password|sign in|log in)/i.test(home.text)
  ev.push({ check: 'Login page reachable', ok: hasLogin, detail: `/login HTTP ${login.status}` })
  if (!hasLogin) f.push({ id: 'auth.no_login', area: 'auth', severity: 'low', title: 'Login form not detected in HTML', evidence: 'No login wording in / or /login HTML (may be rendered by JavaScript)', fix: 'Confirm with the Playwright login test.', target: '/login' })
  if (!ctx.cfg.protectedPaths.length) f.push({ id: 'auth.no_paths', area: 'auth', severity: 'info', title: 'No protected paths configured', evidence: 'AGENT3_PROTECTED_PATHS is empty', fix: 'Set e.g. /admin,/advertiser,/publisher,/dashboard to test advertiser, publisher and admin areas.' })
  for (const path of ctx.cfg.protectedPaths) {
    const p = await hit(ctx, origin, path)
    const found = C.analyzeProtected(path, p)
    f.push(...found)
    ev.push({ check: 'Anonymous GET ' + path, ok: !found.some(x => ['critical', 'high', 'medium'].includes(x.severity)), detail: `HTTP ${p.status}${p.redirected ? ' -> ' + p.redirected.slice(0, 80) : ''}` })
  }
  return { f, ev }
}
async function authCheck(ctx: Ctx, p: any): Promise<Out> {
  const origin = pickTarget(ctx, p)
  return withTask(ctx, 'auth_check', 'Auth & role pages ' + origin, { target: origin }, async () => {
    const { f, ev } = await authChecks(ctx, origin)
    return { result: report('Login, advertiser, publisher, admin access', f, ev, { target: origin, note: 'Logged-in flows are covered by the Playwright suite (e2e/), which uses test accounts you provide in GitHub secrets.' }) }
  })
}

// ---------------------------------------------------------------- 3. API tests
export async function apiChecks(ctx: Ctx, origin: string) {
  const f: Finding[] = [], ev: Ev[] = []
  if (!ctx.cfg.endpoints.length) { f.push({ id: 'api.no_endpoints', area: 'api', severity: 'info', title: 'No API endpoints configured', evidence: 'AGENT3_API_ENDPOINTS is empty', fix: 'Set JSON like [{"name":"serve","path":"/api/serve","method":"GET","auth":"key","billing_risk":true}]' }); return { f, ev } }
  const run = async (e: C.ApiCase['kind'], ep: any, init: RequestInit, mode: 'negative' | 'positive', path = ep.path) => {
    assertBillingSafe(ep.path, mode, ctx.cfg.nonBillablePaths)
    const pr = await hit(ctx, origin, path, init)
    const found = C.analyzeApiCase({ name: ep.name || ep.path, path: ep.path, kind: e, probe: pr })
    f.push(...found)
    ev.push({ check: `${ep.method} ${ep.path} [${e}]`, ok: !found.some(x => ['critical', 'high', 'medium'].includes(x.severity)), detail: `HTTP ${pr.status} ${pr.ms}ms` })
  }
  for (const ep of ctx.cfg.endpoints) {
    validPath(ep.path)
    const method = ep.method === 'POST' ? 'POST' : 'GET'
    const body = method === 'POST' ? { body: '{}', headers: { 'content-type': 'application/json' } } : {}
    const billing = Boolean(ep.billing_risk) || isBillingRisk(ep.path)
    if (ep.auth !== 'none') {
      await run('no_key', ep, { method, ...body }, 'negative')
      await run('invalid_key', ep, { method, headers: { ...(body as any).headers, 'x-api-key': 'invalid_qa_key_000000', authorization: 'Bearer invalid.qa.token' }, ...(method === 'POST' ? { body: '{}' } : {}) }, 'negative')
    }
    // malformed input: sent WITHOUT credentials, so it can never create a billable event
    if (method === 'POST') await run('malformed', ep, { method, headers: { 'content-type': 'application/json' }, body: '{"broken":' }, 'negative')
    else await run('malformed', ep, { method }, 'negative', ep.path + (ep.path.includes('?') ? '&' : '?') + 'id=%00%27%22&limit=-1')
    await run('wrong_method', ep, { method: method === 'GET' ? 'POST' : 'GET', ...(method === 'GET' ? { body: '{}', headers: { 'content-type': 'application/json' } } : {}) }, 'negative')
    // valid key: only on endpoints that cannot bill, only when the owner provided a test key
    if (ep.auth === 'key' && ctx.cfg.testApiKey && (!billing || ctx.cfg.nonBillablePaths.includes(ep.path))) {
      await run('valid_key', ep, { method, headers: { 'x-api-key': ctx.cfg.testApiKey, ...(body as any).headers }, ...(method === 'POST' ? { body: '{}' } : {}) }, 'positive')
    } else if (ep.auth === 'key') {
      ev.push({ check: `${ep.method} ${ep.path} [valid_key]`, ok: true, detail: billing ? 'SKIPPED on purpose: billing-risk endpoint (never called with a valid key)' : 'SKIPPED: AGENT3_TEST_API_KEY not set' })
    }
  }
  // CORS preflight on first endpoint
  const first = ctx.cfg.endpoints[0]
  const pre = await hit(ctx, origin, first.path, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } })
  const acao = pre.headers['access-control-allow-origin']
  ev.push({ check: 'CORS preflight from foreign origin', ok: acao !== '*' && acao !== 'https://evil.example', detail: 'ACAO: ' + (acao || 'none') })
  if (acao === 'https://evil.example') f.push({ id: 'sec.cors.reflect', area: 'security', severity: 'high', title: 'CORS reflects any Origin', evidence: 'ACAO echoed https://evil.example', fix: 'Allow-list origins.', target: first.path })
  return { f, ev }
}
async function apiTest(ctx: Ctx, p: any): Promise<Out> {
  const origin = pickTarget(ctx, p)
  return withTask(ctx, 'api_test', 'API tests ' + origin, { target: origin }, async () => {
    const { f, ev } = await apiChecks(ctx, origin)
    return { result: report('API: auth, invalid key, validation, errors', f, ev, { target: origin, billing_safety: 'No credentialed call was made to any billing-risk endpoint. Ad-serve responses are never treated as billable impressions.' }) }
  })
}

// ---------------------------------------------------------------- 4. rate-limit test (approval + production ack)
async function requestRateTest(ctx: Ctx, p: any): Promise<Out> {
  const origin = pickTarget(ctx, p)
  const path = validPath(p.path)
  const n = Math.min(Math.max(Number(p.requests) || 25, 10), 30)
  return withTask(ctx, 'request_rate_test', 'Rate-limit test ' + path, { target: origin, path, requests: n }, async taskId => {
    const details = { kind: 'rate_test', target: origin, path, requests: n, production: true, note: `Sends ${n} rapid anonymous GET requests (no credentials, so nothing can be billed) to ${origin}${path}. It may briefly trigger your own rate limiter.` }
    const ap = await ctx.store.createApproval({ task_id: taskId, title: `Rate-limit test: ${path} x${n}`, details })
    await ctx.store.log('warn', 'agent3_approval_requested', ap.id, { approval_id: ap.id }, taskId, ctx.actor.id)
    return { status: 'awaiting_approval', result: { approval_id: ap.id, next: 'Approve in the Approvals tab, then press Run rate test in the Agent 3 console.' } }
  })
}
async function applyRateTest(ctx: Ctx, p: any): Promise<Out> {
  const ap = await ctx.store.getApproval(String(p.approval_id || ''))
  const d = ap && ap.details
  if (!ap || !d || d.kind !== 'rate_test') throw new AgentError('Approval not found', 404, 'not_found')
  if (ap.status !== 'approved') throw new AgentError('Not approved yet (status: ' + ap.status + ')', 409, 'not_approved')
  if (d.executed_at) throw new AgentError('Already executed', 409, 'already_executed')
  if (!ap.decided_at || Date.now() - new Date(ap.decided_at).getTime() > 24 * 3600 * 1000) throw new AgentError('Approval older than 24h; request again', 409, 'expired')
  if (p.production_ack !== 'APPROVE-PRODUCTION') throw new AgentError('Needs explicit confirmation (production_ack)', 403, 'production_ack')
  const origin = assertAuthorizedTarget(ctx.cfg.targets, d.target)
  validPath(d.path)
  return withTask(ctx, 'apply_rate_test', 'Rate test ' + d.path, { approval_id: ap.id }, async () => {
    const claimed = await ctx.store.claimApproval(ap.id, { ...d, executed_at: now(), executed_by: ctx.actor.id })
    if (!claimed) throw new AgentError('Already executed', 409, 'already_executed')
    const statuses: Record<string, number> = {}
    let first429: number | null = null, retry = false, has5xx = false, sent = 0
    const batch = 5
    for (let i = 0; i < d.requests; i += batch) {
      const rs = await Promise.all(Array.from({ length: Math.min(batch, d.requests - i) }, () => hit(ctx, origin, d.path)))
      for (const r of rs) {
        sent++
        statuses[r.status] = (statuses[r.status] || 0) + 1
        if (r.status === 429) { if (first429 == null) first429 = sent; if (r.headers['retry-after']) retry = true }
        if (r.status >= 500) has5xx = true
      }
    }
    const f = C.analyzeRate(d.path, { total: sent, statuses, first429, hasRetryAfter: retry, has5xx })
    return { result: report('Rate-limit test', f, [{ check: `${sent} rapid anonymous GETs`, ok: first429 != null && !has5xx, detail: JSON.stringify(statuses) }], { target: origin }) }
  })
}

// ---------------------------------------------------------------- 5. database
export async function dbChecks(ctx: Ctx) {
  const f: Finding[] = [], ev: Ev[] = []
  const cfg = ctx.cfg
  // connectivity
  if (cfg.anonKey) {
    bump(ctx, 'supabase_rest')
    const rest = await probe(cfg.supabaseUrl + '/rest/v1/', { headers: { apikey: cfg.anonKey, Authorization: 'Bearer ' + cfg.anonKey } })
    ev.push({ check: 'Supabase REST reachable', ok: rest.status > 0 && rest.status < 500, detail: `HTTP ${rest.status} ${rest.ms}ms` })
    if (rest.status === 0 || rest.status >= 500) f.push({ id: 'db.unreachable', area: 'database', severity: 'critical', title: 'Supabase REST not reachable', evidence: rest.error || 'HTTP ' + rest.status, fix: 'Check Supabase project status.' })
    bump(ctx, 'supabase_rest')
    const auth = await probe(cfg.supabaseUrl + '/auth/v1/health', { headers: { apikey: cfg.anonKey } })
    ev.push({ check: 'Supabase Auth health', ok: auth.status === 200, detail: `HTTP ${auth.status} ${auth.ms}ms` })
    if (auth.status !== 200) f.push({ id: 'db.auth_down', area: 'database', severity: 'high', title: 'Supabase Auth health check failed', evidence: 'HTTP ' + auth.status, fix: 'Check Supabase Auth status.' })
  } else ev.push({ check: 'Supabase connectivity', ok: false, detail: 'SKIPPED: anon key (VITE_SUPABASE_ANON_KEY) not set' })

  if (!cfg.supaToken || !cfg.supabaseRef) {
    ev.push({ check: 'RLS / schema / permissions / billing integrity', ok: false, detail: 'SKIPPED: AGENT3_SUPABASE_ACCESS_TOKEN not set (read-only Database scope)' })
    f.push({ id: 'db.no_mgmt', area: 'database', severity: 'info', title: 'Deep database checks not run', evidence: 'No Supabase access token for Agent 3', fix: 'Add AGENT3_SUPABASE_ACCESS_TOKEN (Database READ only).' })
    return { f, ev }
  }
  const ro = async <T,>(sql: string): Promise<T[]> => {
    try { assertReadOnlySql(sql) } catch (e) { throw new AgentError('Blocked SQL: ' + (e as Error).message, 400, 'sql_blocked') }
    bump(ctx, 'supabase_mgmt')
    const r = await jfetch(`https://api.supabase.com/v1/projects/${cfg.supabaseRef}/database/query/read-only`, { method: 'POST', headers: { Authorization: 'Bearer ' + cfg.supaToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }) }, 20000)
    if ([401, 403].includes(r.status)) throw new AgentError('Supabase token invalid or lacks Database read (' + r.status + ')', 502, 'supa_auth')
    if (!r.ok) throw new AgentError('Supabase Management API ' + r.status, 502, 'supa')
    return Array.isArray(r.body) ? r.body : []
  }
  const SCH = "('public','ai_control','private')"
  const priv = (role: string, x: string) => `pg_catalog.has_table_privilege('${role}', c.oid, '${x}')`
  const tables = await ro<C.TableRow>(`select n.nspname as schema, c.relname as tbl, c.relrowsecurity as rls, ${priv('anon', 'SELECT')} as anon_select, ${priv('anon', 'INSERT')} as anon_insert, ${priv('anon', 'UPDATE')} as anon_update, ${priv('anon', 'DELETE')} as anon_delete, ${priv('authenticated', 'SELECT')} as auth_select, ${priv('authenticated', 'INSERT')} as auth_insert, ${priv('authenticated', 'UPDATE')} as auth_update, ${priv('authenticated', 'DELETE')} as auth_delete from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','p') and n.nspname in ${SCH} order by 1, 2`)
  const policies = await ro<C.PolicyRow>(`select schemaname as schema, tablename as tbl, policyname as policy, cmd, roles::text as roles, left(coalesce(qual, ''), 300) as using_expr, left(coalesce(with_check, ''), 300) as check_expr from pg_catalog.pg_policies where schemaname in ${SCH} order by 1, 2, 3`)
  ev.push({ check: 'Read catalog: tables, grants, policies', ok: true, detail: `${tables.length} tables, ${policies.length} policies` })
  const rls = C.analyzeDb(tables, policies)
  f.push(...rls)
  ev.push({ check: 'RLS + permissions + data isolation', ok: !rls.some(x => ['critical', 'high'].includes(x.severity)), detail: `${tables.filter(t => t.rls).length}/${tables.length} tables have RLS; ${rls.length} finding(s)` })
  const missing = C.analyzeSchema(C.EXPECTED_TABLES, tables)
  f.push(...missing)
  ev.push({ check: 'Schema consistency (Phase 1 tables)', ok: !missing.length, detail: missing.length ? missing.length + ' missing' : 'all ' + C.EXPECTED_TABLES.length + ' present' })
  const nopk = await ro<{ schema: string; tbl: string }>(`select n.nspname as schema, c.relname as tbl from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where c.relkind = 'r' and n.nspname in ${SCH} and not exists (select 1 from pg_catalog.pg_index i where i.indrelid = c.oid and i.indisprimary)`)
  for (const t of nopk) f.push({ id: 'schema.no_pk', area: 'database', severity: BILLING_T.test(t.tbl) ? 'high' : 'low', title: 'Table has no primary key', evidence: t.schema + '.' + t.tbl, fix: 'Add a primary key (required for safe updates and dedupe).', target: t.schema + '.' + t.tbl })
  ev.push({ check: 'Primary keys present', ok: !nopk.length, detail: nopk.length ? nopk.length + ' table(s) without PK' : 'all tables have PK' })

  // live anon probe (reads at most 1 row, only count is kept)
  if (cfg.anonKey) {
    const targets = tables.filter(t => t.schema === 'public' && t.anon_select).map(t => t.tbl).slice(0, 25)
    const probes: C.AnonProbe[] = []
    for (const t of targets) {
      bump(ctx, 'supabase_rest')
      const r = await jfetch(`${cfg.supabaseUrl}/rest/v1/${encodeURIComponent(t)}?select=*&limit=1`, { headers: { apikey: cfg.anonKey, Authorization: 'Bearer ' + cfg.anonKey } })
      probes.push({ table: t, status: r.status, rows: Array.isArray(r.body) ? r.body.length : 0 })
    }
    f.push(...C.analyzeAnonProbe(probes))
    ev.push({ check: 'Live anon-key read probe', ok: !probes.some(x => x.rows > 0), detail: `${probes.length} anon-readable table(s) probed, ${probes.filter(x => x.rows > 0).length} returned rows` })
  }

  // billing event integrity: aggregate counts only, no values leave the database
  const IDENT = /^[a-z_][a-z0-9_]*$/
  const billTables = tables.filter(t => t.schema === 'public' && BILLING_T.test(t.tbl) && IDENT.test(t.tbl)).slice(0, 8)
  const stats: C.BillingStats[] = []
  for (const t of billTables) {
    try {
      const cols = (await ro<{ column_name: string; data_type: string }>(`select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = '${t.tbl}'`)).filter(c => IDENT.test(c.column_name))
      const names = cols.map(c => c.column_name)
      const refs = names.filter(n => /^(advertiser_id|publisher_id|campaign_id|ad_id|user_id|owner_id)$/.test(n))
      const keyCol = names.find(n => /^(idempotency_key|event_id|request_id|external_id)$/.test(n))
      const amt = cols.filter(c => /^(amount|cost|revenue|earnings|price|total)$/.test(c.column_name) && /(numeric|integer|bigint|double|real|smallint)/.test(c.data_type)).map(c => c.column_name)
      const sel = [`count(*)::int as total`, refs.length ? `count(*) filter (where ${refs.map(r => `"${r}" is null`).join(' or ')})::int as nul` : `0 as nul`, keyCol ? `(count("${keyCol}") - count(distinct "${keyCol}"))::int as dup` : `0 as dup`, amt.length ? `count(*) filter (where ${amt.map(a => `"${a}" < 0`).join(' or ')})::int as neg` : `0 as neg`].join(', ')
      const r = (await ro<any>(`select ${sel} from public."${t.tbl}"`))[0] || {}
      stats.push({ table: 'public.' + t.tbl, total: r.total || 0, orphan_or_null: r.nul || 0, duplicates: r.dup || 0, negative: r.neg || 0 })
    } catch (e) { ev.push({ check: 'Billing integrity ' + t.tbl, ok: false, detail: 'SKIPPED: ' + errMsg(e).slice(0, 120) }) }
  }
  const bill = C.analyzeBilling(stats)
  f.push(...bill)
  ev.push({ check: 'Billing event integrity (read-only aggregates)', ok: !bill.length, detail: stats.length ? stats.map(s => `${s.table}:${s.total} rows`).join(', ') : 'no billing-named tables found in public schema' })
  return { f, ev }
}
const BILLING_T = C.BILLING_TABLE
async function dbTest(ctx: Ctx): Promise<Out> {
  return withTask(ctx, 'db_test', 'Database tests (read-only)', {}, async () => {
    const { f, ev } = await dbChecks(ctx)
    return { result: report('Database: connectivity, RLS, schema, permissions, billing integrity, isolation', f, ev, { billing_safety: 'Read-only catalog + aggregate queries. No rows written. No row values stored.' }) }
  })
}

// ---------------------------------------------------------------- 6. security
export const BUNDLE_LIMIT = 8
export async function securityChecks(ctx: Ctx, origin: string, repo?: string) {
  const f: Finding[] = [], ev: Ev[] = []
  // headers
  const home = await hit(ctx, origin, '/')
  const hf = C.analyzeHeaders(origin, home.headers)
  f.push(...hf)
  ev.push({ check: 'Security headers', ok: !hf.some(x => ['critical', 'high', 'medium'].includes(x.severity)), detail: hf.length + ' missing/weak' })
  // secret exposure in public JS
  const srcs = [...home.text.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]).filter(s => s.startsWith('/') && !s.startsWith('//')).slice(0, BUNDLE_LIMIT)
  let secretsFound = 0
  for (const s of srcs) {
    const r = await hit(ctx, origin, s.split('?')[0])
    const fs = C.analyzeBundleText(s, r.text)
    secretsFound += fs.length; f.push(...fs)
  }
  secretsFound += C.analyzeBundleText('/', home.text).map(x => (f.push(x), 1)).length
  ev.push({ check: 'Secret exposure in public HTML/JS', ok: secretsFound === 0, detail: `${srcs.length} script file(s) scanned, ${secretsFound} hit(s) (values never stored)` })
  // exposed sensitive files
  const exposed: string[] = []
  for (const path of ['/.env', '/.git/config', '/package.json', '/.env.local', '/supabase/config.toml']) {
    const r = await hit(ctx, origin, path)
    const looksReal = r.status === 200 && !/<!doctype html|<html/i.test(r.text.slice(0, 200)) && r.text.length > 0
    if (looksReal) { exposed.push(path); f.push({ id: 'sec.file_exposed', area: 'security', severity: path.startsWith('/.env') || path.startsWith('/.git') ? 'critical' : 'medium', title: 'Sensitive file publicly readable', evidence: path + ' returned HTTP 200 with non-HTML content', fix: 'Remove it from the public folder / deployment.', target: path }) }
  }
  ev.push({ check: 'Sensitive files not exposed (.env, .git, package.json)', ok: !exposed.length, detail: exposed.length ? exposed.join(', ') : '5 paths checked, none readable' })
  // authentication bypass: API without key
  const eps = ctx.cfg.endpoints.filter(e => e.auth !== 'none')
  let bypass = 0
  for (const ep of eps) { const r = await hit(ctx, origin, ep.path, { method: ep.method === 'POST' ? 'POST' : 'GET', ...(ep.method === 'POST' ? { body: '{}', headers: { 'content-type': 'application/json' } } : {}) }); if (r.status >= 200 && r.status < 300) { bypass++; f.push({ id: 'api.auth_bypass', area: 'security', severity: 'critical', title: 'Authentication bypass: protected endpoint answered without credentials', evidence: ep.path + ' HTTP ' + r.status, fix: 'Check the key BEFORE doing any work.', target: ep.path }) } }
  ev.push({ check: 'Authentication bypass (no credentials)', ok: bypass === 0, detail: `${eps.length} protected endpoint(s) tested, ${bypass} bypass` })
  // input validation: hostile strings in query params on GET, non-billing paths only, anonymous
  let inputIssues = 0, inputRuns = 0
  const getPaths = [...ctx.cfg.endpoints.filter(e => e.method !== 'POST').map(e => e.path), ...ctx.cfg.webPaths].filter(p => !isBillingRisk(p)).slice(0, 6)
  const jobs = getPaths.flatMap(path => C.PAYLOADS.map(pl => ({ path, pl })))
  for (let i = 0; i < jobs.length; i += 8) {
    const rs = await Promise.all(jobs.slice(i, i + 8).map(async ({ path, pl }) => ({ path, pl, r: await hit(ctx, origin, path + (path.includes('?') ? '&' : '?') + 'q=' + encodeURIComponent(pl.value)) })))
    for (const { path, pl, r } of rs) { inputRuns++; const fs = C.analyzeInputProbe(path, pl.name, pl.value, r); inputIssues += fs.length; f.push(...fs) }
  }
  ev.push({ check: 'Input validation (SQLi / XSS / traversal / long input, anonymous GET, non-billing paths)', ok: inputIssues === 0, detail: `${inputRuns} probe(s), ${inputIssues} issue(s). Billing-risk paths excluded.` })
  // repo: secrets + dependency vulnerabilities
  if (repo && ctx.cfg.githubToken) {
    const gh = new GitHub(ctx.cfg, ctx.calls)
    const rp = validRepo(repo)
    if (!gh.repoAllowed(rp)) throw new AgentError('Repo not in AGENT3_GITHUB_REPOS', 403, 'repo_not_allowed')
    const tree = await gh.tree(rp)
    const code = tree.filter(t => t.type === 'blob' && /\.(js|jsx|ts|tsx|json|md|yml|yaml|sql|html|toml)$/i.test(t.path) && !/(package-lock\.json|node_modules|\.min\.)/.test(t.path) && (t.size || 0) < 200_000).slice(0, 120)
    const envFiles = tree.filter(t => t.type === 'blob' && /(^|\/)\.env(\..+)?$/.test(t.path) && !/\.(example|sample|template)$/.test(t.path))
    for (const e of envFiles) f.push({ id: 'sec.env_committed', area: 'security', severity: 'critical', title: '.env file committed to the repository', evidence: e.path, fix: 'Remove it from git history, rotate every key inside, add to .gitignore.', target: e.path })
    let repoHits = 0
    for (let i = 0; i < code.length; i += 10) {
      const batch = await Promise.all(code.slice(i, i + 10).map(async t => ({ t, txt: await gh.file(rp, t.path) })))
      for (const { t, txt } of batch) {
        if (!txt) continue
        const hits = C.analyzeBundleText(t.path, txt)
        repoHits += hits.length; f.push(...hits.map(h => ({ ...h, evidence: h.evidence.replace('public file', 'repo') })))
      }
    }
    ev.push({ check: 'Secrets in repository (code, config, SQL)', ok: repoHits === 0 && !envFiles.length, detail: `${code.length} file(s) scanned, ${repoHits} hit(s), ${envFiles.length} committed .env` })
    const dep = await depAudit(ctx, gh, rp)
    f.push(...dep.f); ev.push(dep.ev)
  } else ev.push({ check: 'Repository secrets + dependency vulnerabilities', ok: false, detail: 'SKIPPED: pass a repo and set AGENT3_GITHUB_TOKEN / AGENT3_GITHUB_REPOS' })
  return { f, ev }
}

async function depAudit(ctx: Ctx, gh: GitHub, repo: string): Promise<{ f: Finding[]; ev: Ev }> {
  const pkgText = await gh.file(repo, 'package.json')
  if (!pkgText) return { f: [], ev: { check: 'Dependency vulnerabilities', ok: false, detail: 'SKIPPED: no package.json' } }
  const versions = new Map<string, Set<string>>()
  const add = (n: string, v: string) => { if (/^\d+\.\d+\.\d+/.test(v)) { if (!versions.has(n)) versions.set(n, new Set()); versions.get(n)!.add(v.split(/[-+]/)[0]) } }
  const lock = await gh.file(repo, 'package-lock.json', 3_000_000)
  let source = 'package-lock.json'
  if (lock) { try { for (const [k, v] of Object.entries((JSON.parse(lock).packages || {}) as Record<string, any>)) { const m = /node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(k); if (m && v.version) add(m[1], v.version) } } catch { /* fall through */ } }
  if (!versions.size) { source = 'package.json (ranges, approximate)'; const p = JSON.parse(pkgText); for (const [n, v] of Object.entries({ ...(p.dependencies || {}), ...(p.devDependencies || {}) })) add(n, String(v).replace(/^[\^~>=<\s]+/, '')) }
  const body: Record<string, string[]> = {}
  for (const [n, s] of [...versions.entries()].slice(0, 500)) body[n] = [...s]
  bump(ctx, 'npm_audit')
  const r = await jfetch('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 25000)
  if (!r.ok) return { f: [], ev: { check: 'Dependency vulnerabilities', ok: false, detail: 'SKIPPED: npm advisory service HTTP ' + r.status } }
  const f: Finding[] = []
  for (const [name, advs] of Object.entries((r.body || {}) as Record<string, any[]>)) for (const a of advs.slice(0, 3)) {
    const sev = ({ critical: 'critical', high: 'high', moderate: 'medium', low: 'low' } as Record<string, Finding['severity']>)[String(a.severity)] || 'low'
    f.push({ id: 'dep.vuln', area: 'security', severity: sev, title: `${name}: ${String(a.title || 'vulnerability').slice(0, 120)}`, evidence: `${name} ${[...(versions.get(name) || [])].join(',')} affected (${String(a.vulnerable_versions || '').slice(0, 60)})`, fix: 'Upgrade the package (npm audit fix / bump version). ' + String(a.url || ''), target: name })
  }
  return { f, ev: { check: 'Dependency vulnerabilities (npm advisories)', ok: !f.some(x => ['critical', 'high'].includes(x.severity)), detail: `${versions.size} package(s) from ${source}, ${f.length} advisory(ies)` } }
}
async function securityScan(ctx: Ctx, p: any): Promise<Out> {
  const origin = pickTarget(ctx, p)
  return withTask(ctx, 'security_scan', 'Security scan ' + origin, { target: origin, repo: p.repo || null }, async () => {
    const { f, ev } = await securityChecks(ctx, origin, p.repo ? String(p.repo) : ctx.cfg.githubRepos[0])
    return { result: report('Security: secrets, auth bypass, headers, input validation, dependencies', f, ev, { target: origin }) }
  })
}

// ---------------------------------------------------------------- full report (+ AI summary)
async function fullReport(ctx: Ctx, p: any): Promise<Out> {
  const origin = pickTarget(ctx, p)
  const repo = p.repo ? String(p.repo) : ctx.cfg.githubRepos[0]
  return withTask(ctx, 'full_report', 'Full QA & security report ' + origin, { target: origin, repo: repo || null }, async () => {
    const parts: { name: string; f: Finding[]; ev: Ev[] }[] = []
    const guarded = async (name: string, fn: () => Promise<{ f: Finding[]; ev: Ev[] }>) => {
      try { parts.push({ name, ...(await fn()) }) } catch (e) { parts.push({ name, f: [], ev: [{ check: name, ok: false, detail: 'FAILED TO RUN: ' + errMsg(e).slice(0, 160) }] }) }
    }
    await Promise.all([
      guarded('website', async () => { const r = await websiteChecks(ctx, origin); return { f: r.f, ev: r.ev } }),
      guarded('auth', () => authChecks(ctx, origin)),
      guarded('api', () => apiChecks(ctx, origin)),
      guarded('database', () => dbChecks(ctx)),
      guarded('security', () => securityChecks(ctx, origin, repo))
    ])
    const ORDER = ['website', 'auth', 'api', 'database', 'security']
    parts.sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name))
    const findings = parts.flatMap(x => x.f)
    const evidence = parts.flatMap(x => x.ev.map(e => ({ ...e, check: x.name + ': ' + e.check })))
    const rep: any = report('Full QA, Testing & Security report', findings, evidence, { target: origin, sections: parts.map(x => ({ name: x.name, findings: x.f.length, tests: x.ev.length, passed: x.ev.filter(e => e.ok).length })), not_run: evidence.filter(e => /SKIPPED|FAILED TO RUN/.test(e.detail)).map(e => e.check), billing_safety: 'No billing event, charge, earning or payout was created. Billing-risk endpoints received only no-key/invalid-key requests. Database access was read-only.', rate_limit: 'Not run automatically: needs your approval (Rate-limit test).' })
    const ai = await summarize(ctx.cfg, { verdict: rep.verdict, counts: rep.counts, top: rep.findings.slice(0, 15).map((x: Finding) => ({ sev: x.severity, title: x.title, target: x.target, fix: x.fix })), not_run: rep.not_run })
    await recordAi(ctx, 'summary', ai)
    if (ai.text) rep.ai_summary = ai.text; else rep.ai_note = ai.error
    return { result: rep }
  })
}

// ---------------------------------------------------------------- retest (re-run an earlier test, diff the findings)
const RETESTABLE = ['website_smoke', 'auth_check', 'api_test', 'db_test', 'security_scan', 'full_report']
async function retest(ctx: Ctx, p: any): Promise<any> {
  const old = await ctx.store.getTask(String(p.task_id || ''))
  const pl = old && old.payload
  if (!old || !pl || !RETESTABLE.includes(pl.action)) throw new AgentError('Task cannot be retested', 404, 'not_found')
  const key = (f: Finding) => f.id + '|' + (f.target || '')
  const before = new Map<string, Finding>(((old.result && old.result.findings) || []).map((f: Finding) => [key(f), f]))
  const fresh: any = await runAction(ctx, pl.action, { target: pl.target, repo: pl.repo || undefined })
  const after = new Map<string, Finding>(((fresh.result && fresh.result.findings) || []).map((f: Finding) => [key(f), f]))
  const fixed = [...before.keys()].filter(k => !after.has(k)).map(k => before.get(k)!)
  const still = [...after.keys()].filter(k => before.has(k)).map(k => after.get(k)!)
  const added = [...after.keys()].filter(k => !before.has(k)).map(k => after.get(k)!)
  const retestResult = { retest_of: old.id, action: pl.action, fixed: fixed.map(f => f.title + ' (' + (f.target || '') + ')'), still_failing: still.map(f => f.severity + ': ' + f.title + ' (' + (f.target || '') + ')'), new_findings: added.map(f => f.severity + ': ' + f.title + ' (' + (f.target || '') + ')'), verdict_before: old.result && old.result.verdict, verdict_after: fresh.result && fresh.result.verdict }
  await ctx.store.log('info', 'agent3_retest', `${fixed.length} fixed, ${still.length} still failing, ${added.length} new`, { retest_of: old.id, new_task: fresh.task_id }, fresh.task_id, ctx.actor.id)
  return { task_id: fresh.task_id, status: 'succeeded', result: { ...fresh.result, retest: retestResult } }
}

// ---------------------------------------------------------------- free text -> ONE read-only test
async function aiCommand(ctx: Ctx, p: any): Promise<any> {
  const text = String(p.text || '').trim().slice(0, 500)
  if (!text) throw new AgentError('text is required', 400)
  const r = await planCommand(ctx.cfg, { request: text, targets: ctx.cfg.targets })
  await recordAi(ctx, 'plan', r)
  if (!r.text) throw new AgentError('AI planner unavailable: ' + (r.error || 'no answer'), 503, 'ai_unavailable')
  let plan: any
  try { plan = JSON.parse(r.text) } catch { throw new AgentError('AI planner returned an unreadable answer', 502, 'ai_bad') }
  const intent = String(plan.intent || '')
  const understood = { intent, explanation: String(plan.explanation || '').slice(0, 300) }
  if (!['website_smoke', 'auth_check', 'api_test', 'db_test', 'security_scan', 'full_report'].includes(intent))
    return { task_id: null, status: 'succeeded', understood, result: { unsupported: true, message: understood.explanation || 'Not supported. Agent 3 only runs read-only tests.' } }
  const target = plan.target && ctx.cfg.targets.includes(String(plan.target)) ? String(plan.target) : undefined
  const out: any = await runAction(ctx, intent, { target })
  return { ...out, understood }
}

// ---------------------------------------------------------------- queue for the Termux worker (runs later, on the phone, no Vercel time limit)
export const QUEUEABLE = ['website_smoke', 'auth_check', 'api_test', 'db_test', 'security_scan', 'full_report']
async function queueTask(ctx: Ctx, p: any): Promise<any> {
  const task = String(p.task || '')
  if (!QUEUEABLE.includes(task)) throw new AgentError('This test cannot be queued', 400, 'bad_action')
  const target = pickTarget(ctx, p)
  const repo = p.repo ? validRepo(String(p.repo)) : null
  if (repo && !ctx.cfg.githubRepos.some(r => r.toLowerCase() === repo.toLowerCase())) throw new AgentError('Repo not in AGENT3_GITHUB_REPOS', 403, 'repo_not_allowed')
  await ctx.store.ensureAgent()
  const t = await ctx.store.createTask({ title: 'Termux queue: ' + task + ' ' + target, description: 'Agent 3 - queued for Termux', status: 'queued', payload: { action: task, target, repo, runner: 'termux' }, created_by: ctx.actor.id })
  await ctx.store.log('info', 'agent3_task_queued', task, {}, t.id, ctx.actor.id)
  return { task_id: t.id, status: 'queued', result: { title: 'Queued for Termux', next: 'Termux me chalao: npm run agent3 -- worker --once   (live rakhna ho to --once hata do)' } }
}

// ---------------------------------------------------------------- Termux local checks (presets + approved custom command)
// Vercel only validates and queues. The commands themselves run ONLY in the Termux worker, in the project folder, with a minimal environment.
const cleanPresets = (p: any): string[] => [...new Set<string>((Array.isArray(p.presets) ? (p.presets as unknown[]) : []).map(x => String(x)))].filter(x => PRESET_IDS.includes(x))
async function queueLocal(ctx: Ctx, p: any): Promise<any> {
  const presets = cleanPresets(p)
  if (!presets.length) throw new AgentError('Pick at least one check', 400, 'bad_request')
  await ctx.store.ensureAgent()
  const t = await ctx.store.createTask({ title: 'Termux checks: ' + presets.join(', '), description: 'Agent 3 - Termux checks queued', status: 'queued', payload: { action: 'local_check', presets, runner: 'termux' }, created_by: ctx.actor.id })
  await ctx.store.log('info', 'agent3_local_queued', presets.join(','), {}, t.id, ctx.actor.id)
  return { task_id: t.id, status: 'queued', result: { title: 'Queued for Termux', next: 'Termux me chalao: npm run agent3 -- worker --once' } }
}
async function requestLocalCommand(ctx: Ctx, p: any): Promise<Out> {
  const parsed = parseCommand(p.command) // rejects anything outside the allow-list BEFORE an approval is created
  return withTask(ctx, 'request_local_command', 'Termux command: ' + parsed.display.slice(0, 80), { command: parsed.display }, async taskId => {
    const details = { kind: 'local_command', command: parsed.display, note: 'Runs on your phone, in the project folder, read-only allow-list, no secrets in its environment: ' + parsed.display }
    const ap = await ctx.store.createApproval({ task_id: taskId, title: 'Termux command: ' + parsed.display.slice(0, 80), details })
    await ctx.store.log('warn', 'agent3_approval_requested', ap.id, { approval_id: ap.id }, taskId, ctx.actor.id)
    return { status: 'awaiting_approval', result: { approval_id: ap.id, next: 'Approvals tab me approve karo, phir yahan "Queue on Termux" dabao.' } }
  })
}
async function queueLocalCommand(ctx: Ctx, p: any): Promise<any> {
  const ap = await ctx.store.getApproval(String(p.approval_id || ''))
  const d = ap && ap.details
  if (!ap || !d || d.kind !== 'local_command') throw new AgentError('Approval not found', 404, 'not_found')
  if (ap.status !== 'approved') throw new AgentError('Not approved yet (status: ' + ap.status + ')', 409, 'not_approved')
  if (d.executed_at) throw new AgentError('Already queued', 409, 'already_executed')
  if (!ap.decided_at || Date.now() - new Date(ap.decided_at).getTime() > 24 * 3600 * 1000) throw new AgentError('Approval older than 24h; request again', 409, 'expired')
  const parsed = parseCommand(d.command)
  if (!(await ctx.store.claimApproval(ap.id, { ...d, executed_at: now(), executed_by: ctx.actor.id }))) throw new AgentError('Already queued', 409, 'already_executed')
  const t = await ctx.store.createTask({ title: 'Termux command: ' + parsed.display.slice(0, 80), description: 'Agent 3 - approved Termux command', status: 'queued', payload: { action: 'local_command', approval_id: ap.id, command: parsed.display, runner: 'termux' }, created_by: ctx.actor.id })
  await ctx.store.log('info', 'agent3_local_command_queued', parsed.display, { approval_id: ap.id }, t.id, ctx.actor.id)
  return { task_id: t.id, status: 'queued', result: { title: 'Queued for Termux', next: 'Termux me chalao: npm run agent3 -- worker --once' } }
}
const termuxOnly = (ctx: Ctx) => { if (!ctx.worker) throw new AgentError('This only runs inside Termux (npm run agent3 -- worker)', 400, 'termux_only') }
async function localCheck(ctx: Ctx, p: any): Promise<Out> {
  termuxOnly(ctx)
  const presets = cleanPresets(p)
  if (!presets.length) throw new AgentError('No valid checks selected', 400, 'bad_request')
  const root = process.cwd(); ensureProject(root)
  return withTask(ctx, 'local_check', 'Termux checks: ' + presets.join(', '), { presets }, async () => {
    const r = await runLocal(presets, ctx.exec || realExec, root)
    return { result: report('Termux checks', r.findings, r.evidence, { commands: r.commands, presets, note: 'Ran on your phone. No secrets were passed to the commands. Nothing was written to production.' }) }
  })
}
async function localCommand(ctx: Ctx, p: any): Promise<Out> {
  termuxOnly(ctx)
  const ap = await ctx.store.getApproval(String(p.approval_id || ''))
  const d = ap && ap.details
  if (!ap || !d || d.kind !== 'local_command') throw new AgentError('Approval not found', 404, 'not_found')
  if (ap.status !== 'approved' || !d.executed_at) throw new AgentError('Not approved/queued', 409, 'not_approved')
  if (d.ran_at) throw new AgentError('Already ran', 409, 'already_executed')
  const parsed = parseCommand(d.command) // validated again on the phone
  const root = process.cwd(); ensureProject(root)
  if (!(await ctx.store.claimRun(ap.id, { ...d, ran_at: now() }))) throw new AgentError('Already ran', 409, 'already_executed')
  return withTask(ctx, 'local_command', 'Termux command: ' + parsed.display.slice(0, 80), { approval_id: ap.id }, async () => {
    const r = await runOne(parsed, ctx.exec || realExec, root, parsed.bin === 'npm' ? 300_000 : 60_000)
    const f: Finding[] = r.code === 0 ? [] : [{ id: 'local.command_failed', area: 'local', severity: 'low', title: 'Command exited with an error', evidence: `exit ${r.code}${r.timedOut ? ' (time limit)' : ''}`, fix: 'Read the output below.', target: parsed.display }]
    return { result: report('Termux command', f, [{ check: parsed.display, ok: r.code === 0, detail: `exit ${r.code} in ${r.ms}ms` }], { commands: [{ cmd: r.cmd, code: r.code, ms: r.ms, output: r.output }], note: 'Allowed: ' + ALLOWED_HELP }) }
  })
}

// ---------------------------------------------------------------- dispatcher
async function heartbeat(ctx: Ctx): Promise<any> {
  const a = await ctx.store.heartbeat()
  return { agent: { id: a.id, status: a.status, name: a.name }, ready: readiness(ctx.cfg), model: ctx.cfg.geminiModel, targets: ctx.cfg.targets, endpoints: ctx.cfg.endpoints.length, repos: ctx.cfg.githubRepos, safety: 'Read-only. No billing events, payments or production writes.' }
}

export async function runAction(ctx: Ctx, action: string, params: any = {}): Promise<any> {
  switch (action as Action) {
    case 'heartbeat': return heartbeat(ctx)
    case 'website_smoke': return websiteSmoke(ctx, params)
    case 'auth_check': return authCheck(ctx, params)
    case 'api_test': return apiTest(ctx, params)
    case 'db_test': return dbTest(ctx)
    case 'security_scan': return securityScan(ctx, params)
    case 'full_report': return fullReport(ctx, params)
    case 'request_rate_test': return requestRateTest(ctx, params)
    case 'apply_rate_test': return applyRateTest(ctx, params)
    case 'retest': return retest(ctx, params)
    case 'ai_command': return aiCommand(ctx, params)
    case 'queue_task': return queueTask(ctx, params)
    case 'queue_local': return queueLocal(ctx, params)
    case 'request_local_command': return requestLocalCommand(ctx, params)
    case 'queue_local_command': return queueLocalCommand(ctx, params)
    case 'local_check': return localCheck(ctx, params)
    case 'local_command': return localCommand(ctx, params)
    default: throw new AgentError('Unknown action', 400, 'bad_action')
  }
}
export { loadConfig, scanSecrets }
