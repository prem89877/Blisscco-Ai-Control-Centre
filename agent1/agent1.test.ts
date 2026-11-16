import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from './config.js'
import { redact, fingerprint } from './util.js'
import { analyzeProject, analyzeRls, assertReadOnlySql, classifyDbChange, classifyExecutableSql, sortIssues } from './checks.js'
import { isEnvFile } from './github.js'
import { handleRequest } from './server.js'
import { makeCtx, runAction } from './agent.js'

const REF = 'abcdref'
const SERVICE = 'svc_SECRET_KEY_1234567890'
const VTOKEN = 'vercel_TOKEN_abcdefghijklmnop'
const SBTOKEN = 'sbp_abcdefghijklmnopqrstuvwxyz'
const GHTOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123'
const GEMKEY = 'AIzaSyDUMMYDUMMYDUMMYDUMMYDUMMYDUMMY1'
const NEWVAL = 'super-secret-new-value-98765'
const ENV = {
  VITE_SUPABASE_URL: `https://${REF}.supabase.co`, VITE_SUPABASE_ANON_KEY: 'anon_public_key_value', SUPABASE_SERVICE_ROLE_KEY: SERVICE,
  AGENT1_VERCEL_TOKEN: VTOKEN, AGENT1_SUPABASE_ACCESS_TOKEN: SBTOKEN, AGENT1_GITHUB_TOKEN: GHTOKEN, AGENT1_GITHUB_REPOS: 'me/blisscco-ai-control-center',
  AGENT1_GEMINI_API_KEY: GEMKEY, AGENT1_REQUIRED_ENV: JSON.stringify({ 'ai-control-center': ['VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'AGENT1_GEMINI_API_KEY'] })
}

// ---------- in-memory fake of every external service ----------
type Row = Record<string, any>
let db: Record<string, Row[]>
let ext: { method: string; url: string }[]
let dbWrites: string[]
let sqlExec: string[]
let vercelWrites: { method: string; url: string; body: any }[]
let envs: Row[]
let seq = 0
const uuid = () => '00000000-0000-4000-8000-' + String(++seq).padStart(12, '0')

function reset() {
  seq = 0; ext = []; dbWrites = []; sqlExec = []; vercelWrites = []
  db = { agents: [1, 2, 3].map(s => ({ id: uuid(), slot: s, name: 'Agent ' + s, description: 'Placeholder - not built yet', status: 'offline', last_heartbeat_at: null, updated_at: new Date().toISOString(), config: {} })), tasks: [], approvals: [], activity_logs: [], api_usage: [], system_health: [], owners: [{ user_id: 'user-owner', role: 'owner' }] }
  envs = [
    { id: 'e1', key: 'VITE_SUPABASE_URL', type: 'plain', target: ['production', 'preview'] },
    { id: 'e2', key: 'SUPABASE_SERVICE_ROLE_KEY', type: 'plain', target: ['production'] },
    { id: 'e3', key: 'VITE_SERVICE_ROLE_TOKEN', type: 'plain', target: ['production'] },
    { id: 'e4', key: 'OLD_FLAG', type: 'plain', target: ['preview'] }
  ]
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

function matches(row: Row, k: string, v: string): boolean {
  if (k.includes('->>')) { const [c, f] = k.split('->>'); const x = row[c] ? row[c][f] : undefined; return v === 'is.null' ? x == null : String(x) === v.replace(/^eq\./, '') }
  if (v.startsWith('eq.')) return String(row[k]) === v.slice(3)
  if (v.startsWith('in.(')) return v.slice(4, -1).split(',').includes(String(row[k]))
  return true
}

async function fake(input: any, init: any = {}): Promise<Response> {
  const url = new URL(String(input)); const method = (init.method || 'GET').toUpperCase()
  const body = init.body ? JSON.parse(init.body) : undefined
  const h = init.headers || {}
  if (url.host === 'api.vercel.com') {
    ext.push({ method, url: url.host + url.pathname })
    if (h.Authorization !== 'Bearer ' + VTOKEN) return json({ error: { message: 'bad token' } }, 403)
    if (method !== 'GET') vercelWrites.push({ method, url: url.pathname, body })
    if (url.pathname === '/v9/projects') return json({ projects: [{ id: 'prj_1', name: 'ai-control-center', framework: 'vite', link: { org: 'me', repo: 'blisscco-ai-control-center' } }] })
    if (url.pathname === '/v6/deployments') return json({ deployments: [{ uid: 'd1', readyState: 'ERROR', target: 'production', created: Date.now() - 1000 }, { uid: 'd2', readyState: 'READY', target: 'preview', created: Date.now() - 5000 }] })
    if (url.pathname === '/v3/deployments/d1/events') return json([{ type: 'stderr', payload: { text: 'Error: vite not found ' + GEMKEY } }, { type: 'stdout', text: '\u001b[31mRunning build\u001b[39m' }])
    if (url.pathname === '/v13/deployments' && method === 'POST') return json({ id: 'd9', url: 'x.vercel.app' })
    if (url.pathname === '/v13/deployments/d1') return json({ errorMessage: 'Build failed: vite not found' })
    if (url.pathname === '/v9/projects/prj_1/env' && method === 'GET') return json({ envs })
    if (url.pathname === '/v10/projects/prj_1/env' && method === 'POST') return json({ created: { key: body.key } })
    if (url.pathname.startsWith('/v9/projects/prj_1/env/') && method === 'DELETE') { envs = envs.filter(e => e.id !== url.pathname.split('/').pop()); return json({}) }
  }
  if (url.host === 'api.supabase.com') {
    ext.push({ method, url: url.host + url.pathname })
    if (method === 'POST' && url.pathname.endsWith('/database/query')) { sqlExec.push(body.query); return body.query.includes('force_error') ? json({ message: 'relation does not exist' }, 400) : json([{ ok: 1 }]) }
    if (!url.pathname.endsWith('/database/query/read-only')) return json({}, 404)
    const q: string = body.query
    if (q.includes('pg_policies')) return json([{ schema: 'ai_control', tbl: 'agents', policy: 'agents_select', cmd: 'SELECT', roles: '{authenticated}', using_expr: 'ai_control.is_owner()', check_expr: '' }])
    if (q.includes('has_table_privilege')) return json([{ schema: 'ai_control', tbl: 'agents', rls: true, anon_select: false, anon_insert: false, anon_update: false, anon_delete: false, auth_select: true, auth_insert: false, auth_update: true, auth_delete: false }, { schema: 'public', tbl: 'financial_ledger', rls: true, anon_select: false, anon_insert: false, anon_update: false, anon_delete: false, auth_select: true, auth_insert: false, auth_update: false, auth_delete: false }])
    if (q.includes('information_schema.columns')) return json([{ table_name: 'agents', column_name: 'id', data_type: 'uuid', is_nullable: 'NO' }])
    return json([{ schema: 'ai_control', tables: 8, views: 0, functions: 3 }])
  }
  if (url.host === 'api.github.com') {
    ext.push({ method, url: url.host + url.pathname })
    const p = url.pathname
    if (p.endsWith('/commits')) return json([{ sha: 'abcdef123456', commit: { message: 'msg', author: { date: '2026-11-10' } } }])
    if (p.endsWith('/actions/runs')) return json({ workflow_runs: [{ name: 'ci', status: 'completed', conclusion: 'success', head_branch: 'main' }] })
    if (p.includes('/git/trees/')) return json({ tree: [{ type: 'blob', path: '.env.example' }, { type: 'blob', path: 'src/App.jsx' }] })
    return json({ default_branch: 'main', pushed_at: '2026-11-10' })
  }
  if (url.host === 'generativelanguage.googleapis.com') {
    ext.push({ method, url: url.host + url.pathname })
    return json({ candidates: [{ content: { parts: [{ text: '- Fix failing production build.' }] } }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30 } })
  }
  if (url.host === `${REF}.supabase.co`) {
    if (url.pathname === '/auth/v1/user') {
      const t = String(h.Authorization).replace('Bearer ', '')
      return t === 'tok-owner' ? json({ id: 'user-owner' }) : t === 'tok-other' ? json({ id: 'user-other' }) : json({}, 401)
    }
    const table = url.pathname.replace('/rest/v1/', '')
    if (h.apikey === ENV.VITE_SUPABASE_ANON_KEY) return json({ message: 'permission denied' }, 401)
    if (method !== 'GET') dbWrites.push(init.body)
    const t = (db[table] ||= [])
    const filt = (r: Row) => [...url.searchParams.entries()].filter(([k]) => !['select', 'order', 'limit'].includes(k)).every(([k, v]) => matches(r, k, v))
    if (method === 'GET') return json(t.filter(filt))
    if (method === 'POST') { const arr = Array.isArray(body) ? body : [body]; const out = arr.map((r: Row) => ({ id: uuid(), updated_at: new Date().toISOString(), requested_at: new Date().toISOString(), ...(table === 'approvals' ? { status: 'pending' } : {}), ...r })); t.push(...out); return json(out, 201) }
    if (method === 'PATCH') { const hit = t.filter(filt); hit.forEach(r => { if (table === 'approvals' && body.details === undefined) { /* status etc. */ } Object.assign(r, body, { updated_at: new Date().toISOString() }) }); return json(hit) }
  }
  return json({ error: 'unrouted ' + url }, 500)
}

const realFetch = globalThis.fetch
test.before(() => { globalThis.fetch = fake as any })
test.after(() => { globalThis.fetch = realFetch })
const post = (body: unknown, token = 'tok-owner', env: Record<string, string | undefined> = ENV) => handleRequest({ method: 'POST', headers: { authorization: 'Bearer ' + token }, body }, env)
const approve = (id: string, at = new Date().toISOString()) => { const a = db.approvals.find(x => x.id === id)!; a.status = 'approved'; a.decided_at = at }

// ---------- unit tests ----------
test('redact removes secrets and token patterns', () => {
  const out = JSON.stringify(redact({ a: `x ${SERVICE} y`, value: 'abc', n: { t: GHTOKEN, s: SBTOKEN, g: GEMKEY } }, [SERVICE]))
  for (const s of [SERVICE, GHTOKEN, SBTOKEN, GEMKEY, '"abc"']) assert.ok(!out.includes(s), s)
})
test('read-only SQL guard', () => {
  assertReadOnlySql("select 1 as x from pg_catalog.pg_class where relname = 'insert'")
  for (const bad of ['delete from public.ads', 'select 1; drop table x', 'with a as (select 1) insert into t select 1', 'select 1 -- hi', 'update public.ads set a=1', 'select * into t from x', 'grant all on t to anon'])
    assert.throws(() => assertReadOnlySql(bad), bad)
})
test('DB change classifier blocks protected objects', () => {
  assert.equal(classifyDbChange('alter table ai_control.tasks add column x int').ok, true)
  for (const bad of ['alter table public.ads add column x int', 'alter table ai_control.tasks add column payout int', 'select 1', 'drop schema ai_control cascade']) assert.equal(classifyDbChange(bad).ok, false, bad)
})
test('env file detection', () => { assert.ok(isEnvFile('.env')); assert.ok(isEnvFile('app/.env.local')); assert.ok(!isEnvFile('.env.example')) })
test('analyzeProject flags failures, missing and exposed env', () => {
  const i = analyzeProject('p', [{ id: 'd', state: 'ERROR', target: 'production', createdAt: Date.now() }], [{ key: 'VITE_SERVICE_ROLE_KEY', type: 'plain', targets: ['production'] }, { key: 'DB_PASSWORD', type: 'plain', targets: ['production'] }], ['MISSING_ONE'])
  const m = i.map(x => x.severity + ':' + x.message).join('|')
  assert.match(m, /error:Latest production deployment failed/); assert.match(m, /critical:VITE_SERVICE_ROLE_KEY/); assert.match(m, /error:Required env var missing: MISSING_ONE/); assert.match(m, /warn:DB_PASSWORD is stored as plain/)
})
test('analyzeRls: grant-only anon writes are warn, deny-all info is collapsed, critical sorts first', () => {
  const t = (o: any) => ({ schema: 'public', tbl: 'x', rls: true, anon_select: false, anon_insert: false, anon_update: false, anon_delete: false, auth_select: true, auth_insert: false, auth_update: false, auth_delete: false, ...o })
  const i = analyzeRls([t({ tbl: 'admins', anon_insert: true }), t({ tbl: 'a1' }), t({ tbl: 'a2' }), t({ tbl: 'push', anon_insert: true })], [{ schema: 'public', tbl: 'push', policy: 'open', cmd: 'INSERT', roles: '{anon}', using_expr: '', check_expr: 'true' }])
  assert.equal(i.find(x => x.target === 'public.admins')!.severity, 'warn')
  assert.equal(i.find(x => x.target === 'public.push')!.severity, 'error')
  assert.equal(i.filter(x => x.severity === 'info').length, 1)
  assert.equal(sortIssues(i)[0].severity, 'critical')
})
test('analyzeRls flags disabled RLS, anon grants and open policies', () => {
  const t = (o: any) => ({ schema: 'public', tbl: 'x', rls: true, anon_select: false, anon_insert: false, anon_update: false, anon_delete: false, auth_select: true, auth_insert: false, auth_update: false, auth_delete: false, ...o })
  const i = analyzeRls([t({ tbl: 'financial_ledger', rls: false }), t({ schema: 'ai_control', tbl: 'tasks', anon_select: true }), t({ tbl: 'ads', anon_insert: true })], [{ schema: 'public', tbl: 'ads', policy: 'p', cmd: 'ALL', roles: '{anon}', using_expr: 'true', check_expr: '' }])
  const m = i.map(x => x.severity + ':' + x.target).join('|')
  assert.match(m, /critical:public.financial_ledger/); assert.match(m, /critical:ai_control.tasks/); assert.match(m, /error:public.ads/); assert.match(m, /critical:public.ads \/ p/)
})

// ---------- integration tests (fake backend) ----------
test('auth: missing/invalid token 401, non-owner 403, wrong method 405', async () => {
  reset()
  assert.equal((await handleRequest({ method: 'GET', headers: {} }, ENV)).status, 405)
  assert.equal((await handleRequest({ method: 'POST', headers: {}, body: {} }, ENV)).status, 401)
  assert.equal((await post({ action: 'heartbeat' }, 'bad')).status, 401)
  assert.equal((await post({ action: 'heartbeat' }, 'tok-other')).status, 403)
  assert.equal((await post({ action: 'heartbeat' }, 'tok-owner', {})).status, 500)
  assert.equal((await post({ action: 'nope' })).status, 400)
})
test('heartbeat registers Agent 1 and sets it idle', async () => {
  reset()
  const r: any = await post({ action: 'heartbeat' })
  assert.equal(r.status, 200); assert.equal(r.body.agent.name, 'Infrastructure & Deployment Agent'); assert.equal(r.body.agent.status, 'idle')
  assert.equal(r.body.ready.gemini, true)
})
test('health_report: tasks/logs/usage/health written, read-only calls, no secret leaks', async () => {
  reset()
  const r: any = await post({ action: 'health_report' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.result.overall, 'critical')
  const msgs = r.body.result.issues.map((i: any) => i.message).join('|')
  assert.match(msgs, /Latest production deployment failed: Build failed/); assert.match(msgs, /VITE_SERVICE_ROLE_TOKEN looks like a secret/); assert.match(msgs, /AGENT1_GEMINI_API_KEY/)
  assert.equal(r.body.result.ai_summary, '- Fix failing production build.')
  assert.equal(db.tasks[0].status, 'succeeded'); assert.ok(db.activity_logs.length >= 2); assert.equal(db.system_health.length, 3)
  assert.ok(db.api_usage.some(u => u.provider === 'gemini' && u.tokens_in === 120)); assert.ok(db.api_usage.some(u => u.provider === 'vercel'))
  assert.equal(db.agents[0].status, 'idle')
  // read-only evidence
  assert.ok(ext.length > 5)
  for (const c of ext) {
    if (c.url.startsWith('api.vercel.com') || c.url.startsWith('api.github.com')) assert.equal(c.method, 'GET', c.url)
    if (c.url.startsWith('api.supabase.com')) assert.ok(c.url.endsWith('/database/query/read-only') && c.method === 'POST', c.url)
  }
  assert.equal(vercelWrites.length, 0)
  const everything = JSON.stringify([r.body, db])
  for (const s of [SERVICE, VTOKEN, SBTOKEN, GHTOKEN, GEMKEY]) assert.ok(!everything.includes(s), 'leaked ' + s.slice(0, 6))
})
test('one failing Vercel project does not hide the others', async () => {
  reset()
  const orig = globalThis.fetch
  globalThis.fetch = (async (u: any, i: any) => String(u).includes('/v9/projects/prj_1/env') && (i?.method || 'GET') === 'GET' ? new Response('{"error":{"message":"boom"}}', { status: 500 }) : fake(u, i)) as any
  try {
    const r: any = await post({ action: 'env_audit' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.ok(r.body.result.issues.some((i: any) => /Could not read project/.test(i.message)))
    assert.equal(r.body.result.projects[0].name, 'ai-control-center')
  } finally { globalThis.fetch = orig }
})
test('env_audit returns key names only, never values', async () => {
  reset(); envs[0].value = 'LEAKME_VALUE'
  const r: any = await post({ action: 'env_audit' })
  assert.equal(r.status, 200); assert.ok(!JSON.stringify([r.body, db]).includes('LEAKME_VALUE'))
  assert.ok(r.body.result.projects[0].env.some((e: any) => e.key === 'SUPABASE_SERVICE_ROLE_KEY'))
})
test('supabase_schema rejects unknown schema, rls_check passes anon probe', async () => {
  reset()
  assert.equal((await post({ action: 'supabase_schema', params: { schema: 'pg_catalog' } }) as any).status, 400)
  const s: any = await post({ action: 'supabase_schema' }); assert.equal(s.status, 200); assert.ok(s.body.result.columns.agents)
  const r: any = await post({ action: 'rls_check' }); assert.equal(r.status, 200)
  assert.ok(r.body.result.anon_probe.every((p: any) => p.verdict === 'blocked'))
})
test('env change: approval gate, production ack, value match, single execution, value never stored', async () => {
  reset()
  const req: any = await post({ action: 'request_env_change', params: { project: 'ai-control-center', op: 'upsert', key: 'NEW_KEY', targets: ['production', 'preview'], type: 'encrypted', value: NEWVAL } })
  assert.equal(req.status, 200, JSON.stringify(req.body)); assert.equal(req.body.status, 'awaiting_approval')
  const id = req.body.result.approval_id
  assert.equal(db.approvals[0].status, 'pending'); assert.equal(db.approvals[0].details.production, true)
  const apply = (p: any) => post({ action: 'apply_env_change', params: { approval_id: id, ...p } }) as Promise<any>
  assert.equal((await apply({ value: NEWVAL })).status, 409)                       // not approved yet
  approve(id)
  assert.equal((await apply({ value: NEWVAL })).status, 403)                       // production needs ack
  assert.equal((await apply({ value: 'wrong', production_ack: 'APPROVE-PRODUCTION' })).status, 409) // value mismatch
  assert.equal(vercelWrites.length, 0)                                              // nothing written so far
  const ok = await apply({ value: NEWVAL, production_ack: 'APPROVE-PRODUCTION' })
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(vercelWrites.length, 1); assert.equal(vercelWrites[0].body.value, NEWVAL)
  assert.equal((await apply({ value: NEWVAL, production_ack: 'APPROVE-PRODUCTION' })).status, 409) // no double run
  assert.equal(vercelWrites.length, 1)
  assert.ok(!JSON.stringify([db, ok.body, req.body]).includes(NEWVAL), 'value leaked into DB/response')
  assert.ok(!dbWrites.join('').includes(NEWVAL))
  assert.equal(db.tasks.find(t => t.title.startsWith('Env upsert'))!.status, 'succeeded')
})
test('env change: expired approval and secret-looking public name refused; delete flow', async () => {
  reset()
  assert.equal((await post({ action: 'request_env_change', params: { project: 'ai-control-center', op: 'upsert', key: 'VITE_SECRET_KEY', targets: ['preview'], value: 'x' } }) as any).status, 400)
  assert.equal((await post({ action: 'request_env_change', params: { project: 'nope', op: 'delete', key: 'OLD_FLAG', targets: ['preview'] } }) as any).status, 404)
  const req: any = await post({ action: 'request_env_change', params: { project: 'ai-control-center', op: 'delete', key: 'OLD_FLAG', targets: ['preview'] } })
  const id = req.body.result.approval_id
  approve(id, new Date(Date.now() - 25 * 3600 * 1000).toISOString())
  assert.equal((await post({ action: 'apply_env_change', params: { approval_id: id } }) as any).status, 409)
  approve(id)
  const ok: any = await post({ action: 'apply_env_change', params: { approval_id: id } })
  assert.equal(ok.status, 200); assert.equal(vercelWrites.length, 1); assert.equal(vercelWrites[0].method, 'DELETE'); assert.ok(!envs.some(e => e.key === 'OLD_FLAG'))
})
test('propose_db_change: creates approval only, blocks protected schemas, never executes', async () => {
  reset()
  const bad: any = await post({ action: 'propose_db_change', params: { title: 't', sql: 'alter table public.ads add column x int' } })
  assert.equal(bad.status, 403); assert.equal(db.approvals.length, 0)
  const ok: any = await post({ action: 'propose_db_change', params: { title: 'add col', sql: 'alter table ai_control.tasks add column note text' } })
  assert.equal(ok.status, 200); assert.equal(db.approvals[0].details.kind, 'db_change'); assert.equal(ext.filter(c => c.url.startsWith('api.supabase.com')).length, 0)
})
test('failure path: bad Vercel token -> task failed, agent error status, logged', async () => {
  reset()
  const r: any = await post({ action: 'vercel_status' }, 'tok-owner', { ...ENV, AGENT1_VERCEL_TOKEN: 'wrong' })
  assert.equal(r.status, 502); assert.ok(r.body.task_id)
  assert.equal(db.tasks[0].status, 'failed'); assert.equal(db.agents[0].status, 'error'); assert.ok(db.activity_logs.some(l => l.level === 'error'))
})
test('fingerprint is keyed and stable', () => { assert.equal(fingerprint('k', 'v'), fingerprint('k', 'v')); assert.notEqual(fingerprint('k', 'v'), fingerprint('k2', 'v')) })
test('loadConfig requires Supabase url + service key; makeCtx exported', () => { assert.throws(() => loadConfig({})); assert.equal(typeof makeCtx, 'function'); assert.equal(typeof runAction, 'function') })

test('classifyExecutableSql: allows ai_control DDL/DML, blocks risky statements', () => {
  const ok = (q: string) => assert.equal(classifyExecutableSql(q).ok, true, q)
  const no = (q: string) => assert.equal(classifyExecutableSql(q).ok, false, q)
  ok('alter table ai_control.tasks add column note text')
  ok("insert into ai_control.settings(key, value) values ('a', '1') on conflict (key) do update set value = excluded.value")
  ok("update ai_control.tasks set status = 'x' where id = '1'")
  no('delete from ai_control.tasks'); no('update ai_control.tasks set status = 1')
  no('alter table public.ads add column x int'); no('select * from ai_control.tasks; commit')
  no('drop table ai_control.tasks'); no('alter table ai_control.tasks disable row level security')
  no('grant select on ai_control.tasks to anon'); no('set role postgres; select 1 from ai_control.tasks')
  no('create extension pg_net; select 1 from ai_control.tasks'); no('select 1 from ai_control.tasks -- x')
})
test('apply_db_change: approval + ack gate, ai_control transaction, single execution, never for blocked SQL', async () => {
  reset()
  const mk = async (sql: string, title = 'add col') => { const r: any = await post({ action: 'propose_db_change', params: { title, sql } }); return r.body.result.approval_id as string }
  const id = await mk('alter table ai_control.tasks add column note text')
  const run = (approval_id: string, db_ack: string | null = 'RUN-SQL') => post({ action: 'apply_db_change', params: { approval_id, db_ack } })
  assert.equal((await run(id) as any).status, 409)
  approve(id)
  assert.equal((await run(id, null) as any).status, 403)
  assert.equal(sqlExec.length, 0)
  const ok: any = await run(id)
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.result.applied, true)
  assert.equal(sqlExec.length, 1)
  assert.match(sqlExec[0], /^BEGIN; SET LOCAL search_path = ai_control, pg_catalog;/); assert.match(sqlExec[0], /COMMIT;$/); assert.match(sqlExec[0], /alter table ai_control\.tasks add column note text/)
  assert.equal((await run(id) as any).status, 409); assert.equal(sqlExec.length, 1)
  const old = await mk('alter table ai_control.tasks add column n2 text', 'old'); approve(old, new Date(Date.now() - 25 * 3600 * 1000).toISOString())
  assert.equal((await run(old) as any).status, 409)
  const evil = await mk('alter table ai_control.tasks add column n3 text', 'tampered'); approve(evil)
  db.approvals.find(a => a.id === evil)!.details.sql = 'alter table public.ads add column x int'
  assert.equal((await run(evil) as any).status, 403); assert.equal(sqlExec.length, 1)
  assert.ok(db.activity_logs.some(l => l.action === 'agent1_db_applied'))
})
test('apply_db_change: SQL error releases the approval and marks task failed', async () => {
  reset()
  const r: any = await post({ action: 'propose_db_change', params: { title: 'bad', sql: 'alter table ai_control.force_error add column x int' } })
  const id = r.body.result.approval_id; approve(id)
  const x: any = await post({ action: 'apply_db_change', params: { approval_id: id, db_ack: 'RUN-SQL' } })
  assert.equal(x.status, 502); assert.equal(x.body.code, 'sql_failed')
  const ap = db.approvals.find(a => a.id === id)!
  assert.equal(ap.details.executed_at, null); assert.ok(ap.details.last_error)
  assert.ok(db.tasks.some(t => t.status === 'failed' && t.description === 'Agent 1 - apply_db_change'))
})

test('github_status is read-only (GET only) and reports repos', async () => {
  reset()
  const r: any = await post({ action: 'github_status' })
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.result.repos[0].found, true)
  assert.ok(ext.filter(c => c.url.startsWith('api.github.com')).every(c => c.method === 'GET'))
  assert.equal(JSON.stringify(r.body).includes(GHTOKEN), false)
})
test('deploy_logs: returns redacted tail of the failed deployment, read-only', async () => {
  reset()
  const r: any = await post({ action: 'deploy_logs', params: { project: 'ai-control-center' } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const d = r.body.result.deployments[0]
  assert.equal(d.deployment_id, 'd1'); assert.equal(d.log_tail.length, 2)
  assert.equal(d.log_tail[1].includes('\u001b'), false)
  assert.equal(JSON.stringify(r.body).includes(GEMKEY), false)
  assert.equal(vercelWrites.length, 0)
  assert.equal((await post({ action: 'deploy_logs', params: { project: 'ai-control-center', deployment: 'nope' } }) as any).status, 404)
})
test('redeploy: approval gate, production ack, single execution, no write before approval', async () => {
  reset()
  const q: any = await post({ action: 'request_redeploy', params: { project: 'ai-control-center' } })
  assert.equal(q.status, 200, JSON.stringify(q.body)); assert.equal(q.body.status, 'awaiting_approval'); assert.equal(q.body.result.production, true)
  const id = q.body.result.approval_id
  const run = (production_ack?: string | null) => post({ action: 'apply_redeploy', params: { approval_id: id, production_ack } })
  assert.equal((await run('APPROVE-PRODUCTION') as any).status, 409); assert.equal(vercelWrites.length, 0)
  approve(id)
  assert.equal((await run(null) as any).status, 403); assert.equal(vercelWrites.length, 0)
  const ok: any = await run('APPROVE-PRODUCTION')
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.result.new_deployment, 'd9')
  assert.equal(vercelWrites.length, 1); assert.equal(vercelWrites[0].body.deploymentId, 'd1'); assert.equal(vercelWrites[0].body.target, 'production')
  assert.equal((await run('APPROVE-PRODUCTION') as any).status, 409); assert.equal(vercelWrites.length, 1)
  assert.equal((await post({ action: 'request_redeploy', params: { project: 'ai-control-center', deployment: 'zzz' } }) as any).status, 404)
})

test('vercel_options lists projects+deployments read-only; redeploy honours target', async () => {
  reset()
  const o: any = await post({ action: 'vercel_options' })
  assert.equal(o.status, 200, JSON.stringify(o.body))
  const pr = o.body.result.projects.find((x: any) => x.name === 'ai-control-center')
  assert.ok(pr && pr.deployments.some((d: any) => d.id === 'd2' && d.target === 'preview'))
  assert.equal(vercelWrites.length, 0)
  const q: any = await post({ action: 'request_redeploy', params: { project: 'ai-control-center', target: 'preview' } })
  assert.equal(q.status, 200, JSON.stringify(q.body)); assert.equal(q.body.result.production, false)
  const bad: any = await post({ action: 'request_redeploy', params: { project: 'ai-control-center', target: 'preview', deployment: 'd1' } })
  assert.equal(bad.status, 400)
  assert.equal((await post({ action: 'request_redeploy', params: { project: 'ai-control-center', target: 'staging' } }) as any).status, 400)
  assert.equal(vercelWrites.length, 0)
})
