import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from './config.js'
import { assertAuthorizedTarget, assertBillingSafe, assertReadOnlySql, isBillingRisk, scanSecrets, validPath, jwtRole } from './guard.js'
import * as C from './checks.js'
import { redact } from './util.js'
import { handleRequest } from './server.js'
import { makeCtx, runAction } from './agent.js'

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
    if (url.pathname === '/repos/me/site') return json({ default_branch: 'main' })
    if (url.pathname.startsWith('/repos/me/site/git/trees/')) return json({ tree: Object.entries(repoFiles).map(([path, c]) => ({ path, type: 'blob', size: c.length, sha: 'x' })) })
    const m = /^\/repos\/me\/site\/contents\/(.+)$/.exec(url.pathname)
    if (m && repoFiles[decodeURIComponent(m[1])] != null) { const c = repoFiles[decodeURIComponent(m[1])]; return json({ content: Buffer.from(c).toString('base64'), size: c.length }) }
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
