import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from './config.js'
import { assertAuthorizedTarget, assertBillingSafe, assertReadOnlySql, isBillingRisk, scanSecrets, validPath, jwtRole } from './guard.js'
import * as C from './checks.js'
import { redact } from './util.js'
import { handleRequest } from './server.js'
import { makeCtx, runAction, assertRouteAllowed, assertRouteBudget, hardBurstCap, MAX_REQUESTS_PER_ROUTE } from './agent.js'
import { workOnce } from './worker.js'
import { parseCommand, runLocal, runOne, realExec, scanLocalSecrets, analyzeTests, analyzeAudit, analyzeGit, analyzeEnv, analyzeBuild, ALLOWED_HELP, type ExecFn } from './local.js'
import { maskSecrets } from './guard.js'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REF = 'abcdref'
const SITE = 'https://qa.example.com'
const SERVICE = 'svc_SECRET_KEY_1234567890'
const GEMKEY = 'AIzaSyDUMMYDUMMYDUMMYDUMMYDUMMYDUMMY1'
const TESTKEY = 'tk_live_valid_test_key_123456'
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (role: string) => `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ role, iss: 'supabase' })}.sigsigsigsigsig`
const ANON = jwt('anon')
const SVC_JWT = jwt('service_role')
const ENV: Record<string, string> = {
  VITE_SUPABASE_URL: `https://${REF}.supabase.co`, VITE_SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE,
  AGENT3_GEMINI_API_KEY: GEMKEY, AGENT3_TARGETS: SITE, AGENT3_WEB_PATHS: '/,/login',
  AGENT3_PROTECTED_PATHS: '/admin,/publisher', AGENT3_TEST_API_KEY: TESTKEY,
  AGENT3_SUPABASE_ACCESS_TOKEN: 'sbp_dummydummydummydummy', AGENT3_GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123', AGENT3_GITHUB_REPOS: 'me/site',
  AGENT3_API_ENDPOINTS: JSON.stringify([
    { name: 'serve', path: '/api/serve', method: 'GET', auth: 'key', billing_risk: true },
    { name: 'stats', path: '/api/stats', method: 'GET', auth: 'key' }
  ])
}

// ---------------------------------------------------------------- fake world
type Row = Record<string, any>
let db: Record<string, Row[]>
let seq = 0
const uuid = () => '00000000-0000-4000-8000-' + String(++seq).padStart(12, '0')
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...headers } })
const html = (b: string, status = 200, headers: Record<string, string> = {}) => new Response(b, { status, headers: { 'content-type': 'text/html', ...headers } })

let siteInsecure: boolean       // true: bugs present
let siteCalls: { method: string; path: string; headers: Record<string, string> }[]
let otherHostCalls: string[]
let sqlSeen: string[]
let mgmtTables: Row[]
let mgmtPolicies: Row[]
let rateLimit: boolean
let rateCount: number
let repoFiles: Record<string, string>
let a3Refs: Record<string, string> = {}
let filesBySha: Record<string, Record<string, string>> = {}
let a3Queries: string[] = []

const GOOD_HEADERS = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'strict-transport-security': 'max-age=63072000', 'permissions-policy': 'camera=()' }
const PAGE = (vp: boolean) => `<!doctype html><html lang="en"><head><title>Blisscco</title>${vp ? '<meta name="viewport" content="width=device-width, initial-scale=1">' : ''}<script src="/assets/app.js"></script></head><body>Login password</body></html>`

function site(path: string, method: string): Response {
  const hdr = siteInsecure ? {} : GOOD_HEADERS
  const p = path.split('?')[0]
  if (p === '/' || p === '/login') return html(PAGE(!siteInsecure), 200, hdr)
  if (p === '/admin') return siteInsecure ? html('<html><body>Admin: revenue balance payout earnings</body></html>', 200, hdr) : html('', 302, { ...hdr, location: '/login' })
  if (p === '/publisher') return html('', 401, hdr)
  if (p === '/assets/app.js') return new Response(siteInsecure ? `const k="${SVC_JWT}";` : `const a="${ANON}";`, { headers: { 'content-type': 'text/javascript' } })
  if (p === '/.env') return siteInsecure ? new Response('SECRET=abc', { headers: { 'content-type': 'text/plain' } }) : html('<!doctype html><html></html>', 200, hdr)
  if (p === '/robots.txt') return new Response('User-agent: *', { status: 200 })
  if (p === '/api/serve' || p === '/api/stats') {
    const key = '' // evaluated by caller
    void key
  }
  return html('<html>nf</html>', 404, hdr)
}

async function fake(input: any, init: any = {}): Promise<Response> {
  const url = new URL(String(input)); const method = (init.method || 'GET').toUpperCase()
  const h: Record<string, string> = {}
  const rawH = init.headers || {}
  for (const k of Object.keys(rawH)) h[k.toLowerCase()] = rawH[k]
  if (url.origin === 'https://blisscco.online') {
    siteCalls.push({ method, path: url.pathname + url.search, headers: h })
    if (url.pathname === '/api/v1/ads/impression') return json({ error: 'invalid' }, 400)
    if (url.pathname === '/api/v1/ads/click') return json({ error: 'not found' }, 404)
    if (url.pathname === '/api/v1/ads/match') return json({ error: 'unauthorized' }, 401)
  }
  if (url.origin === SITE) {
    siteCalls.push({ method, path: url.pathname + url.search, headers: h })
    if (url.pathname === '/api/serve' || url.pathname === '/api/stats') {
      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': siteInsecure ? 'https://evil.example' : 'https://qa.example.com' } })
      const key = h['x-api-key']
      const valid = key === TESTKEY
      if (siteInsecure && url.pathname === '/api/serve') return json({ ad: 'x' }, 200)             // bypass: no auth at all
      if (!valid) return json({ error: 'unauthorized' }, 401)
      if (method !== 'GET') return json({ error: 'method' }, 405)
      if (url.search.includes('%00')) return json({ error: 'bad id' }, 400)
      return json({ ok: true })
    }
    if (url.pathname === '/api/rated') {
      rateCount++
      if (rateLimit && rateCount > 12) return json({ error: 'slow down' }, 429, { 'retry-after': '30' })
      return json({ ok: 1 })
    }
    if (url.pathname === '/api/v1/ads/impression') return json({ error: 'invalid' }, 400)
    if (url.pathname === '/api/v1/ads/click') return json({ error: 'not found' }, 404)
    if (url.pathname === '/api/v1/ads/match') return json({ error: 'unauthorized' }, 401)
    return site(url.pathname + url.search, method)
  }
  if (url.host === `${REF}.supabase.co`) {
    if (url.pathname === '/auth/v1/health') return json({ ok: true })
    if (url.pathname === '/auth/v1/user') {
      const t = String(h.authorization).replace('Bearer ', '')
      return t === 'tok-owner' ? json({ id: 'user-owner' }) : t === 'tok-other' ? json({ id: 'user-other' }) : json({}, 401)
    }
    const table = url.pathname.replace('/rest/v1/', '')
    if (table === '' || table === '/rest/v1/') return json({ swagger: '2.0' })
    if (!h['accept-profile'] && !h['content-profile'] && h.apikey === ANON) {
      if (table === 'payout_ledger') return json([{ id: 1 }])                   // anon can read ledger (bug)
      return json([])
    }
    const t = (db[table] ||= [])
    const filt = (r: Row) => [...url.searchParams.entries()].filter(([k]) => !['select', 'order', 'limit'].includes(k)).every(([k, v]) => k.includes('->>') ? true : v.startsWith('eq.') ? String(r[k]) === v.slice(3) : v.startsWith('in.(') ? v.slice(4, -1).split(',').includes(String(r[k])) : true)
    const body = init.body ? JSON.parse(init.body) : undefined
    if (method === 'GET') return json(t.filter(filt))
    if (method === 'POST') { const arr = Array.isArray(body) ? body : [body]; const out = arr.map((r: Row) => ({ id: uuid(), updated_at: new Date().toISOString(), requested_at: new Date().toISOString(), ...(table === 'approvals' ? { status: 'pending' } : {}), ...r })); t.push(...out); return json(out, 201) }
    if (method === 'PATCH') { const hit = t.filter(filt); hit.forEach(r => Object.assign(r, body, { updated_at: new Date().toISOString() })); return json(hit) }
  }
  if (url.host === 'api.supabase.com') {
    if (h.authorization !== 'Bearer ' + ENV.AGENT3_SUPABASE_ACCESS_TOKEN) return json({ message: 'forbidden' }, 403)
    const sql = String(JSON.parse(init.body).query); sqlSeen.push(sql)
    assert.ok(/^\s*(select|with)\b/i.test(sql), 'non-read SQL sent: ' + sql)
    if (sql.includes('relrowsecurity')) return json(mgmtTables)
    if (sql.includes('pg_policies')) return json(mgmtPolicies)
    if (sql.includes('indisprimary')) return json([{ schema: 'public', tbl: 'payout_ledger' }])
    if (sql.includes('information_schema.columns')) return json([{ column_name: 'id', data_type: 'uuid' }, { column_name: 'publisher_id', data_type: 'uuid' }, { column_name: 'event_id', data_type: 'text' }, { column_name: 'amount', data_type: 'numeric' }])
    if (sql.includes('count(*)::int as total')) return json([{ total: 100, nul: 2, dup: 3, neg: 1 }])
    return json([])
  }
  if (url.host === 'registry.npmjs.org') return json({ 'left-pad': [{ id: 1, title: 'Prototype pollution', severity: 'high', vulnerable_versions: '<1.3.1', url: 'https://github.com/advisories/x' }] })
  if (url.host === 'api.github.com') {
    if (h.authorization !== 'Bearer ' + ENV.AGENT3_GITHUB_TOKEN) return json({}, 401)
    a3Queries.push(url.pathname + url.search)
    if (url.pathname === '/repos/me/site') return json({ default_branch: 'main' })
    const refM = /^\/repos\/me\/site\/git\/ref\/heads\/(.+)$/.exec(url.pathname)
    if (refM) { const sh = a3Refs[decodeURIComponent(refM[1])]; return sh ? json({ object: { sha: sh } }) : json({ message: 'Not Found' }, 404) }
    if (url.pathname === '/repos/me/site/branches') { const pg = Number(url.searchParams.get('page') || 1); return json(Object.entries(a3Refs).slice((pg - 1) * 100, pg * 100).map(([name, sha]) => ({ name, commit: { sha } }))) }
    const files = (id: string | null) => (id && filesBySha[id]) || repoFiles
    const tr = /^\/repos\/me\/site\/git\/trees\/(.+)$/.exec(url.pathname)
    if (tr) { const fl = files(decodeURIComponent(tr[1])); return json({ tree: Object.entries(fl).map(([path, c]) => ({ path, type: 'blob', size: c.length, sha: 'x' })) }) }
    const m = /^\/repos\/me\/site\/contents\/(.+)$/.exec(url.pathname)
    const fl2 = files(url.searchParams.get('ref'))
    if (m && fl2[decodeURIComponent(m[1])] != null) { const c = fl2[decodeURIComponent(m[1])]; return json({ content: Buffer.from(c).toString('base64'), size: c.length }) }
    return json({}, 404)
  }
  if (url.host === 'generativelanguage.googleapis.com') {
    const body = JSON.parse(init.body); const sys = String(body.systemInstruction.parts[0].text)
    const text = sys.includes('command planner') ? planReply : 'Verdict: fail. Top: fix auth bypass.'
    return json({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 } })
  }
  otherHostCalls.push(url.host)
  return json({ error: 'unrouted ' + url }, 500)
}
let planReply = '{}'
const realFetch = globalThis.fetch
test.before(() => { globalThis.fetch = fake as any })
test.after(() => { globalThis.fetch = realFetch })
test.beforeEach(() => {
  a3Refs = { main: 'a'.repeat(40), 'release/1.0': 'b'.repeat(40) }; filesBySha = {}; a3Queries = []
  seq = 0; siteInsecure = true; siteCalls = []; otherHostCalls = []; sqlSeen = []; rateLimit = true; rateCount = 0; planReply = '{}'
  repoFiles = { 'package.json': '{"name":"x","dependencies":{"left-pad":"1.0.0"}}', 'src/a.js': `const k = "${SVC_JWT}"`, '.env': 'A=1', 'README.md': 'hi' }
  mgmtTables = [
    ...['owners', 'agents', 'tasks', 'approvals', 'activity_logs', 'api_usage', 'system_health', 'settings'].map(t => ({ schema: 'ai_control', tbl: t, rls: true, anon_select: false, anon_insert: false, anon_update: false, anon_delete: false, auth_select: true, auth_insert: false, auth_update: false, auth_delete: false })),
    { schema: 'public', tbl: 'payout_ledger', rls: false, anon_select: true, anon_insert: true, anon_update: false, anon_delete: false, auth_select: true, auth_insert: true, auth_update: true, auth_delete: true }
  ]
  mgmtPolicies = [{ schema: 'public', tbl: 'earnings', policy: 'all_read', cmd: 'SELECT', roles: '{authenticated}', using_expr: 'true', check_expr: '' }]
  db = { agents: [1, 2, 3].map(s => ({ id: uuid(), slot: s, name: 'Agent ' + s, description: 'Placeholder - not built yet', status: 'offline', last_heartbeat_at: null, updated_at: new Date().toISOString(), config: {} })), owners: [{ user_id: 'user-owner', role: 'owner' }] }
})
const ctx = () => makeCtx(loadConfig(ENV), { type: 'user', id: 'user-owner' })
const ids = (r: any) => (r.result.findings as C.Finding[]).map(f => f.id)

// ================================================================ guards
test('target must be https, public and in AGENT3_TARGETS', () => {
  const t = [SITE]
  assert.equal(assertAuthorizedTarget(t, SITE + '/x'), SITE)
  for (const bad of ['http://qa.example.com', 'https://evil.com', 'https://localhost', 'https://127.0.0.1', 'https://169.254.169.254', 'https://u:p@qa.example.com', 'ftp://qa.example.com', 'nope'])
    assert.throws(() => assertAuthorizedTarget(t, bad))
  assert.throws(() => assertAuthorizedTarget(t, undefined))
})
test('paths are validated', () => {
  assert.equal(validPath('/api/x?a=1'), '/api/x?a=1')
  for (const b of ['api', '//evil.com', '/a/../b', '/a b', '/' + 'a'.repeat(300)]) assert.throws(() => validPath(b))
})
test('billing safety: positive calls to billing-risk paths are blocked, negative allowed', () => {
  for (const p of ['/api/serve', '/api/impression', '/api/click', '/api/payout', '/api/track', '/api/postback']) assert.ok(isBillingRisk(p), p)
  assert.ok(!isBillingRisk('/api/stats'))
  assert.throws(() => assertBillingSafe('/api/impression', 'positive', []), /billable/)
  assert.doesNotThrow(() => assertBillingSafe('/api/impression', 'negative', []))
  assert.doesNotThrow(() => assertBillingSafe('/api/stats', 'positive', []))
  assert.doesNotThrow(() => assertBillingSafe('/api/impression', 'positive', ['/api/impression']))
})
test('read-only SQL guard', () => {
  assert.doesNotThrow(() => assertReadOnlySql('select 1'))
  for (const s of ['insert into t values (1)', 'update t set a=1', 'delete from t', 'drop table t', 'select 1; select 2', 'select 1 -- x', 'select * into x from t', 'truncate t', 'grant all on t to anon'])
    assert.throws(() => assertReadOnlySql(s), s)
})
test('secret scanner: names/lines only; jwt role detection', () => {
  const hits = scanSecrets('a\nconst k = "ghp_abcdefghijklmnopqrstuvwxyz0123"\nkey: AIzaSyDUMMYDUMMYDUMMYDUMMYDUMMYDUMMY1')
  assert.deepEqual(hits.map(h => h.line), [2, 3])
  assert.equal(jwtRole(SVC_JWT), 'service_role'); assert.equal(jwtRole(ANON), 'anon')
  const out = C.analyzeBundleText('app.js', `x="${SVC_JWT}"`)
  assert.equal(out[0].severity, 'critical'); assert.ok(!JSON.stringify(out).includes(SVC_JWT))
  assert.equal(C.analyzeBundleText('app.js', `x="${ANON}"`).length, 0) // anon key is public by design
})

// ================================================================ analyzers
test('analyzers flag the right severities', () => {
  const mk = (status: number, text = '{}', h: Record<string, string> = { 'content-type': 'application/json' }) => ({ status, ms: 10, headers: h, text, redirected: h.location })
  assert.equal(C.analyzeApiCase({ name: 'a', path: '/a', kind: 'no_key', probe: mk(200) })[0].severity, 'critical')
  assert.equal(C.analyzeApiCase({ name: 'a', path: '/a', kind: 'invalid_key', probe: mk(200) })[0].id, 'api.auth_bypass')
  assert.equal(C.analyzeApiCase({ name: 'a', path: '/a', kind: 'no_key', probe: mk(401) }).length, 0)
  assert.ok(C.analyzeApiCase({ name: 'a', path: '/a', kind: 'malformed', probe: mk(500, 'at x (/srv/app.js:1:2)') }).some(f => f.id === 'api.trace_leak'))
  assert.equal(C.analyzeRate('/a', { total: 25, statuses: { 200: 25 }, first429: null, hasRetryAfter: false, has5xx: false })[0].id, 'rate.none')
  assert.equal(C.analyzeRate('/a', { total: 25, statuses: { 200: 12, 429: 13 }, first429: 13, hasRetryAfter: true, has5xx: false }).length, 0)
  assert.equal(C.verdict([]), 'pass')
  assert.equal(C.verdict([{ id: 'x', area: 'api', severity: 'high', title: '', evidence: '', fix: '' }]), 'fail')
  assert.equal(C.analyzeProtected('/admin', mk(401)).length, 0)
  assert.equal(C.analyzeProtected('/admin', mk(302, '', { location: '/login' })).length, 0)
  assert.equal(C.analyzeProtected('/admin', mk(200, 'revenue balance payout', { 'content-type': 'text/html' }))[0].id, 'auth.bypass')
  assert.equal(C.analyzeProtected('/admin', mk(200, '<div id=root></div>', { 'content-type': 'text/html' }))[0].severity, 'info')
})

// ================================================================ integration
test('heartbeat renames the placeholder to slot 3 agent', async () => {
  const r = await runAction(ctx(), 'heartbeat')
  assert.equal(r.agent.name, 'QA, Testing & Security Agent')
  assert.equal(db.agents.find(a => a.slot === 3)!.name, 'QA, Testing & Security Agent')
  assert.equal(db.agents.find(a => a.slot === 1)!.name, 'Agent 1')
  assert.equal(r.ready.gemini, true); assert.ok(!JSON.stringify(r).includes(GEMKEY))
})
test('website smoke finds missing viewport + headers, records task/logs/usage', async () => {
  const r = await runAction(ctx(), 'website_smoke', {})
  assert.ok(ids(r).includes('mobile.no_viewport'))
  assert.equal(r.status, 'succeeded')
  assert.equal(db.tasks.length, 1); assert.equal(db.tasks[0].status, 'succeeded')
  assert.ok(db.activity_logs.some(l => l.action === 'agent3_website_smoke_succeeded'))
  assert.ok(db.api_usage.some(u => u.provider === 'target_http'))
})
test('unauthorized target is rejected and never contacted', async () => {
  await assert.rejects(() => runAction(ctx(), 'website_smoke', { target: 'https://evil.com' }), /AGENT3_TARGETS/)
  assert.equal(siteCalls.length, 0); assert.deepEqual(otherHostCalls, [])
})
test('auth check: anonymous admin page is a critical bypass; 401 and redirect are fine', async () => {
  const r = await runAction(ctx(), 'auth_check', {})
  assert.ok(ids(r).includes('auth.bypass'))
  siteInsecure = false
  const ok = await runAction(ctx(), 'auth_check', {})
  assert.ok(!ids(ok).includes('auth.bypass'))
})
test('api test: bypass found; valid key NEVER sent to billing-risk path', async () => {
  const r = await runAction(ctx(), 'api_test', {})
  assert.ok(r.result.findings.some((f: C.Finding) => f.id === 'api.auth_bypass' && /serve/.test(f.target || '')))
  const positives = siteCalls.filter(c => c.headers['x-api-key'] === TESTKEY)
  assert.ok(positives.length > 0, 'valid key used on non-billing path')
  assert.ok(positives.every(c => !isBillingRisk(c.path)), 'valid key leaked to a billing path: ' + positives.map(p => p.path))
  assert.ok(siteCalls.every(c => ['GET', 'POST', 'OPTIONS', 'HEAD'].includes(c.method)))
  assert.ok(r.result.evidence.some((e: any) => /SKIPPED on purpose/.test(e.detail)))
  assert.ok(r.result.findings.some((f: C.Finding) => f.id === 'sec.cors.reflect'))
})
test('api test on a secure site passes', async () => {
  siteInsecure = false
  const r = await runAction(ctx(), 'api_test', {})
  assert.ok(!ids(r).some(i => ['api.auth_bypass', 'api.5xx'].includes(i)), JSON.stringify(ids(r)))
})
test('db test: read-only SQL only; finds RLS off, anon write, isolation, billing integrity, anon leak', async () => {
  const r = await runAction(ctx(), 'db_test', {})
  const f = ids(r)
  for (const id of ['db.rls_off', 'db.anon_write', 'db.billing_read', 'db.isolation', 'bill.duplicates', 'bill.null_ref', 'bill.negative', 'db.anon_leak', 'schema.no_pk']) assert.ok(f.includes(id), id + ' missing: ' + f)
  assert.ok(r.result.findings.find((x: C.Finding) => x.id === 'db.rls_off').severity === 'critical')
  assert.ok(sqlSeen.length >= 5); assert.ok(sqlSeen.every(s => /^\s*(select|with)\b/i.test(s)))
  assert.ok(!JSON.stringify(r).includes('"id":1'), 'row values must not be stored')
  assert.ok(!db.tasks.some(t => JSON.stringify(t).includes(SERVICE)))
})
test('security scan: service_role in bundle, .env exposed, repo secrets, committed .env, dependency advisory', async () => {
  const r = await runAction(ctx(), 'security_scan', {})
  const f = ids(r)
  for (const id of ['sec.service_role_exposed', 'sec.file_exposed', 'sec.env_committed', 'dep.vuln', 'api.auth_bypass', 'sec.header.content-security-policy']) assert.ok(f.includes(id), id + ' missing: ' + f)
  assert.ok(!JSON.stringify(r).includes(SVC_JWT), 'secret value leaked into report')
  assert.ok(!JSON.stringify(db).includes(SVC_JWT), 'secret value leaked into database')
})
test('full report: sections, billing safety statement, AI summary, no secret leakage, no unauthorized hosts', async () => {
  const r = await runAction(ctx(), 'full_report', {})
  assert.equal(r.result.verdict, 'fail')
  assert.equal(r.result.sections.length, 5)
  assert.match(r.result.billing_safety, /No billing event/)
  assert.equal(r.result.ai_summary, 'Verdict: fail. Top: fix auth bypass.')
  const all = JSON.stringify(db)
  for (const s of [SERVICE, GEMKEY, TESTKEY, SVC_JWT, ENV.AGENT3_GITHUB_TOKEN, ENV.AGENT3_SUPABASE_ACCESS_TOKEN]) assert.ok(!all.includes(s), 'leak: ' + s.slice(0, 6))
  assert.deepEqual(otherHostCalls, [])
  assert.ok(!db.activity_logs.some(l => l.level === 'error'))
})
test('full report survives one section failing (no token for GitHub etc.)', async () => {
  const env = { ...ENV }; delete (env as any).AGENT3_SUPABASE_ACCESS_TOKEN; delete (env as any).AGENT3_GITHUB_TOKEN
  const r = await runAction(makeCtx(loadConfig(env), { type: 'user', id: 'user-owner' }), 'full_report', {})
  assert.ok(r.result.not_run.length >= 2)
  assert.equal(r.status, 'succeeded')
})
test('rate test: approval + production ack + single use; detects limiter', async () => {
  const req = await runAction(ctx(), 'request_rate_test', { path: '/api/rated' })
  assert.equal(req.status, 'awaiting_approval'); assert.equal(siteCalls.length, 0)
  const id = req.result.approval_id
  await assert.rejects(() => runAction(ctx(), 'apply_rate_test', { approval_id: id, production_ack: 'APPROVE-PRODUCTION' }), /Not approved/)
  Object.assign(db.approvals.find(a => a.id === id)!, { status: 'approved', decided_at: new Date().toISOString() })
  await assert.rejects(() => runAction(ctx(), 'apply_rate_test', { approval_id: id }), /confirmation/)
  assert.equal(siteCalls.length, 0)
  const run = await runAction(ctx(), 'apply_rate_test', { approval_id: id, production_ack: 'APPROVE-PRODUCTION' })
  assert.equal(siteCalls.length, 25); assert.ok(siteCalls.every(c => c.method === 'GET' && !c.headers['x-api-key']))
  assert.ok(!ids(run).includes('rate.none'))
  await assert.rejects(() => runAction(ctx(), 'apply_rate_test', { approval_id: id, production_ack: 'APPROVE-PRODUCTION' }), /Already executed/)
})
test('rate test without limiter is reported; unauthorized/old approvals rejected', async () => {
  rateLimit = false
  const req = await runAction(ctx(), 'request_rate_test', { path: '/api/rated', requests: 500 })
  assert.equal(db.approvals[0].details.requests, 30) // capped
  Object.assign(db.approvals[0], { status: 'approved', decided_at: new Date(Date.now() - 25 * 3600e3).toISOString() })
  await assert.rejects(() => runAction(ctx(), 'apply_rate_test', { approval_id: req.result.approval_id, production_ack: 'APPROVE-PRODUCTION' }), /older than 24h/)
  Object.assign(db.approvals[0], { decided_at: new Date().toISOString() })
  const run = await runAction(ctx(), 'apply_rate_test', { approval_id: req.result.approval_id, production_ack: 'APPROVE-PRODUCTION' })
  assert.ok(ids(run).includes('rate.none'))
})
test('rate test refuses a non-authorized target stored in an approval', async () => {
  const req = await runAction(ctx(), 'request_rate_test', { path: '/api/rated' })
  db.approvals[0].details.target = 'https://evil.com'
  Object.assign(db.approvals[0], { status: 'approved', decided_at: new Date().toISOString() })
  await assert.rejects(() => runAction(ctx(), 'apply_rate_test', { approval_id: req.result.approval_id, production_ack: 'APPROVE-PRODUCTION' }), /AGENT3_TARGETS/)
  assert.deepEqual(otherHostCalls, [])
})
test('retest shows fixed / still failing / new', async () => {
  const first = await runAction(ctx(), 'website_smoke', {})
  assert.ok(ids(first).includes('mobile.no_viewport'))
  siteInsecure = false
  const re = await runAction(ctx(), 'retest', { task_id: first.task_id })
  assert.ok(re.result.retest.fixed.some((s: string) => /viewport/i.test(s)))
  assert.equal(re.result.retest.verdict_after, 'pass')
  await assert.rejects(() => runAction(ctx(), 'retest', { task_id: '00000000-0000-4000-8000-000000009999' }), /cannot be retested/)
})
test('ai command: picks one read-only test; refuses payments/writes; ignores foreign target', async () => {
  planReply = JSON.stringify({ intent: 'website_smoke', explanation: 'site check', target: 'https://evil.com' })
  const r = await runAction(ctx(), 'ai_command', { text: 'site check karo' })
  assert.equal(r.understood.intent, 'website_smoke'); assert.ok(siteCalls.length > 0); assert.deepEqual(otherHostCalls, [])
  planReply = JSON.stringify({ intent: 'make_payout', explanation: 'no', target: null })
  const bad = await runAction(ctx(), 'ai_command', { text: 'payout karo' })
  assert.equal(bad.result.unsupported, true)
  planReply = 'not json'
  await assert.rejects(() => runAction(ctx(), 'ai_command', { text: 'x' }), /unreadable/)
})
test('no target configured: rejected before any task or call', async () => {
  const env = { ...ENV, AGENT3_TARGETS: '' }
  await assert.rejects(() => runAction(makeCtx(loadConfig(env), { type: 'user', id: 'u' }), 'website_smoke', {}))
  assert.equal((db.tasks || []).length, 0); assert.equal(siteCalls.length, 0)
})
test('failed run is logged and redacted; agent goes to error', async () => {
  const env = { ...ENV, AGENT3_SUPABASE_ACCESS_TOKEN: 'sbp_wrongwrongwrongwrong' }
  await assert.rejects(() => runAction(makeCtx(loadConfig(env), { type: 'user', id: 'u' }), 'db_test', {}), /token invalid/)
  assert.equal(db.tasks[0].status, 'failed')
  assert.equal(db.agents.find(a => a.slot === 3)!.status, 'error')
  assert.ok(db.activity_logs.some(l => l.level === 'error'))
  assert.ok(!JSON.stringify(db).includes('sbp_wrongwrongwrongwrong'))
})

test('termux queue: dashboard queues, worker runs it on the SAME task, no duplicate', async () => {
  const q = await runAction(ctx(), 'queue_task', { task: 'website_smoke' })
  assert.equal(q.status, 'queued'); assert.equal(siteCalls.length, 0)
  assert.equal(db.tasks.length, 1); assert.equal(db.tasks[0].status, 'queued')
  const n = await workOnce(loadConfig(ENV))
  assert.equal(n, 1); assert.equal(db.tasks.length, 1)
  assert.equal(db.tasks[0].status, 'succeeded'); assert.ok(db.tasks[0].result.findings.length > 0)
  assert.equal(await workOnce(loadConfig(ENV)), 0)
})
test('termux queue: only the six read-only tests; foreign targets and foreign queue rows are refused', async () => {
  await assert.rejects(() => runAction(ctx(), 'queue_task', { task: 'apply_rate_test' }), /cannot be queued/)
  await assert.rejects(() => runAction(ctx(), 'queue_task', { task: 'website_smoke', target: 'https://evil.com' }), /AGENT3_TARGETS/)
  await runAction(ctx(), 'heartbeat')
  const aid = db.agents.find(a => a.slot === 3)!.id
  db.tasks = [
    { id: uuid(), agent_id: aid, status: 'queued', payload: { action: 'apply_rate_test', runner: 'termux' } },
    { id: uuid(), agent_id: aid, status: 'queued', payload: { action: 'website_smoke', target: 'https://evil.com', runner: 'termux' } },
    { id: uuid(), agent_id: aid, status: 'queued', payload: { action: 'website_smoke', target: SITE } }
  ]
  const n = await workOnce(loadConfig(ENV))
  assert.equal(n, 1)
  assert.equal(db.tasks[0].status, 'queued'); assert.equal(db.tasks[2].status, 'queued')
  assert.equal(db.tasks[1].status, 'failed'); assert.match(db.tasks[1].error_message, /AGENT3_TARGETS/)
  assert.deepEqual(otherHostCalls, [])
})

// ================================================================ Termux local checks
let execCalls: string[]
const fakeExec: ExecFn = async (bin, args) => {
  const line = [bin, ...args].join(' '); execCalls.push(line)
  const ok = (out: string, code = 0) => ({ code, out, ms: 5, timedOut: false })
  if (line === 'npm test') return ok('# tests 85\n# pass 85\n# fail 0\n')
  if (line === 'npm run build') return ok('built')
  if (line.startsWith('npm audit')) return ok(JSON.stringify({ metadata: { vulnerabilities: { low: 0, moderate: 1, high: 1, critical: 0 } } }), 1)
  if (line.includes('status -sb')) return ok('## main...origin/main [ahead 1]\n M src/a.js\n?? .env.local\n')
  if (line.includes('log --oneline')) return ok('abc123 msg')
  if (line.startsWith('git check-ignore')) return ok('', 1)
  if (line === 'node -v') return ok('v22.1.0'); if (line === 'npm -v') return ok('10.0.0')
  if (line === 'df -h') return ok('/dev/x 100G 40G 60G 40% /'); if (line === 'uname -a') return ok('Linux localhost')
  if (line.startsWith('cat package.json')) return ok('{"a":1}\ntoken = ghp_abcdefghijklmnopqrstuvwxyz0123\n')
  return ok('')
}
const ALLOW = ['ls -la src', 'ls', 'cat package.json', 'head -n 20 README.md', 'tail -n 5 agent3/agent.ts', 'wc -l package.json', 'grep -rn TODO src', 'grep -rni "service role" agent3', 'find src -name "*.jsx" -type f', 'find . -maxdepth 2 -type d', 'du -sh src', 'df -h', 'pwd', 'date', 'uname -a', 'node -v', 'npm -v', 'npm test', 'npm run build', 'npm audit --json', 'npm ls --depth=0', 'npm outdated', 'git status -sb', 'git log --oneline -n 5', 'git diff --stat', 'git branch -a', 'git ls-files', 'git show --stat HEAD']
const DENY = ['rm -rf src', 'cat .env.agent3', 'cat .env', 'cat ../x', 'cat /etc/passwd', 'ls /data/data', 'ls ~', 'node -e "1"', 'node x.js', 'git push', 'git commit -m x', 'git remote -v', 'git diff', 'git log -n 500', 'git checkout main', 'npm install', 'npm run agent3', 'npm publish', 'curl http://x.com', 'wget x', 'sh -c ls', 'bash', 'ls; rm x', 'ls | cat', 'ls > f', 'cat $(ls)', 'echo `ls`', 'find . -exec rm {} +', 'find . -delete', 'find . -ok ls', 'grep -r x ..', 'grep -rn password .env', 'cat package.json .env.local', 'ls .git', 'cat .git/config', 'cat id_rsa', 'cat key.pem', 'head -n 99999 x', 'chmod 777 x', 'mv a b', 'cp a b', 'tee x', 'sed -i x y', 'python -c 1', 'ls -la\nrm x', '', 'grep TODO', "ls 'a'", 'cat .agent3/x', 'cat secrets.txt', 'git status && ls']
test('custom command guard: allow-list accepts safe reads only', () => {
  for (const c of ALLOW) assert.doesNotThrow(() => parseCommand(c), c)
  for (const c of DENY) assert.throws(() => parseCommand(c), /not allowed/, JSON.stringify(c))
  assert.throws(() => parseCommand(undefined)); assert.ok(ALLOWED_HELP.includes('git'))
  const g = parseCommand('grep -rn TODO src')
  assert.ok(g.args.includes('--exclude=.env*') && g.args.includes('--exclude-dir=.git') && g.args.at(-2) === '--')
  assert.ok(parseCommand('find . -name x').args.includes('-not'))
  assert.deepEqual(parseCommand('git log').args, ['--no-pager', 'log', '-n', '20'])
})
test('maskSecrets hides tokens in command output', () => {
  const m = maskSecrets(`a ghp_abcdefghijklmnopqrstuvwxyz0123 b ${SVC_JWT} c api_key = "abcdefghijklmnopqrstuvwx" ok`)
  assert.ok(!m.includes('ghp_abc') && !m.includes('eyJ') && !m.includes('abcdefghijklmnopqrstuvwx')); assert.ok(m.includes('[REDACTED]') && m.endsWith('ok'))
})
test('local analyzers', () => {
  assert.equal(analyzeTests(0, '# pass 5\n# fail 0').length, 0)
  assert.match(analyzeTests(1, '# pass 4\n# fail 1\nnot ok 3 - bad thing')[0].evidence, /bad thing/)
  assert.equal(analyzeBuild(0, '').length, 0); assert.equal(analyzeBuild(1, 'x\nError: boom')[0].severity, 'high')
  assert.deepEqual(analyzeAudit(JSON.stringify({ metadata: { vulnerabilities: { low: 1, moderate: 0, high: 2, critical: 0 } } })).map(f => f.severity), ['high', 'low'])
  assert.equal(analyzeAudit('garbage')[0].severity, 'info')
  assert.equal(analyzeGit(0, '## main\n', 1)[0].id, 'local.env_not_ignored')
  assert.ok(analyzeGit(0, '## main\n?? .env.local\n', 0).some(f => f.id === 'local.env_untracked' && f.severity === 'critical'))
  assert.equal(analyzeGit(0, '## main\n?? .env.example\n', 0).filter(f => f.severity === 'critical').length, 0)
  assert.equal(analyzeGit(128, 'fatal', 128)[0].id, 'local.not_git')
  const e = analyzeEnv({ SUPABASE_URL: 'x', AGENT3_API_ENDPOINTS: '{bad' })
  assert.ok(e.f.some(f => f.id === 'local.env_missing') && e.f.some(f => f.id === 'local.env_json'))
  assert.ok(!JSON.stringify(analyzeEnv({ SUPABASE_URL: 'sekret-value-123' })).includes('sekret-value-123'))
})
test('local secret scan: finds service_role, skips env files and node_modules, never prints values', () => {
  const d = mkdtempSync(join(tmpdir(), 'qa-')); mkdirSync(join(d, 'node_modules')); mkdirSync(join(d, 'src'))
  writeFileSync(join(d, 'src', 'a.js'), `const k = "${SVC_JWT}"`)
  writeFileSync(join(d, '.env.agent3'), `KEY=${SVC_JWT}`)
  writeFileSync(join(d, 'node_modules', 'x.js'), `const k = "${SVC_JWT}"`)
  writeFileSync(join(d, 'src', 'ok.js'), `const a = "${ANON}"`)
  const r = scanLocalSecrets(d)
  assert.equal(r.f.length, 1); assert.equal(r.f[0].severity, 'critical'); assert.match(r.f[0].target!, /a\.js$/); assert.ok(!JSON.stringify(r).includes(SVC_JWT)); assert.equal(r.files, 2)
})
test('runLocal presets with a fake phone', async () => {
  execCalls = []
  const r = await runLocal(['tests', 'build', 'audit', 'git', 'system', 'env'], fakeExec, process.cwd(), { SUPABASE_URL: 'u' })
  const f = r.findings.map(x => x.id)
  for (const id of ['local.audit_high', 'local.audit_moderate', 'local.env_not_ignored', 'local.env_untracked', 'local.dirty', 'local.git_sync', 'local.env_missing']) assert.ok(f.includes(id), id + ': ' + f)
  assert.ok(!f.includes('local.tests_failed')); assert.ok(execCalls.includes('npm test') && execCalls.includes('node -v'))
  assert.ok(r.commands.length >= 9); assert.ok(r.evidence.find(e => e.check === 'npm test')!.ok)
})
test('runOne really runs a harmless command (no shell)', async () => {
  const r = await runOne(parseCommand('node -v'), realExec, process.cwd())
  assert.equal(r.code, 0); assert.match(r.output, /^v\d+/)
})
test('termux checks: dashboard queues, Vercel refuses to run them, worker runs on the same task', async () => {
  execCalls = []
  const q = await runAction(ctx(), 'queue_local', { presets: ['tests', 'git', 'bogus'] })
  assert.equal(q.status, 'queued'); assert.deepEqual(db.tasks[0].payload.presets, ['tests', 'git']); assert.equal(execCalls.length, 0)
  await assert.rejects(() => runAction(ctx(), 'local_check', { presets: ['tests'] }), /inside Termux|only runs/)
  await assert.rejects(() => runAction(ctx(), 'queue_local', { presets: ['rm -rf'] }), /at least one/)
  assert.equal(await workOnce(loadConfig(ENV), { type: 'system', id: null }, () => {}, fakeExec), 1)
  assert.equal(db.tasks.length, 1); assert.equal(db.tasks[0].status, 'succeeded')
  assert.ok(db.tasks[0].result.commands.length > 0); assert.equal(db.tasks[0].result.title, 'Termux checks')
  assert.ok(execCalls.includes('npm test'))
})
test('termux custom command: approval -> queue -> worker, single use, dangerous commands refused up front', async () => {
  execCalls = []
  await assert.rejects(() => runAction(ctx(), 'request_local_command', { command: 'cat .env.agent3' }), /not allowed/)
  await assert.rejects(() => runAction(ctx(), 'request_local_command', { command: 'rm -rf /' }), /not allowed/)
  assert.equal((db.approvals || []).length, 0)
  const req = await runAction(ctx(), 'request_local_command', { command: 'cat package.json' })
  assert.equal(req.status, 'awaiting_approval'); const id = req.result.approval_id
  await assert.rejects(() => runAction(ctx(), 'queue_local_command', { approval_id: id }), /Not approved/)
  Object.assign(db.approvals.find(a => a.id === id)!, { status: 'approved', decided_at: new Date().toISOString() })
  const q = await runAction(ctx(), 'queue_local_command', { approval_id: id })
  assert.equal(q.status, 'queued'); assert.equal(execCalls.length, 0)
  await assert.rejects(() => runAction(ctx(), 'queue_local_command', { approval_id: id }), /Already queued/)
  assert.equal(await workOnce(loadConfig(ENV), { type: 'system', id: null }, () => {}, fakeExec), 1)
  const done = db.tasks.find(t => t.id === q.task_id)!
  assert.equal(done.status, 'succeeded'); assert.deepEqual(execCalls, ['cat package.json'])
  assert.ok(!JSON.stringify(done.result).includes('ghp_abc'), 'token in output must be masked')
  assert.ok(db.approvals.find(a => a.id === id)!.details.ran_at)
  assert.equal(await workOnce(loadConfig(ENV), { type: 'system', id: null }, () => {}, fakeExec), 0)
})
test('termux custom command: tampered queue rows never execute', async () => {
  execCalls = []
  await runAction(ctx(), 'heartbeat')
  const aid = db.agents.find(a => a.slot === 3)!.id
  const ap = { id: uuid(), status: 'pending', details: { kind: 'local_command', command: 'cat package.json' } }
  const ap2 = { id: uuid(), status: 'approved', decided_at: new Date().toISOString(), details: { kind: 'local_command', command: 'rm -rf src', executed_at: new Date().toISOString() } }
  db.approvals = [ap, ap2]
  db.tasks = [
    { id: uuid(), agent_id: aid, status: 'queued', payload: { action: 'local_command', approval_id: ap.id, runner: 'termux' } },
    { id: uuid(), agent_id: aid, status: 'queued', payload: { action: 'local_command', approval_id: ap2.id, runner: 'termux' } },
    { id: uuid(), agent_id: aid, status: 'queued', payload: { action: 'local_command', approval_id: uuid(), runner: 'termux' } }
  ]
  await workOnce(loadConfig(ENV), { type: 'system', id: null }, () => {}, fakeExec)
  assert.deepEqual(execCalls, []); assert.ok(db.tasks.every(t => t.status === 'failed'), JSON.stringify(db.tasks.map(t => t.status)))
})

// ================================================================ server
test('server: auth, owner check, method', async () => {
  assert.equal((await handleRequest({ method: 'GET', headers: {} }, ENV)).status, 405)
  assert.equal((await handleRequest({ method: 'POST', headers: {}, body: {} }, ENV)).status, 401)
  assert.equal((await handleRequest({ method: 'POST', headers: { authorization: 'Bearer nope' }, body: {} }, ENV)).status, 401)
  assert.equal((await handleRequest({ method: 'POST', headers: { authorization: 'Bearer tok-other' }, body: { action: 'heartbeat' } }, ENV)).status, 403)
  assert.equal((await handleRequest({ method: 'POST', headers: { authorization: 'Bearer tok-owner' }, body: { action: 'delete_everything' } }, ENV)).status, 400)
  const ok = await handleRequest({ method: 'POST', headers: { authorization: 'Bearer tok-owner' }, body: { action: 'heartbeat' } }, ENV)
  assert.equal(ok.status, 200)
  assert.equal((await handleRequest({ method: 'POST', headers: { authorization: 'Bearer tok-owner' }, body: { action: 'heartbeat' } }, {})).status, 500)
})
test('redact removes secrets', () => {
  const r = redact({ a: 'x ' + SERVICE + ' y', token: 'abc', n: [GEMKEY] }, [SERVICE])
  assert.ok(!JSON.stringify(r).includes(SERVICE)); assert.ok(!JSON.stringify(r).includes(GEMKEY))
})


// ================================================================ dynamic GitHub branch selection
const RELSHA = 'b'.repeat(40)
const sel = (extra: any = {}) => ({ repo: 'me/site', branch: 'release/1.0', branch_sha: RELSHA, branch_context_required: true, ...extra })
test('branches: Agent 3 lists real branches (default flagged, "/" names, paginated); other repos refused', async () => {
  for (let i = 0; i < 120; i++) a3Refs['t/' + i] = 'c'.repeat(40)
  const r: any = await handleRequest({ method: 'POST', headers: { authorization: 'Bearer tok-owner' }, body: { action: 'github_branches', params: { repo: 'me/site' } } }, ENV)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const b = r.body.result.branches
  assert.equal(b.length, 122); assert.deepEqual(b.filter((x: any) => x.default).map((x: any) => x.name), ['main']); assert.ok(b.some((x: any) => x.name === 'release/1.0'))
  const bad: any = await handleRequest({ method: 'POST', headers: { authorization: 'Bearer tok-owner' }, body: { action: 'github_branches', params: { repo: 'evil/x' } } }, ENV)
  assert.equal(bad.status, 403)
})
test('security scan tests the SELECTED branch code (not the default branch) and reports repo/branch/SHA', async () => {
  filesBySha[RELSHA] = { 'package.json': '{"name":"x","dependencies":{}}', 'src/a.js': 'export const ok = 1', 'README.md': 'hi' } // clean release branch
  const rel = await runAction(ctx(), 'security_scan', sel())
  assert.ok(!ids(rel).includes('sec.env_committed'), 'release branch has no .env: ' + ids(rel))
  assert.match(JSON.stringify(rel.result.evidence), /3 file\(s\) scanned, 0 hit\(s\), 0 committed \.env/)
  assert.equal(rel.result.repo, 'me/site'); assert.equal(rel.result.branch, 'release/1.0'); assert.equal(rel.result.branch_sha, RELSHA)
  assert.ok(a3Queries.some(q => q.includes('/git/trees/' + RELSHA)) && a3Queries.some(q => q.includes('ref=' + RELSHA)))
  assert.ok(!a3Queries.some(q => q.includes('/git/trees/main')))
  const def = await runAction(ctx(), 'security_scan', {}) // default branch still has the problems -> proves the two runs differ
  assert.ok(ids(def).includes('sec.env_committed'))
})
test('full report: branch context in report and task payload; a clean branch gives a different repo section', async () => {
  filesBySha[RELSHA] = { 'package.json': '{"name":"x"}', 'src/a.js': 'export const ok = 1' }
  const r = await runAction(ctx(), 'full_report', sel())
  assert.equal(r.result.branch, 'release/1.0'); assert.equal(r.result.branch_sha, RELSHA); assert.equal(r.result.repo, 'me/site')
  const t = db.tasks.find((x: any) => x.payload.action === 'full_report')!
  assert.equal(t.payload.branch, 'release/1.0'); assert.equal(t.payload.branch_sha, RELSHA)
})
test('deleted / moved / missing branch fails the whole run - no fallback to default', async () => {
  delete a3Refs['release/1.0']
  await assert.rejects(() => runAction(ctx(), 'security_scan', sel()), (e: any) => e.status === 404 && e.code === 'branch_not_found')
  await assert.rejects(() => runAction(ctx(), 'full_report', sel()), (e: any) => e.status === 404)
  a3Refs['release/1.0'] = 'd'.repeat(40)
  await assert.rejects(() => runAction(ctx(), 'security_scan', sel()), (e: any) => e.status === 409 && e.code === 'base_changed')
  await assert.rejects(() => runAction(ctx(), 'full_report', { repo: 'me/site', branch_context_required: true }), (e: any) => e.status === 400 && e.code === 'branch_required')
  await assert.rejects(() => runAction(ctx(), 'security_scan', sel({ repo: 'evil/x' })), (e: any) => e.status === 403)
  assert.ok(!a3Queries.some(q => q.includes('/git/trees/main')))
})
test('regression retest re-runs against the SAME branch (never the default) and re-resolves its current head', async () => {
  filesBySha[RELSHA] = { 'package.json': '{"name":"x"}', 'src/a.js': 'export const ok = 1' }
  await runAction(ctx(), 'security_scan', sel())
  const t = db.tasks.find((x: any) => x.payload.action === 'security_scan')!
  a3Queries = []; a3Refs['release/1.0'] = 'f'.repeat(40); filesBySha['f'.repeat(40)] = { 'package.json': '{"name":"x"}', 'src/a.js': 'export const ok = 2' } // branch moved since
  const rt = await runAction(ctx(), 'retest', { task_id: t.id })
  assert.equal(rt.result.retest.branch, 'release/1.0'); assert.equal(rt.result.retest.previous_branch_sha, RELSHA); assert.equal(rt.result.retest.branch_sha, 'f'.repeat(40))
  assert.ok(a3Queries.some(q => q.includes('/git/trees/' + 'f'.repeat(40))) && !a3Queries.some(q => q.includes('/git/trees/main')))
})


// ================================================================ STRICT branch selection (Agent 3: repo tree/file scans never use the default branch)
test('STRICT: tree()/file() of the GitHub client never choose a branch themselves', async () => {
  const { GitHub } = await import('./github.js')
  const gh = new GitHub(loadConfig(ENV), {})
  await assert.rejects(() => gh.tree('me/site', ''), (e: any) => e.status === 400 && e.code === 'branch_required')
  await assert.rejects(() => gh.file('me/site', 'package.json'), (e: any) => e.status === 400 && e.code === 'branch_required')
})
test('STRICT: dashboard scans need repo AND branch; a scan without them never reads the default branch', async () => {
  await assert.rejects(() => runAction(ctx(), 'security_scan', { repo: 'me/site', branch_context_required: true }), (e: any) => e.code === 'branch_required')
  await assert.rejects(() => runAction(ctx(), 'full_report', { branch: 'release/1.0', branch_sha: RELSHA, branch_context_required: true }), (e: any) => e.status === 400 && e.code === 'repo_required')
  assert.ok(!a3Queries.some(q => q.includes('/git/trees/')), a3Queries.join('|'))
})
test('STRICT: ai_command runs a repo scan ONLY on the owner\'s selected branch; without a selection it is refused (no default-branch scan)', async () => {
  filesBySha[RELSHA] = { 'package.json': '{"name":"x"}', 'src/a.js': 'export const ok = 1' }
  planReply = JSON.stringify({ intent: 'security_scan', explanation: 'scan' })
  await assert.rejects(() => runAction(ctx(), 'ai_command', { text: 'security check chalao' }), (e: any) => e.status === 400 && e.code === 'branch_required')
  assert.ok(!a3Queries.some(q => q.includes('/git/trees/')))
  const r: any = await runAction(ctx(), 'ai_command', { text: 'security check chalao', ...sel() })
  assert.equal(r.result.branch, 'release/1.0'); assert.equal(r.result.branch_sha, RELSHA)
  assert.ok(a3Queries.some(q => q.includes('/git/trees/' + RELSHA)) && !a3Queries.some(q => q.includes('/git/trees/main')))
  // a purely live-site test never needs a branch
  planReply = JSON.stringify({ intent: 'website_smoke', explanation: 'site' })
  assert.ok((await runAction(ctx(), 'ai_command', { text: 'site check karo' })).result)
})
test('STRICT: Termux queue carries branch + SHA for repo scans; the phone re-pins it; a moved branch fails the queued task instead of scanning another one', async () => {
  filesBySha[RELSHA] = { 'package.json': '{"name":"x"}', 'src/a.js': 'export const ok = 1' }
  await assert.rejects(() => runAction(ctx(), 'queue_task', { task: 'security_scan', repo: 'me/site', branch_context_required: true }), (e: any) => e.code === 'branch_required')
  assert.equal((db.tasks || []).length, 0)
  const q: any = await runAction(ctx(), 'queue_task', { task: 'security_scan', ...sel() })
  assert.equal(q.status, 'queued')
  const row = db.tasks.find((x: any) => x.payload.runner === 'termux')!
  assert.equal(row.payload.branch, 'release/1.0'); assert.equal(row.payload.branch_sha, RELSHA); assert.equal(row.payload.branch_context_required, true)
  a3Queries = []; assert.equal(await workOnce(loadConfig(ENV)), 1)
  assert.equal(row.status, 'succeeded'); assert.equal(row.result.branch, 'release/1.0')
  assert.ok(a3Queries.some(q2 => q2.includes('/git/trees/' + RELSHA)) && !a3Queries.some(q2 => q2.includes('/git/trees/main')))
  // queued, then the branch moves before the phone runs it
  const q2: any = await runAction(ctx(), 'queue_task', { task: 'full_report', ...sel() })
  a3Refs['release/1.0'] = 'd'.repeat(40); a3Queries = []
  await workOnce(loadConfig(ENV))
  const row2 = db.tasks.find((x: any) => x.id === q2.task_id)!
  assert.equal(row2.status, 'failed'); assert.match(String(row2.error_message), /moved/i)
  assert.ok(!a3Queries.some(q3 => q3.includes('/git/trees/')))
})
test('STRICT: retest of a repo scan that has no recorded branch is refused instead of scanning the default branch', async () => {
  await runAction(ctx(), 'security_scan', {}) // legacy scan, no branch recorded
  const t = db.tasks.find((x: any) => x.payload.action === 'security_scan')!
  a3Queries = []
  await assert.rejects(() => runAction(ctx(), 'retest', { task_id: t.id }), (e: any) => e.status === 400 && e.code === 'branch_required')
  assert.ok(!a3Queries.some(q => q.includes('/git/trees/')))
})


test('Agent 3 fixed Ads routes check uses only production whitelist and invalid credentials/ref', async () => {
  const r = await runAction(ctx(), 'ads_routes_check', {})
  assert.equal(r.result.verdict, 'PASS')
  assert.deepEqual(siteCalls.map(c => [c.method, c.path.split('?')[0]]), [
    ['POST', '/api/v1/ads/impression'], ['GET', '/api/v1/ads/click']
  ])
  assert.ok(siteCalls.every(c => !c.headers.authorization && !c.headers['x-api-key']))
  for (const route of ['/api/v1/ads/impression', '/api/v1/ads/click']) assert.ok(siteCalls.filter(c => c.path.startsWith(route)).length <= 4, 'route request cap exceeded')
  assert.ok(r.result.evidence.every((e: any) => /status \d+; time /.test(e.detail)))
  assert.equal(r.result.rate_limit, 'NOT TESTED (no burst requests sent)')
  assert.deepEqual(otherHostCalls, [])
})
test('Agent 3 Match route checks only exact production route', async () => {
  const r = await runAction(ctx(), 'match_route_check', {})
  assert.equal(r.result.verdict, 'PASS')
  assert.deepEqual(siteCalls.map(c => [c.method, c.path]), [['POST', '/api/v1/ads/match']])
  assert.ok(!siteCalls[0].headers.authorization && !siteCalls[0].headers['x-api-key'])
})
test('Agent 3 route whitelist rejects any route outside the 3 allowed ones (no request sent)', () => {
  const bad: [string, string][] = [
    ['POST', 'https://blisscco.online/api/v1/ads/payout'], ['GET', 'https://blisscco.online/api/v1/ads/impression'],
    ['POST', 'https://blisscco.online/api/v1/ads/match?x=1'], ['GET', 'https://blisscco.online/api/v1/ads/click?ref=REAL_REF'],
    ['GET', 'https://blisscco.online/api/v1/ads/click'], ['DELETE', 'https://blisscco.online/api/v1/ads/match'],
    ['POST', 'https://preview-abc.vercel.app/api/v1/ads/match'], ['POST', 'https://staging.blisscco.online/api/v1/ads/match'],
    ['POST', 'http://blisscco.online/api/v1/ads/match'], ['POST', 'https://blisscco.online@evil.example/api/v1/ads/match'], ['POST', 'not a url']
  ]
  for (const [m, u] of bad) assert.throws(() => assertRouteAllowed(m, u), (e: any) => e.code === 'route_blocked', m + ' ' + u)
  assert.equal(assertRouteAllowed('POST', 'https://blisscco.online/api/v1/ads/impression'), '/api/v1/ads/impression')
  assert.equal(assertRouteAllowed('get', 'https://blisscco.online/api/v1/ads/click?ref=invalid_qa_ref'), '/api/v1/ads/click')
  assert.equal(assertRouteAllowed('POST', 'https://blisscco.online/api/v1/ads/match'), '/api/v1/ads/match')
})
test('Agent 3 enforces max 4 requests per route per run and a hard burst cap of 40', () => {
  const counts: Record<string, number> = {}
  for (let i = 0; i < MAX_REQUESTS_PER_ROUTE; i++) assertRouteBudget(counts, 'POST', '/api/v1/ads/match')
  assert.throws(() => assertRouteBudget(counts, 'POST', '/api/v1/ads/match'), (e: any) => e.code === 'route_budget')
  assert.equal(MAX_REQUESTS_PER_ROUTE, 4)
  assert.equal(hardBurstCap(1000), 40); assert.equal(hardBurstCap(30), 30); assert.equal(hardBurstCap(-5), 0); assert.equal(hardBurstCap('x'), 0)
})
test('Agent 3 route check ignores caller path/host input and only ever calls the fixed routes', async () => {
  const r = await runAction(ctx(), 'ads_routes_check', { path: '/api/v1/ads/payout', target: 'https://evil.example' })
  assert.equal(r.result.verdict, 'PASS')
  assert.deepEqual(siteCalls.map(c => c.path.split('?')[0]), ['/api/v1/ads/impression', '/api/v1/ads/click'])
  assert.deepEqual(otherHostCalls, [])
})
test('Agent 3 route check immediately FAILS and stops on 200 or 302', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const u = new URL(String(input))
    if (u.origin === 'https://blisscco.online') return new Response('{}', { status: 200 })
    return fake(input, init)
  }) as any
  try {
    const r = await runAction(ctx(), 'ads_routes_check', {})
    assert.equal(r.result.verdict, 'FAIL')
    assert.equal(r.result.evidence.length, 1)
    assert.equal(r.result.findings[0].severity, 'critical')
  } finally { globalThis.fetch = original }
})
test('Agent 3 unsupported AI task is BLOCKED, never swapped for another check, and is logged', async () => {
  // Planner wrongly maps a firewall request to security_scan: the task text has no security words -> BLOCKED, nothing runs.
  planReply = JSON.stringify({ intent: 'security_scan', explanation: 'x', target: null })
  const r = await runAction(ctx(), 'ai_command', { text: 'check firewall waf rules on production' })
  assert.equal(r.status, 'blocked')
  assert.equal(r.result.verdict, 'BLOCKED')
  assert.equal(r.result.reason, 'unsupported check')
  assert.equal(r.understood.intent, 'unsupported check')
  assert.ok(Array.isArray(r.result.supported_checks) && r.result.supported_checks.length >= 8)
  assert.match(r.result.message, /Supported checks:/)
  assert.equal(siteCalls.length, 0)
  assert.ok(db.activity_logs.some(l => l.action === 'agent3_ai_command_blocked'))
  planReply = JSON.stringify({ intent: 'make_payout', explanation: 'no', target: null })
  assert.equal((await runAction(ctx(), 'ai_command', { text: 'payout karo' })).result.verdict, 'BLOCKED')
  assert.equal(siteCalls.length, 0)
})
test('Agent 3 "rate limit" / "429" text runs the Route Check only (no burst)', async () => {
  const r = await runAction(ctx(), 'ai_command', { text: 'check production firewall config and rate limit rules' })
  assert.equal(r.result.verdict, 'PASS'); assert.equal(siteCalls.length, 2)
  assert.match(r.result.rate_limit, /^NOT TESTED/)
  assert.equal((db.approvals || []).length, 0)
})
test('Agent 3 match route text is routed deterministically', async () => {
  const r = await runAction(ctx(), 'ai_command', { text: 'test /api/v1/ads/match route' })
  assert.match(r.understood.intent, /Match route/); assert.deepEqual(siteCalls.map(c => c.path), ['/api/v1/ads/match'])
})
test('Agent 3 records 429 / Retry-After as rate-limit evidence and FAILs (unexpected status)', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init: any = {}) => new URL(String(input)).origin === 'https://blisscco.online'
    ? new Response('{}', { status: 429, headers: { 'retry-after': '30' } }) : fake(input, init)) as any
  try {
    const r = await runAction(ctx(), 'match_route_check', {})
    assert.equal(r.result.verdict, 'FAIL')
    assert.match(r.result.evidence[0].detail, /status 429; time .*Retry-After 30/)
    assert.match(r.result.rate_limit, /429.*Retry-After 30/)
  } finally { globalThis.fetch = original }
})
test('Agent 3 verdict: an unexpected status is FAIL even if a later route is unreachable', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const u = new URL(String(input))
    if (u.origin !== 'https://blisscco.online') return fake(input, init)
    if (u.pathname.endsWith('/impression')) return new Response('{}', { status: 500 })
    throw new Error('network down')
  }) as any
  try {
    const r = await runAction(ctx(), 'ads_routes_check', {})
    assert.equal(r.result.verdict, 'FAIL'); assert.equal(r.result.evidence.length, 2)
  } finally { globalThis.fetch = original }
})
test('Agent 3 impression/click/rate-limit intent bypasses AI and routes deterministically', async () => {
  const r = await runAction(ctx(), 'ai_command', { text: 'O2 impression/click rate-limit check' })
  assert.equal(r.result.verdict, 'PASS')
  assert.match(r.understood.intent, /Ads routes/)
  assert.equal(siteCalls.length, 2)
})
test('Agent 3 route check never exposes configured secrets', async () => {
  const r = await runAction(ctx(), 'ads_routes_check', {})
  const out = JSON.stringify([r, db.tasks, db.activity_logs, db.api_usage])
  for (const secret of [SERVICE, GEMKEY, TESTKEY, ENV.AGENT3_GITHUB_TOKEN, ENV.AGENT3_SUPABASE_ACCESS_TOKEN]) assert.ok(!out.includes(secret))
  assert.ok(siteCalls.every(c => !c.headers.authorization && !c.headers['x-api-key'] && !c.headers.cookie))
})

test('Agent 3 stops immediately on HTTP 302 as a critical FAIL', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init: any = {}) => new URL(String(input)).origin === 'https://blisscco.online'
    ? new Response(null, { status: 302, headers: { location: '/login' } })
    : fake(input, init)) as any
  try {
    const r = await runAction(ctx(), 'match_route_check', {})
    assert.equal(r.result.verdict, 'FAIL')
    assert.equal(r.result.evidence.length, 1)
    assert.equal(r.result.findings[0].severity, 'critical')
  } finally { globalThis.fetch = original }
})
test('Agent 3 marks unreachable route BLOCKED without retrying', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init: any = {}) => new URL(String(input)).origin === 'https://blisscco.online'
    ? Promise.reject(new Error('network down')) : fake(input, init)) as any
  try {
    const r = await runAction(ctx(), 'match_route_check', {})
    assert.equal(r.result.verdict, 'BLOCKED')
    assert.equal(r.result.evidence.length, 1)
  } finally { globalThis.fetch = original }
})

// ---------------------------------------------------------------- Rate-limit burst (ads impression + click)
async function approvedBurst(requests?: number) {
  const req = await runAction(ctx(), 'request_ads_burst', { enabled: true, ...(requests === undefined ? {} : { requests }) })
  Object.assign(db.approvals.find(a => a.id === req.result.approval_id)!, { status: 'approved', decided_at: new Date().toISOString() })
  return req.result.approval_id as string
}
const ACK = { production_ack: 'APPROVE-PRODUCTION' }
function limitAt(n: number | null, status = 429, extra: Record<string, string> = { 'retry-after': '30' }) {
  let c = 0; const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const u = new URL(String(input))
    if (u.origin === 'https://blisscco.online' && n && ++c >= n) {
      siteCalls.push({ method: String(init.method || 'GET').toUpperCase(), path: u.pathname + u.search, headers: {} })
      return new Response('{}', { status, headers: extra })
    }
    return fake(input, init)
  }) as any
  return () => { globalThis.fetch = original }
}
test('Burst is OFF by default: no request, no approval, no traffic unless explicitly enabled', async () => {
  await assert.rejects(() => runAction(ctx(), 'request_ads_burst', {}), (e: any) => e.code === 'burst_off')
  await assert.rejects(() => runAction(ctx(), 'request_ads_burst', { enabled: false, requests: 10 }), (e: any) => e.code === 'burst_off')
  assert.equal(siteCalls.length, 0); assert.equal((db.approvals || []).length, 0)
})
test('Burst needs approval every run + production ack, is single-use, and request count is capped at 40', async () => {
  const req = await runAction(ctx(), 'request_ads_burst', { enabled: true, requests: 500 })
  assert.equal(req.status, 'awaiting_approval'); assert.equal(siteCalls.length, 0)
  assert.equal(db.approvals[0].details.requests, 40); assert.equal(db.approvals[0].details.kind, 'ads_burst')
  const id = req.result.approval_id
  await assert.rejects(() => runAction(ctx(), 'apply_ads_burst', { approval_id: id, ...ACK }), /Not approved/)
  Object.assign(db.approvals[0], { status: 'approved', decided_at: new Date().toISOString() })
  await assert.rejects(() => runAction(ctx(), 'apply_ads_burst', { approval_id: id }), /confirmation/)
  assert.equal(siteCalls.length, 0)
  const run = await runAction(ctx(), 'apply_ads_burst', { approval_id: id, ...ACK })
  assert.ok(run.result.requests_sent <= 40)
  await assert.rejects(() => runAction(ctx(), 'apply_ads_burst', { approval_id: id, ...ACK }), /Already executed/)
})
test('Burst stops immediately at the first 429 and reports status counts + Retry-After', async () => {
  const id = await approvedBurst(40)
  const restore = limitAt(7)
  try {
    const r = await runAction(ctx(), 'apply_ads_burst', { approval_id: id, ...ACK })
    assert.equal(siteCalls.length, 7)
    assert.deepEqual(r.result.status_counts, { 400: 3, 404: 3, 429: 1 })
    assert.equal(r.result.retry_after, '30'); assert.match(r.result.rate_limit, /429 at request 7.*Retry-After 30/)
    assert.match(r.result.stopped, /first 429/); assert.equal(r.result.verdict, 'PASS')
    assert.ok(r.result.evidence.every((e: any) => /time /.test(e.detail)))
    assert.deepEqual([...new Set(siteCalls.map(c => c.path.split('?')[0]))].sort(), ['/api/v1/ads/click', '/api/v1/ads/impression'])
    assert.ok(siteCalls.every(c => !c.headers.authorization && !c.headers['x-api-key']))
  } finally { restore() }
})
test('Burst never exceeds 40 requests even if the stored approval says more; no 429 -> ATTENTION', async () => {
  const id = await approvedBurst(10)
  db.approvals[0].details.requests = 100000
  const r = await runAction(ctx(), 'apply_ads_burst', { approval_id: id, ...ACK })
  assert.equal(siteCalls.length, 40); assert.equal(r.result.requests_sent, 40)
  assert.deepEqual(r.result.status_counts, { 400: 20, 404: 20 })
  assert.equal(r.result.verdict, 'ATTENTION'); assert.match(r.result.rate_limit, /NOT DETECTED/)
  assert.ok(r.result.findings.some((f: any) => f.id === 'rate.none'))
})
test('Burst stops at once and FAILS (critical) on 200 or 302; 5xx also stops', async () => {
  for (const status of [200, 302, 503]) {
    siteCalls = []; db.approvals = []
    const id = await approvedBurst(40)
    const restore = limitAt(1, status, {})
    try {
      const r = await runAction(ctx(), 'apply_ads_burst', { approval_id: id, ...ACK })
      assert.equal(siteCalls.length, 1, 'status ' + status); assert.equal(r.result.verdict, 'FAIL')
      if (status !== 503) assert.equal(r.result.findings[0].severity, 'critical')
    } finally { restore() }
  }
})
test('Burst refuses a non-production target in the approval and never exposes secrets', async () => {
  const id = await approvedBurst(10)
  db.approvals[0].details.target = 'https://evil.example'
  await assert.rejects(() => runAction(ctx(), 'apply_ads_burst', { approval_id: id, ...ACK }), (e: any) => e.code === 'route_blocked')
  assert.equal(siteCalls.length, 0); assert.deepEqual(otherHostCalls, [])
  siteCalls = []; db.approvals = []; db.tasks = []
  const id2 = await approvedBurst(6)
  const r = await runAction(ctx(), 'apply_ads_burst', { approval_id: id2, ...ACK })
  const out = JSON.stringify([r, db.tasks, db.activity_logs, db.api_usage, db.approvals])
  for (const secret of [SERVICE, GEMKEY, TESTKEY, ENV.AGENT3_GITHUB_TOKEN, ENV.AGENT3_SUPABASE_ACCESS_TOKEN]) assert.ok(!out.includes(secret))
})
