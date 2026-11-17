import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gitBlobSha } from '../agent2/guard.js'
import { handleRequest } from './server.js'
import { deflateRawSync } from 'node:zlib'
import { A1_ALLOWED, A1_SQL_ALLOWED, A2_ALLOWED, ACTIONS, evalCi, readOnlyWithRetry } from './workflow.js'
import { resetHealthCache, retentionSeconds } from './monitor.js'
import { AgentError } from '../agent2/util.js'

const REF = 'abcdref'
const REPO = 'me/blisscco-ai-control-center'
const SERVICE = 'svc_SECRET_KEY_1234567890'
const GH2 = 'ghp_agent2abcdefghijklmnopqrstuvwxyz'
const GH1 = 'ghp_agent1abcdefghijklmnopqrstuvwxyz'
const GEM2 = 'AIzaSyDUMMYDUMMYDUMMYDUMMYDUMMYAGENT2'
const GEM1 = 'AIzaSyDUMMYDUMMYDUMMYDUMMYDUMMYAGENT1'
const VTOKEN = 'vercel_TOKEN_abcdefghijklmnop'
const SBTOKEN = 'sbp_abcdefghijklmnopqrstuvwxyz'
const ANON = 'anon_public_key_value'
const SECRETS = [SERVICE, GH2, GH1, GEM2, GEM1, VTOKEN, SBTOKEN]
const ENV: Record<string, string> = {
  VITE_SUPABASE_URL: `https://${REF}.supabase.co`, VITE_SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE,
  AGENT2_GITHUB_TOKEN: GH2, AGENT2_GITHUB_REPOS: REPO, AGENT2_GEMINI_API_KEY: GEM2,
  AGENT1_GITHUB_TOKEN: GH1, AGENT1_GITHUB_REPOS: REPO, AGENT1_VERCEL_TOKEN: VTOKEN, AGENT1_SUPABASE_ACCESS_TOKEN: SBTOKEN, AGENT1_GEMINI_API_KEY: GEM1
}

type Row = Record<string, any>
let db: Record<string, Row[]>
let seq = 0
const uuid = () => '00000000-0000-4000-8000-' + String(++seq).padStart(12, '0')
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
const b64 = (s: string) => Buffer.from(s).toString('base64')
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex')

interface Commit { tree: string; parents: string[]; message: string }
let refs: Map<string, string>
let commits: Map<string, Commit>
let trees: Map<string, Map<string, { mode: string; sha: string }>>
let blobs: Map<string, string>
let prs: { number: number; head: string; base: string }[]
let runs: any[]
let ghWrites: { method: string; path: string; body?: any }[]
let failNextBlob = false
let fixReply: string
let planReply: string
let dispatches: { id: string; ref: string }[]
let dispatchStatus = 204
let workflowList: any[]
let geminiCalls = 0
const SEED: Record<string, string> = {
  'src/App.jsx': 'export const a = 1\nexport const b = 2\n',
  'package.json': '{"name":"x"}\n',
  '.env.example': 'FOO=\n',
  'README.md': '# hi\n',
  'big.txt': 'x'.repeat(3000) + '\n'
}

function putBlob(text: string) { const s = gitBlobSha(text); blobs.set(s, text); return s }
function putTree(m: Map<string, { mode: string; sha: string }>) {
  const s = sha1(JSON.stringify([...m.entries()].sort()))
  trees.set(s, new Map(m)); return s
}
function putCommit(tree: string, parents: string[], message: string) { const s = sha1(tree + parents.join() + message + seq++); commits.set(s, { tree, parents, message }); return s }

function resetGit() {
  seq = 0; dispatches = []; dispatchStatus = 204; planReply = '{}'; workflowList = [{ id: 11, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }, { id: 12, name: 'DB Integration', path: '.github/workflows/db-integration.yml', state: 'active' }]; ghWrites = []; failNextBlob = false; geminiCalls = 0; prs = []
  fixReply = JSON.stringify({ explanation: 'bump b', files: [{ path: 'src/App.jsx', content: 'export const a = 1\nexport const b = 3\n' }] })
  refs = new Map(); commits = new Map(); trees = new Map(); blobs = new Map()
  const m = new Map<string, { mode: string; sha: string }>()
  for (const [p, c] of Object.entries(SEED)) m.set(p, { mode: '100644', sha: putBlob(c) })
  refs.set('main', putCommit(putTree(m), [], 'init'))
  runs = []
  db = { agents: [1, 2, 3].map(s => ({ id: uuid(), slot: s, name: 'Agent ' + s, description: 'Placeholder - not built yet', status: 'offline', last_heartbeat_at: null, updated_at: new Date().toISOString(), config: {} })), tasks: [], approvals: [], activity_logs: [], api_usage: [], system_health: [], owners: [{ user_id: 'user-owner', role: 'owner' }] }
}

function matches(row: Row, k: string, v: string): boolean {
  if (k.includes('->>')) { const [c, f] = k.split('->>'); const x = row[c] ? row[c][f] : undefined; return v === 'is.null' ? x == null : String(x) === v.replace(/^eq\./, '') }
  if (v.startsWith('eq.')) return String(row[k]) === v.slice(3)
  if (v.startsWith('in.(')) return v.slice(4, -1).split(',').includes(String(row[k]))
  return true
}

function treeOf(sha: string) { return trees.get(commits.get(sha)!.tree)! }

async function gh(method: string, path: string, url: URL, body: any): Promise<Response> {
  const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(path)
  if (!m) return json({ message: 'nope' }, 404)
  if (m[1] !== REPO) return json({ message: 'Not Found' }, 404)
  const p = m[2] || ''
  if (method !== 'GET') ghWrites.push({ method, path: p, body })
  if (p === '') return json({ default_branch: 'main', pushed_at: '2026-11-10', private: true })
  let r: RegExpExecArray | null
  if ((r = /^\/git\/ref\/heads\/(.+)$/.exec(p))) { const s = refs.get(decodeURIComponent(r[1])); return s ? json({ object: { sha: s } }) : json({ message: 'Not Found' }, 404) }
  if ((r = /^\/git\/commits\/([0-9a-f]+)$/.exec(p)) && method === 'GET') { const c = commits.get(r[1]); return c ? json({ tree: { sha: c.tree }, message: c.message, parents: c.parents.map(sha => ({ sha })) }) : json({ message: 'Not Found' }, 404) }
  if ((r = /^\/git\/trees\/([0-9a-f]+)$/.exec(p)) && method === 'GET') { const t = trees.get(r[1]); return t ? json({ truncated: false, tree: [...t.entries()].map(([path, e]) => ({ type: 'blob', path, mode: e.mode, sha: e.sha })) }) : json({}, 404) }
  if ((r = /^\/git\/blobs\/([0-9a-f]+)$/.exec(p)) && method === 'GET') { const t = blobs.get(r[1]); return t != null ? json({ content: b64(t), encoding: 'base64', size: t.length }) : json({}, 404) }
  if (p === '/git/blobs' && method === 'POST') { if (failNextBlob) { failNextBlob = false; return json({ message: 'boom' }, 500) } return json({ sha: putBlob(Buffer.from(body.content, 'base64').toString('utf8')) }, 201) }
  if (p === '/git/trees' && method === 'POST') {
    const base = new Map(trees.get(body.base_tree)!)
    for (const e of body.tree) { if (e.sha === null) base.delete(e.path); else base.set(e.path, { mode: e.mode, sha: e.sha }) }
    return json({ sha: putTree(base) }, 201)
  }
  if (p === '/git/commits' && method === 'POST') return json({ sha: putCommit(body.tree, body.parents, body.message) }, 201)
  if (p === '/git/refs' && method === 'POST') { refs.set(String(body.ref).replace('refs/heads/', ''), body.sha); return json({}, 201) }
  if ((r = /^\/git\/refs\/heads\/(.+)$/.exec(p)) && method === 'PATCH') { assert.equal(body.force, false); refs.set(decodeURIComponent(r[1]), body.sha); return json({}) }
  if ((r = /^\/git\/refs\/heads\/(.+)$/.exec(p)) && method === 'DELETE') { refs.delete(decodeURIComponent(r[1])); return new Response(null, { status: 204 }) }
  if (p.startsWith('/git/matching-refs/heads/agent2/')) return json([...refs.keys()].filter(k => k.startsWith('agent2/')).map(k => ({ ref: 'refs/heads/' + k, object: { sha: refs.get(k) } })))
  if (p === '/actions/workflows') return json({ workflows: workflowList })
  if ((r = /^\/actions\/workflows\/(\d+)\/dispatches$/.exec(p)) && method === 'POST') { if (dispatchStatus !== 204) return json({ message: "Workflow does not have 'workflow_dispatch' trigger" }, dispatchStatus); dispatches.push({ id: r[1], ref: body.ref }); return new Response(null, { status: 204 }) }
  if (p.startsWith('/commits')) return json([{ sha: refs.get('main'), commit: { message: 'init', author: { date: '2026-11-01' } } }])
  if (p.startsWith('/actions/runs') && !p.includes('/jobs')) { const b = url.searchParams.get('branch'); return json({ workflow_runs: runs.filter(x => !b || x.head_branch === b) }) }
  if (p.includes('/actions/runs/') && p.endsWith('/jobs')) return json({ jobs: [{ id: 77, name: 'test-build', conclusion: 'failure', steps: [{ name: 'npm test', conclusion: 'failure' }] }] })
  if (p === '/actions/jobs/77/logs') return new Response([
    '2026-11-17T04:26:00.1000000Z ##[group]Run actions/checkout@v4', '2026-11-17T04:26:01.0000000Z checkout ok', '2026-11-17T04:26:01.5000000Z ##[endgroup]',
    '2026-11-17T04:26:02.0000000Z ##[group]Run npm run build', '2026-11-17T04:26:03.0000000Z > next build', '2026-11-17T04:26:04.0000000Z Error: Cannot find module ./missing (token ghp_abcdefghijklmnopqrstuvwxyz1234)',
    '2026-11-17T04:26:05.0000000Z ##[error]Process completed with exit code 1.', '2026-11-17T04:26:06.0000000Z ##[group]Post job cleanup.', '2026-11-17T04:26:06.5000000Z cleanup noise'
  ].join('\n'), { status: 200, headers: { 'content-type': 'text/plain' } })
  if (p.startsWith('/deployments')) return json(refs.has(String(url.searchParams.get('ref'))) && url.searchParams.get('ref') !== 'main' ? [{ id: 7, environment: 'Preview', created_at: '2026-11-16' }] : [])
  if (p.startsWith('/pulls') && method === 'GET') { const head = (url.searchParams.get('head') || '').split(':')[1]; return json(prs.filter(x => x.head === head).map(x => ({ number: x.number, html_url: 'https://github.com/' + REPO + '/pull/' + x.number }))) }
  if (p === '/pulls' && method === 'POST') { const n = prs.length + 1; prs.push({ number: n, head: body.head, base: body.base }); return json({ number: n, html_url: 'https://github.com/' + REPO + '/pull/' + n }, 201) }
  if ((r = /^\/pulls\/(\d+)\/merge$/.exec(p)) && method === 'PUT') {
    const pr = prs.find(x => x.number === Number(r![1]))!
    const head = refs.get(pr.head)!
    if (body.sha !== head) return json({ message: 'Head branch was modified' }, 409)
    const hc = commits.get(head)!
    const before = treeOf(hc.parents[0]); const after = treeOf(head)
    const merged = new Map(treeOf(refs.get(pr.base)!))
    for (const [k, v] of after) if (before.get(k)?.sha !== v.sha) merged.set(k, v)
    for (const k of before.keys()) if (!after.has(k)) merged.delete(k)
    const s = putCommit(putTree(merged), [refs.get(pr.base)!], 'squash ' + pr.head)
    refs.set(pr.base, s)
    return json({ sha: s, merged: true })
  }
  return json({ message: 'unrouted ' + path }, 404)
}


// ---------------------------------------------------------------- extra fakes: Agent 1 side (Vercel, Supabase management, GitHub read) + bookkeeping
let allUrls: string[]
let a1Calls: string[]
let vercelWrites: string[]
let vDeps: any[]
let failAgent1Db: boolean
let vercelDown: boolean
let consoleOut: string[]
let ciOverride: 'auto' | 'none' | 'running' | 'failing'
let geminiBodies: string[]
let sqlExec: string[]
let sqlWritesAllowed: boolean
let sqlFail: boolean
let sqlFailStatus = 400
let healthStatus: Record<string, number> = {}

function resetAll() {
  resetGit()
  allUrls = []; a1Calls = []; vercelWrites = []; failAgent1Db = false; vercelDown = false; consoleOut = []; ciOverride = 'auto'; geminiBodies = []; sqlExec = []; sqlWritesAllowed = false; sqlFail = false; sqlFailStatus = 400; healthStatus = {}; resetHealthCache()
  vDeps = [{ uid: 'd1', readyState: 'READY', target: 'production', created: Date.now() - 5000, meta: { githubCommitRef: 'main' } }]
}

function agent1Github(path: string) {
  if (path.endsWith('/commits')) return json([{ sha: 'abcdef123456', commit: { message: 'msg', author: { date: '2026-11-10' } } }])
  if (path.endsWith('/actions/runs')) return json({ workflow_runs: [{ name: 'CI', status: 'completed', conclusion: 'success', head_branch: 'main' }] })
  if (path.includes('/git/trees/')) return json({ tree: [{ type: 'blob', path: 'src/App.jsx' }] })
  return json({ default_branch: 'main', pushed_at: '2026-11-10' })
}

async function fake(input: any, init: any = {}): Promise<Response> {
  const url = new URL(String(input)); const method = (init.method || 'GET').toUpperCase()
  const body = init.body ? JSON.parse(init.body) : undefined
  const h = init.headers || {}
  allUrls.push(method + ' ' + url.host + url.pathname)
  if (url.host === 'api.github.com') {
    if (h.Authorization === 'Bearer ' + GH2) {
      if (url.pathname === '/rate_limit') return json({ resources: { core: { remaining: 4000 } } }, healthStatus.github || 200)
      // CI behaviour is controlled by the tests: 'auto' = what the in-memory runs say
      if (ciOverride !== 'auto' && url.pathname.includes('/actions/runs') && !url.pathname.includes('/jobs')) {
        const b = url.searchParams.get('branch'); const head = b ? refs.get(b) : null
        if (head) {
          const r = ciOverride === 'none' ? [] : [{ id: 5, name: 'CI', status: ciOverride === 'running' ? 'in_progress' : 'completed', conclusion: ciOverride === 'failing' ? 'failure' : null, head_branch: b, head_sha: head, html_url: '' }]
          return json({ workflow_runs: r })
        }
      }
      return gh(method, url.pathname, url, body)
    }
    if (h.Authorization === 'Bearer ' + GH1) { a1Calls.push('github'); return agent1Github(url.pathname) }
    return json({ message: 'Bad credentials' }, 401)
  }
  if (url.host === 'generativelanguage.googleapis.com') {
    if (method === 'GET') return json({ models: [] }, healthStatus.gemini || 200)
    const sys = String(body.systemInstruction.parts[0].text)
    geminiBodies.push(String(body.contents[0].parts[0].text))
    if (String(input).includes(GEM1)) a1Calls.push('gemini')
    const text = sys.includes('bug fixer') ? fixReply : '- Looks fine.'
    return json({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 } })
  }
  if (url.host === 'api.vercel.com') {
    a1Calls.push('vercel'); if (method !== 'GET') vercelWrites.push(method + ' ' + url.pathname)
    if (h.Authorization !== 'Bearer ' + VTOKEN) return json({ error: { message: 'bad token' } }, 403)
    if (vercelDown) return json({ error: { message: 'boom ' + VTOKEN } }, 500)
    if (healthStatus.vercel) return json({}, healthStatus.vercel)
    if (url.pathname === '/v9/projects') return json({ projects: [{ id: 'prj_1', name: 'ai-control-center', framework: 'vite', link: { org: 'me', repo: 'blisscco-ai-control-center' } }] })
    if (url.pathname === '/v6/deployments') return json({ deployments: vDeps })
    if (url.pathname === '/v9/projects/prj_1/env') return json({ envs: [{ id: 'e1', key: 'VITE_SUPABASE_URL', type: 'plain', target: ['production'] }] })
    return json({}, 404)
  }
  if (url.host === 'api.supabase.com' && sqlWritesAllowed && method === 'POST' && url.pathname.endsWith('/database/query')) {
    sqlExec.push(String(body.query)); return sqlFail ? json({ message: 'syntax error near x' }, sqlFailStatus) : json([])
  }
  if (url.host === 'api.supabase.com') {
    a1Calls.push('supabase_mgmt'); if (method !== 'POST' || !url.pathname.endsWith('/database/query/read-only')) { vercelWrites.push('SUPABASE-WRITE ' + url.pathname); return json({}, 404) }
    const q: string = body.query
    if (q.includes('has_table_privilege')) return json([{ schema: 'ai_control', tbl: 'agents', rls: true, anon_select: false, anon_insert: false, anon_update: false, anon_delete: false, auth_select: true, auth_insert: false, auth_update: true, auth_delete: false }])
    return json([])
  }
  if (url.host === `${REF}.supabase.co`) {
    if (url.pathname === '/auth/v1/user') {
      const t = String(h.Authorization).replace('Bearer ', '')
      return t === 'tok-owner' ? json({ id: 'user-owner' }) : t === 'tok-other' ? json({ id: 'user-other' }) : json({}, 401)
    }
    if (h.apikey === ANON) return json({ message: 'permission denied' }, 401)
    const table = url.pathname.replace('/rest/v1/', '')
    const t = (db[table] ||= [])
    if (failAgent1Db && table === 'agents' && url.searchParams.get('slot') === 'eq.1') return json({ message: 'agents table unavailable' }, 500)
    const filt = (r: Row) => [...url.searchParams.entries()].filter(([k]) => !['select', 'order', 'limit'].includes(k)).every(([k, v]) => matches(r, k, v))
    if (method === 'GET') return json(t.filter(filt))
    if (method === 'POST') {
      const arr = Array.isArray(body) ? body : [body]
      if (table === 'tasks' && arr.some((r: Row) => r.id && t.some(x => x.id === r.id))) return json({ message: 'duplicate key value violates unique constraint' }, 409)
      const out = arr.map((r: Row) => ({ id: uuid(), updated_at: new Date().toISOString(), created_at: new Date().toISOString(), requested_at: new Date().toISOString(), ...(table === 'approvals' ? { status: 'pending' } : {}), ...r }))
      t.push(...out); return json(out, 201)
    }
    if (method === 'PATCH') { const hit = t.filter(filt); hit.forEach(r => Object.assign(r, body, { updated_at: new Date().toISOString() })); return json(hit) }
    if (method === 'DELETE') { const hit = t.filter(filt); hit.forEach(r => t.splice(t.indexOf(r), 1)); return json(hit) }
  }
  return json({ error: 'unrouted ' + url }, 500)
}

const realFetch = globalThis.fetch
const realErr = console.error
test.before(() => { globalThis.fetch = fake as any; console.error = (...a: any[]) => { consoleOut.push(a.map(String).join(' ')) } })
test.after(() => { globalThis.fetch = realFetch; console.error = realErr })
test.beforeEach(() => resetAll())

// ---------------------------------------------------------------- helpers
const post = (body: unknown, token = 'tok-owner', env: Record<string, string | undefined> = ENV) => handleRequest({ method: 'POST', headers: { authorization: 'Bearer ' + token }, body }, env)
const ok = async (action: string, params: any = {}) => { const r = await post({ action, params }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body as any }
const must = async (action: string, params: any, status: number, code?: string) => { const r = await post({ action, params }); assert.equal(r.status, status, JSON.stringify(r.body)); if (code) assert.equal((r.body as any).code, code, JSON.stringify(r.body)); return r.body as any }
const approve = (id: string, at = new Date().toISOString()) => { const a = db.approvals.find(x => x.id === id)!; a.status = 'approved'; a.decided_at = at; a.decided_by = 'user-owner' }
const orchRows = () => db.tasks.filter(t => t.payload && t.payload.kind === 'orchestration')
const FILES = [{ path: 'src/App.jsx', op: 'update', content: 'export const a = 1\nexport const b = 3\n' }, { path: 'src/New.js', op: 'create', content: 'export const n = 1\n' }]
const START = (extra: Row = {}) => ({ repo: REPO, title: 'Bump b constant', files: FILES, request_id: randomUUID(), ...extra })
const agentBranches = () => [...refs.keys()].filter(k => k.startsWith('agent2/'))
const a1Used = () => a1Calls.length > 0

async function started(extra: Row = {}) {
  const r = await ok('start', START(extra))
  return { id: r.workflow.id as string, apId: r.workflow.steps.approval.id as string, wf: r.workflow }
}
async function applied(extra: Row = {}) {
  const s = await started(extra); approve(s.apId)
  const r = await ok('apply', { workflow_id: s.id })
  return { ...s, applyRes: r }
}
const stageOf = (id: string) => db.tasks.find(t => t.id === id)!.payload.stage as string

// ================================================================ authorization
test('orchestrator authorization: 405 / 401 / 403 and nothing is created for non-owners', async () => {
  assert.equal((await handleRequest({ method: 'GET', headers: {} }, ENV)).status, 405)
  assert.equal((await handleRequest({ method: 'POST', headers: {}, body: { action: 'list' } }, ENV)).status, 401)
  assert.equal((await post({ action: 'list' }, 'bad-token')).status, 401)
  const r = await post({ action: 'start', params: START() }, 'tok-other'); assert.equal(r.status, 403)
  assert.equal((await post({ action: 'list' }, 'tok-other')).status, 403)
  assert.equal(orchRows().length, 0); assert.equal(db.approvals.length, 0); assert.equal(refs.size, 1)
  assert.equal((await handleRequest({ method: 'POST', headers: { authorization: 'Bearer tok-owner' }, body: { action: 'list' } }, { ...ENV, SUPABASE_SERVICE_ROLE_KEY: '' })).status, 500)
  await must('nuke', {}, 400, 'unknown_action')
  assert.equal(allUrls.filter(u => u.includes('api.github.com')).length, 0, 'unauthorized calls reach no external service')
})

test('start validation and pre-flight', async () => {
  await must('start', START({ repo: 'evil/other' }), 403, 'repo_not_allowed')
  await must('start', START({ title: '  ' }), 400)
  await must('start', START({ files: [] }), 400)
  await must('start', START({ mode: 'shell' }), 400)
  await must('start', START({ request_id: 'not-a-uuid' }), 400)
  await must('start', START({ base: '../main' }), 400)
  await must('start', { repo: REPO, title: 't', mode: 'fix', request_id: randomUUID() }, 400)
  const noGh = await post({ action: 'start', params: START() }, 'tok-owner', { ...ENV, AGENT2_GITHUB_TOKEN: undefined } as any); assert.equal(noGh.status, 503)
  const noA1 = await post({ action: 'start', params: START() }, 'tok-owner', { ...ENV, AGENT1_VERCEL_TOKEN: '', AGENT1_SUPABASE_ACCESS_TOKEN: '', AGENT1_GITHUB_TOKEN: '' }); assert.equal(noA1.status, 503)
  assert.equal(orchRows().length, 0, 'a workflow that cannot finish is never created')
})

// ================================================================ start -> Agent 2 assignment
test('start creates a tracked task in the existing tables and assigns the work to Agent 2 only', async () => {
  const { id, apId, wf } = await started()
  assert.equal(wf.stage, 'awaiting_approval'); assert.equal(wf.status, 'awaiting_approval')
  const row = db.tasks.find(t => t.id === id)!
  assert.equal(row.payload.kind, 'orchestration'); assert.equal(row.created_by, 'user-owner'); assert.equal(row.agent_id ?? null, null)
  const a2task = db.tasks.find(t => t.id === row.payload.steps.agent2_propose.agent2_task_id)!
  assert.equal(a2task.agent_id, db.agents[1].id); assert.match(a2task.description, /Agent 2 - propose_change/)
  const ap = db.approvals.find(a => a.id === apId)!
  assert.equal(ap.status, 'pending'); assert.equal(ap.details.kind, 'code_change'); assert.equal(ap.agent_id, db.agents[1].id); assert.equal(ap.task_id, a2task.id)
  assert.match(ap.details.branch, /^agent2\//)
  assert.deepEqual(wf.steps.agent2_propose.changed_files.map((f: any) => f.path).sort(), ['src/App.jsx', 'src/New.js'])
  assert.ok(Array.isArray(wf.steps.agent2_propose.warnings))
  assert.equal(ghWrites.length, 0, 'proposal writes nothing to GitHub'); assert.equal(agentBranches().length, 0)
  assert.equal(a1Used(), false, 'Agent 1 is not involved yet')
  assert.ok(!JSON.stringify(row).includes('export const b = 3'), 'file contents are not copied into the orchestration record')
  assert.equal(db.approvals.length, 1, 'no second approval system: exactly the Agent 2 approval')
})

test('fix mode goes through Agent 2 ai_fix and still ends at an approval', async () => {
  const r = await ok('start', { repo: REPO, title: 'Fix b', mode: 'fix', problem: 'b is wrong', paths: ['src/App.jsx'], request_id: randomUUID() })
  assert.equal(r.workflow.stage, 'awaiting_approval'); assert.equal(db.approvals.at(-1)!.details.kind, 'code_change'); assert.equal(ghWrites.length, 0)
})

// ================================================================ approval gate
test('Agent 2 cannot apply before approval; pending approval changes nothing', async () => {
  const { id } = await started()
  const r = await must('apply', { workflow_id: id }, 409, 'not_approved'); assert.equal(r.workflow_id, id)
  assert.equal(stageOf(id), 'awaiting_approval'); assert.equal(agentBranches().length, 0); assert.equal(ghWrites.length, 0)
  await must('check_ci', { workflow_id: id }, 409, 'wrong_stage')
  await must('verify', { workflow_id: id }, 409, 'wrong_stage')
  assert.equal(a1Used(), false)
})

test('rejected, expired, stale and already-used approvals can never execute', async () => {
  for (const mk of [
    { code: 'approval_rejected', setup: (ap: Row) => { ap.status = 'rejected' } },
    { code: 'approval_expired', setup: (ap: Row) => { ap.status = 'expired' } },
    { code: 'expired', setup: (ap: Row) => { ap.status = 'approved'; ap.decided_at = new Date(Date.now() - 25 * 3600 * 1000).toISOString() } },
    { code: 'already_executed', setup: (ap: Row) => { ap.status = 'approved'; ap.decided_at = new Date().toISOString(); ap.details = { ...ap.details, executed_at: new Date().toISOString() } } }
  ]) {
    resetAll()
    const { id, apId } = await started()
    mk.setup(db.approvals.find(a => a.id === apId)!)
    await must('apply', { workflow_id: id }, 409, mk.code)
    assert.equal(stageOf(id), 'failed', mk.code); assert.equal(agentBranches().length, 0, mk.code); assert.equal(ghWrites.length, 0, mk.code)
    await must('apply', { workflow_id: id }, 409, 'wrong_stage') // stopped for good
  }
})

test('a rejection made in the Approvals tab stops the workflow when it is next read', async () => {
  const { id, apId } = await started()
  db.approvals.find(a => a.id === apId)!.status = 'rejected'
  const g = await ok('get', { workflow_id: id })
  assert.equal(g.workflow.stage, 'failed'); assert.match(g.workflow.failure.message, /rejected/); assert.equal(g.workflow.status, 'failed')
  assert.equal(agentBranches().length, 0)
})

test('approval of another workflow or another kind cannot be used', async () => {
  const a = await started(); const b = await started()
  approve(a.apId)
  db.tasks.find(t => t.id === b.id)!.payload.steps.approval.id = a.apId // forged link
  await must('apply', { workflow_id: b.id }, 409, 'approval_mismatch')
  assert.equal(stageOf(b.id), 'failed'); assert.equal(agentBranches().length, 0)
})

test('sensitive files need the extra tick; without it nothing changes', async () => {
  const { id, apId } = await started({ files: [{ path: 'package.json', op: 'update', content: '{"name":"y"}\n' }] })
  approve(apId)
  await must('apply', { workflow_id: id }, 403, 'sensitive_ack')
  assert.equal(stageOf(id), 'awaiting_approval'); assert.equal(agentBranches().length, 0)
  const r = await ok('apply', { workflow_id: id, sensitive_ack: 'APPROVE-SENSITIVE' }); assert.equal(r.workflow.stage, 'ci_waiting')
})

// ================================================================ apply + CI + Agent 1
test('after approval Agent 2 commits to its own agent2/* branch only; Agent 1 still has not started', async () => {
  const { id, applyRes } = await applied()
  const w = applyRes.workflow
  assert.equal(w.stage, 'ci_waiting'); assert.match(w.steps.agent2_apply.branch, /^agent2\//); assert.match(w.steps.agent2_apply.commit_sha, /^[0-9a-f]{40}$/)
  assert.equal(agentBranches().length, 1); assert.equal(refs.get(w.steps.agent2_apply.branch), w.steps.agent2_apply.commit_sha)
  assert.equal(treeOf(refs.get('main')!).get('src/App.jsx')!.sha, gitBlobSha(SEED['src/App.jsx']), 'main untouched')
  assert.equal(w.steps.agent2_apply.production_touched, false)
  assert.equal(db.approvals.at(-1)!.details.commit_sha, w.steps.agent2_apply.commit_sha)
  assert.equal(a1Used(), false)
  assert.equal(stageOf(id), 'ci_waiting')
})

test('Agent 1 starts only when CI has passed (running / none / failing never start it)', async () => {
  for (const state of ['running', 'none'] as const) {
    resetAll(); const { id } = await applied(); ciOverride = state
    const r = await ok('check_ci', { workflow_id: id }); assert.equal(r.ci_state, state); assert.equal(r.workflow.stage, 'ci_waiting')
    await must('verify', { workflow_id: id }, 409, 'wrong_stage'); assert.equal(a1Used(), false, state)
  }
  resetAll(); const f = await applied(); ciOverride = 'failing'
  const bad = await must('check_ci', { workflow_id: f.id }, 409, 'ci_failed')
  assert.equal(stageOf(f.id), 'failed'); assert.equal(a1Used(), false); assert.equal(bad.workflow_id, f.id)
  assert.equal(db.tasks.find(t => t.id === f.id)!.payload.failure.agent, 'agent2')
})

test('full happy path: one combined report, nothing touched in production, no auto-promotion', async () => {
  const { id, applyRes } = await applied()
  const branch = applyRes.workflow.steps.agent2_apply.branch
  vDeps.unshift({ uid: 'd2', readyState: 'READY', target: 'preview', created: Date.now(), meta: { githubCommitRef: branch } })
  const sha = refs.get(branch)!
  runs = [{ id: 9, name: 'CI', status: 'completed', conclusion: 'success', head_branch: branch, head_sha: sha, html_url: 'https://x/run/9' }]
  const r = await ok('check_ci', { workflow_id: id })
  assert.equal(r.workflow.stage, 'completed'); assert.equal(r.workflow.status, 'succeeded')
  const rep = r.workflow.report
  assert.equal(rep.agent2.commit_sha, sha); assert.equal(rep.agent2.ci.state, 'passing'); assert.equal(rep.production_touched, false)
  assert.equal(rep.agent1.vercel.branch_deployments[0].state, 'READY'); assert.ok(['ok', 'attention', 'unavailable'].includes(rep.agent1.supabase.status))
  assert.equal(rep.agent1.github.repo_monitored, true); assert.equal(rep.agent3.triggered, false)
  assert.equal(rep.stages.length, 5); assert.ok(rep.next_actions.some((x: string) => /Request promote/.test(x)))
  assert.ok(a1Used())
  assert.equal(db.tasks.find(t => t.id === id)!.status, 'succeeded'); assert.ok(db.tasks.find(t => t.id === id)!.result.verdict)
  // production safety
  assert.equal(refs.get('main'), refs.get('main')); assert.equal(prs.length, 0)
  assert.ok(!ghWrites.some(w => /\/pulls|\/merge|\/dispatches/.test(w.path)), 'no PR / merge / workflow run')
  assert.equal(vercelWrites.length, 0, 'no Vercel or Supabase writes')
  assert.ok(!db.approvals.some(a => ['promote', 'workflow_run', 'redeploy', 'rollback', 'env_change', 'db_change'].includes(a.details.kind)), 'no other approval kinds created')
  // replay is refused
  await must('apply', { workflow_id: id }, 409, 'wrong_stage'); await must('check_ci', { workflow_id: id }, 409, 'wrong_stage'); await must('verify', { workflow_id: id }, 409, 'wrong_stage')
})

test('Agent 1 verdict reflects problems honestly (Vercel down -> unavailable/attention, never a fake success)', async () => {
  const { id, applyRes } = await applied(); const b = applyRes.workflow.steps.agent2_apply.branch
  runs = [{ id: 9, name: 'CI', status: 'completed', conclusion: 'success', head_branch: b, head_sha: refs.get(b)!, html_url: '' }]; vercelDown = true
  const r = await ok('check_ci', { workflow_id: id })
  const rep = r.workflow.report
  assert.equal(rep.agent1.vercel.status, 'unavailable'); assert.notEqual(rep.verdict, 'healthy'); assert.ok(rep.warnings.some((w: string) => /vercel/i.test(w)))
})

// ================================================================ failures stop the workflow
test('Agent 2 failure while proposing stops the workflow with the error shown', async () => {
  const e = await must('start', START({ files: [{ path: 'src/missing.js', op: 'update', content: 'x' }] }), 404)
  assert.match(e.error, /Agent 2 could not prepare/); assert.ok(e.workflow_id)
  const row = db.tasks.find(t => t.id === e.workflow_id)!
  assert.equal(row.payload.stage, 'failed'); assert.equal(row.status, 'failed'); assert.equal(row.payload.failure.agent, 'agent2'); assert.match(row.error_message, /does not exist/)
  assert.equal(db.approvals.length, 0); assert.equal(a1Used(), false)
})

test('Agent 2 failure while applying stops the workflow (no silent continue, no half-made branch)', async () => {
  const { id, apId } = await started(); approve(apId); failNextBlob = true
  const e = await must('apply', { workflow_id: id }, 502); assert.match(e.error, /Agent 2 could not apply/)
  assert.equal(stageOf(id), 'failed'); assert.equal(agentBranches().length, 0); assert.equal(a1Used(), false)
  await must('check_ci', { workflow_id: id }, 409, 'wrong_stage'); await must('apply', { workflow_id: id }, 409, 'wrong_stage')
  assert.equal(db.tasks.find(t => t.id === id)!.status, 'failed')
})

test('Agent 2 failure while reading CI stops the workflow', async () => {
  const { id } = await applied()
  const r = await handleRequest({ method: 'POST', headers: { authorization: 'Bearer tok-owner' }, body: { action: 'check_ci', params: { workflow_id: id } } }, { ...ENV, AGENT2_GITHUB_TOKEN: 'ghp_WRONGWRONGWRONGWRONGWRONGWRONG1' })
  assert.equal(r.status, 502); assert.ok(!JSON.stringify(r.body).includes('WRONGWRONG')); assert.equal(stageOf(id), 'failed')
})

test('Agent 1 failure stops the workflow', async () => {
  const { id, applyRes } = await applied(); const b = applyRes.workflow.steps.agent2_apply.branch
  runs = [{ id: 9, name: 'CI', status: 'completed', conclusion: 'success', head_branch: b, head_sha: refs.get(b)!, html_url: '' }]; failAgent1Db = true
  const e = await must('check_ci', { workflow_id: id }, 502); assert.match(e.error, /Agent 1 verification failed/)
  const row = db.tasks.find(t => t.id === id)!
  assert.equal(row.payload.stage, 'failed'); assert.equal(row.payload.failure.agent, 'agent1'); assert.equal(row.result ?? null, null, 'no success report is produced')
  assert.equal(row.payload.steps.agent2_apply.status, 'done', 'Agent 2 result is preserved')
})

// ================================================================ duplicates, cancel, reload
test('duplicate start (same request_id) is refused and creates nothing new', async () => {
  const p = START(); await ok('start', p)
  await must('start', p, 409, 'duplicate')
  assert.equal(orchRows().length, 1); assert.equal(db.approvals.length, 1)
})

test('double tap on Apply executes once: one branch, one commit, second request gets 409', async () => {
  const { id, apId } = await started(); approve(apId)
  const [a, b] = await Promise.all([post({ action: 'apply', params: { workflow_id: id } }), post({ action: 'apply', params: { workflow_id: id } })])
  assert.deepEqual([a.status, b.status].sort(), [200, 409], JSON.stringify([a.body, b.body]))
  assert.equal(agentBranches().length, 1); assert.equal(ghWrites.filter(w => w.path === '/git/commits').length, 1)
  assert.equal(db.approvals.find(x => x.id === apId)!.details.commit_sha, (db.tasks.find(t => t.id === id)!.payload.steps.agent2_apply.commit_sha))
})

test('double tap on CI check completes Agent 1 only once', async () => {
  const { id, applyRes } = await applied(); const b = applyRes.workflow.steps.agent2_apply.branch
  runs = [{ id: 9, name: 'CI', status: 'completed', conclusion: 'success', head_branch: b, head_sha: refs.get(b)!, html_url: '' }]
  const res = await Promise.all([post({ action: 'check_ci', params: { workflow_id: id } }), post({ action: 'check_ci', params: { workflow_id: id } })])
  assert.equal(res.filter(r => r.status === 200).length, 1, JSON.stringify(res.map(r => r.body)))
  assert.equal(db.tasks.filter(t => t.description === 'Agent 1 - health_report').length, 1)
})

test('cancel stops the workflow, keeps the approval pending, and apply is then impossible', async () => {
  const { id, apId } = await started()
  const c = await ok('cancel', { workflow_id: id }); assert.equal(c.workflow.stage, 'cancelled'); assert.equal(c.workflow.status, 'cancelled')
  assert.equal(db.approvals.find(a => a.id === apId)!.status, 'pending', 'the Orchestrator never decides approvals')
  approve(apId); await must('apply', { workflow_id: id }, 409, 'wrong_stage'); assert.equal(agentBranches().length, 0)
  await must('cancel', { workflow_id: id }, 409, 'wrong_stage')
})

test('workflow state lives in the database and survives reload / a new server instance', async () => {
  const { id, apId } = await started()
  let l = await ok('list'); assert.equal(l.workflows[0].stage, 'awaiting_approval'); assert.equal(l.workflows[0].id, id)
  approve(apId); await ok('apply', { workflow_id: id })
  // a "reload": fresh requests, fresh config objects, nothing cached in memory
  l = await ok('list'); assert.equal(l.workflows[0].stage, 'ci_waiting'); assert.match(l.workflows[0].commit_sha, /^[0-9a-f]{40}$/)
  const g = await ok('get', { workflow_id: id }); assert.equal(g.workflow.stage, 'ci_waiting'); assert.equal(g.workflow.steps.approval.status, 'approved'); assert.ok(g.workflow.events.length >= 3)
  assert.equal(db.tasks.find(t => t.id === id)!.payload.stage, 'ci_waiting')
  await must('get', { workflow_id: 'nope' }, 400); await must('get', { workflow_id: randomUUID() }, 404)
})

test('a transient step that never reported back is marked interrupted, not left running forever', async () => {
  const { id } = await started()
  const row = db.tasks.find(t => t.id === id)!; row.payload.stage = 'applying'; row.updated_at = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const g = await ok('get', { workflow_id: id }); assert.equal(g.workflow.stage, 'failed'); assert.equal(g.workflow.failure.code, 'interrupted')
})

// ================================================================ production + Agent 3 + secrets
test('production promotion and every other agent operation are impossible through the Orchestrator', async () => {
  assert.deepEqual([...A2_ALLOWED].sort(), ['actions_status', 'ai_fix', 'apply_change', 'propose_change'])
  assert.deepEqual([...A1_ALLOWED], ['health_report'])
  for (const a of ['request_promote', 'apply_promote', 'request_rollback', 'apply_rollback', 'request_workflow', 'apply_workflow', 'ai_command', 'apply_env_change', 'apply_db_change', 'apply_redeploy', 'production_ack']) {
    assert.ok(!(ACTIONS as readonly string[]).includes(a), a)
    await must(a, {}, 400, 'unknown_action')
  }
  const src = readdirSync(srcDir()).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts')).map(f => readFileSync(join(srcDir(), f), 'utf8')).join('\n')
  assert.ok(!/APPROVE-PRODUCTION|production_ack/.test(src.replace(/Cannot|never/g, '')) || !/production_ack\s*[:=]/.test(src), 'orchestrator never supplies a production confirmation')
  assert.ok(!/callA2\(o, '(request_promote|apply_promote|request_rollback|apply_rollback|request_workflow|apply_workflow|ai_command)'/.test(src))
  assert.ok(!/callA1\(o, '(?!health_report)/.test(src))
})

function srcDir() { const here = dirname(fileURLToPath(import.meta.url)); return existsSync(join(here, 'workflow.ts')) ? here : join(here, '..', '..') }

test('Agent 3 is never part of the Orchestrator and is never triggered', async () => {
  const dir = srcDir()
  const files = readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  assert.ok(files.length >= 4)
  for (const f of files) {
    const s = readFileSync(join(dir, f), 'utf8')
    assert.ok(!/from\s+['"][^'"]*agent3/.test(s), f + ' imports agent3'); assert.ok(!/AGENT3_/.test(s), f + ' reads AGENT3 env'); assert.ok(!/api\/agent3/.test(s), f)
  }
  const { id, applyRes } = await applied(); const b = applyRes.workflow.steps.agent2_apply.branch
  runs = [{ id: 9, name: 'CI', status: 'completed', conclusion: 'success', head_branch: b, head_sha: refs.get(b)!, html_url: '' }]
  await ok('check_ci', { workflow_id: id })
  assert.ok(!allUrls.some(u => /agent3|qa/i.test(u)), 'no request towards Agent 3 or QA targets')
  const a3 = db.agents[2]; assert.equal(a3.status, 'offline'); assert.equal(a3.last_heartbeat_at, null); assert.equal(a3.name, 'Agent 3')
  assert.ok(!db.tasks.some(t => t.agent_id === a3.id || /Agent 3/.test(String(t.description))), 'no Agent 3 task')
  assert.ok(!db.activity_logs.some(l => l.agent_id === a3.id || /agent3/i.test(l.action)))
})

test('no secret appears in any response, database row or log (success and failure paths)', async () => {
  const bodies: unknown[] = []
  const grab = async (a: string, p: any) => { const r = await post({ action: a, params: p }); bodies.push(r.body); return r }
  await grab('heartbeat', {})
  const { id, apId, applyRes } = await applied(); bodies.push(applyRes)
  const b = applyRes.workflow.steps.agent2_apply.branch
  runs = [{ id: 9, name: 'CI', status: 'completed', conclusion: 'success', head_branch: b, head_sha: refs.get(b)!, html_url: '' }]
  vercelDown = true // its error text contains a token on purpose
  await grab('check_ci', { workflow_id: id }); await grab('list', {}); await grab('get', { workflow_id: id })
  const s2 = await started(); approve(s2.apId); failNextBlob = true; await grab('apply', { workflow_id: s2.id })
  await grab('start', START({ files: [{ path: 'k.js', op: 'create', content: `k="${GH2}"` }] }))
  // a secret that somehow reached a stored record is still masked when read back
  db.tasks.find(t => t.id === id)!.payload.events.push({ at: 'x', stage: 'x', message: 'leak ' + SERVICE + ' ' + GH2 })
  await grab('get', { workflow_id: id })
  const ev = db.tasks.find(t => t.id === id)!.payload.events; ev.pop() // remove the secret the test planted itself
  const everything = JSON.stringify([bodies, db, consoleOut])
  for (const s of SECRETS) assert.ok(!everything.includes(s), 'leaked ' + s.slice(0, 8))
  const responses = JSON.stringify(bodies)
  for (const s of SECRETS) assert.ok(!responses.includes(s), 'response leaked ' + s.slice(0, 8))
  const logs = JSON.stringify(db.activity_logs); for (const s of SECRETS) assert.ok(!logs.includes(s), 'log leaked ' + s.slice(0, 8))
  assert.ok(!JSON.stringify(orchRows().map(r => r.result)).includes('ghp_'))
})

test('unit: CI evaluation per commit', () => {
  const run = (sha: string, status: string, conclusion: string | null) => ({ sha, status, conclusion })
  const c = 'abcdef1234567890abcdef1234567890abcdef12'
  assert.equal(evalCi([], c), 'none'); assert.equal(evalCi([run('1111111', 'completed', 'success')], c), 'none')
  assert.equal(evalCi([run('abcdef1', 'in_progress', null)], c), 'running'); assert.equal(evalCi([run('abcdef1', 'completed', 'success'), run('abcdef1', 'queued', null)], c), 'running')
  assert.equal(evalCi([run('abcdef1', 'completed', 'success')], c), 'passing'); assert.equal(evalCi([run('abcdef1', 'completed', 'skipped')], c), 'passing')
  assert.equal(evalCi([run('abcdef1', 'completed', 'failure')], c), 'failing'); assert.equal(evalCi([run('abcdef1', 'completed', 'cancelled')], c), 'failing')
})

// ================================================================ Phase 3 Part 2: ZIP deployment + Agent 1 SQL
function crc32(b: Buffer) { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0) } return (~c) >>> 0 }
interface ZE { name: string; data?: string | Buffer; mode?: number; dd?: boolean }
function makeZip(entries: ZE[]): string {
  const locals: Buffer[] = []; const cds: Buffer[] = []; let off = 0
  for (const e of entries) {
    const name = Buffer.from(e.name); const raw = Buffer.from(e.data ?? ''); const comp = deflateRawSync(raw); const crc = crc32(raw)
    const flags = e.dd ? 8 : 0
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26)
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(0x031e, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(flags, 8); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38); cd.writeUInt32LE(off, 42)
    locals.push(lh, name, comp); cds.push(cd, name); off += 30 + name.length + comp.length
  }
  const cdBuf = Buffer.concat(cds); const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16)
  return Buffer.concat([...locals, cdBuf, eocd]).toString('base64')
}
const SQL_OK = 'create table if not exists ai_control.deploy_notes (id uuid primary key default gen_random_uuid(), note text);'
const zipParams = (entries: ZE[], extra: Row = {}) => ({ repo: REPO, title: 'ZIP: bump b', zip_base64: makeZip(entries), request_id: randomUUID(), ...extra })
const CODE_ZIP: ZE[] = [{ name: 'src/App.jsx', data: 'export const a = 1\nexport const b = 3\n' }, { name: 'src/New.js', data: 'export const n = 1\n' }]
async function zipUp(entries: ZE[], extra: Row = {}) {
  const r = await ok('upload_zip', zipParams(entries, extra))
  return { id: r.workflow.id as string, apId: r.workflow.steps.approval.id as string, wf: r.workflow, res: r }
}
async function zipToCi(entries: ZE[], extra: Row = {}) { // upload -> approve -> apply -> green CI (returns the check_ci response)
  const u = await zipUp(entries, extra); approve(u.apId)
  const ap = await ok('apply', { workflow_id: u.id }); const b = ap.workflow.steps.agent2_apply.branch
  runs = [{ id: 9, name: 'CI', status: 'completed', conclusion: 'success', head_branch: b, head_sha: refs.get(b)!, html_url: 'https://x/run/9' }]
  const ci = await ok('check_ci', { workflow_id: u.id })
  return { ...u, branch: b, ci }
}
const sqlApprovals = () => db.approvals.filter(a => a.details && a.details.kind === 'db_change')

test('ZIP upload: validated server-side, change detection against the verified base, NO GitHub write and NO SQL run', async () => {
  const before = refs.get('main')
  const u = await zipUp([...CODE_ZIP, { name: 'supabase/sql/001_notes.sql', data: SQL_OK }])
  assert.equal(u.wf.stage, 'awaiting_approval'); assert.equal(u.wf.zip.base_commit, before); assert.equal(u.wf.zip.base_branch, 'main')
  assert.deepEqual(u.wf.zip.changed_files.map((f: Row) => f.op + ' ' + f.path).sort(), ['create src/New.js', 'update src/App.jsx'])
  assert.match(u.wf.zip.checksum, /^[a-f0-9]{64}$/); assert.ok(u.wf.zip.changed_files.every((f: Row) => /^[a-f0-9]{64}$/.test(f.sha256)))
  assert.equal(u.wf.zip.sql.length, 1); assert.equal(u.wf.zip.sql[0].status, 'reviewed'); assert.equal(u.wf.zip.sql[0].risk, 'standard')
  assert.equal(ghWrites.length, 0, 'upload/preview writes nothing to GitHub'); assert.deepEqual(agentBranches(), []); assert.equal(refs.get('main'), before)
  assert.equal(sqlExec.length, 0); assert.equal(sqlApprovals().length, 0, 'SQL approvals are only requested after code + CI')
  assert.ok(u.wf.steps.agent2_propose.changed_files.length === 2, 'SQL is not part of the code commit')
  const ap = db.approvals.find(a => a.id === u.apId)!; assert.ok(ap.details.files.every((f: Row) => typeof f.preview === 'string'), 'diff preview is available for the dashboard')
  assert.equal(ap.details.base_sha, before)
})

test('ZIP -> Gemini receives ONLY a compact bounded diff summary (never the ZIP, full files, SQL or secrets); usage is recorded', async () => {
  const big = Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n'
  const entries: ZE[] = [{ name: 'src/App.jsx', data: 'export const a = 1\nexport const b = 2\nexport const c = 3\n' + 'x'.repeat(10) + '\n' }]
  for (let i = 0; i < 25; i++) entries.push({ name: `src/gen/file${i}.js`, data: big.repeat(4) })
  entries.push({ name: 'supabase/sql/001.sql', data: SQL_OK })
  const zip = makeZip(entries)
  const u = await ok('upload_zip', { repo: REPO, title: 'many files', zip_base64: zip, request_id: randomUUID() })
  assert.ok(geminiBodies.length >= 1)
  for (const b of geminiBodies) {
    assert.ok(b.length <= 14000, 'Gemini input is capped at 14,000 chars, got ' + b.length)
    assert.ok(!b.includes(zip.slice(0, 80)), 'ZIP never sent'); assert.ok(!b.includes('deploy_notes'), 'SQL never sent to Gemini')
    assert.ok(!b.includes(big), 'no complete file body'); assert.ok(!SECRETS.some(s => b.includes(s)))
    assert.match(b, /"added"/); assert.match(b, /"op"/); assert.match(b, /"file_type"/); assert.match(b, /"security_findings"/)
  }
  assert.equal(u.workflow.zip.gemini.review_partial, true, 'truncation is reported as a partial review')
  assert.equal(u.workflow.zip.gemini.input_max_chars, 14000); assert.equal(u.workflow.zip.gemini.output_max_tokens, 1200)
  assert.ok(u.workflow.steps.agent2_propose.warnings.some((w: string) => /partial/i.test(w)))
  const usage = db.api_usage.filter(x => x.endpoint === 'propose_change_review'); assert.equal(usage.length, 1)
  assert.equal(usage[0].tokens_in, 100); assert.equal(usage[0].tokens_out, 20); assert.ok(usage[0].cost_estimate >= 0)
  assert.equal(u.workflow.steps.agent2_propose.ai_usage.tokens_in, 100)
})

test('ZIP small change: review is complete (not partial) and the summary is tiny', async () => {
  const u = await zipUp(CODE_ZIP)
  assert.equal(u.wf.zip.gemini.review_partial, false); assert.ok(geminiBodies[0].length < 3000)
})

test('ZIP full flow: code approval -> agent2/* commit -> CI -> Agent 1 SQL approval (separate) -> run once -> verify -> report; Agent 3 untouched', async () => {
  const u = await zipUp([...CODE_ZIP, { name: 'supabase/sql/001_notes.sql', data: SQL_OK }])
  await must('apply', { workflow_id: u.id }, 409, 'not_approved')
  approve(u.apId)
  const ap = await ok('apply', { workflow_id: u.id }); const b = ap.workflow.steps.agent2_apply.branch
  assert.match(b, /^agent2\//); assert.equal(refs.get('main'), u.wf.zip.base_commit, 'main untouched'); assert.equal(prs.length, 0)
  runs = [{ id: 9, name: 'CI', status: 'completed', conclusion: 'success', head_branch: b, head_sha: refs.get(b)!, html_url: '' }]
  const ci = await ok('check_ci', { workflow_id: u.id })
  assert.equal(ci.workflow.stage, 'awaiting_sql'); assert.equal(ci.workflow.status, 'awaiting_approval')
  assert.equal(sqlApprovals().length, 1); assert.equal(sqlExec.length, 0, 'nothing executed before the SQL approval')
  assert.ok(!a1Used() || !a1Calls.includes('vercel'), 'Agent 1 verification does not start before the SQL is handled')
  await must('verify', { workflow_id: u.id }, 409, 'wrong_stage'); await must('apply_sql', { workflow_id: u.id, db_ack: 'RUN-SQL' }, 409, 'not_approved')
  approve(sqlApprovals()[0].id)
  await must('apply_sql', { workflow_id: u.id }, 403, 'db_ack'); assert.equal(sqlExec.length, 0)
  sqlWritesAllowed = true
  const r = await ok('apply_sql', { workflow_id: u.id, db_ack: 'RUN-SQL' })
  assert.equal(sqlExec.length, 1); assert.ok(sqlExec[0].includes('ai_control.deploy_notes')); assert.match(sqlExec[0], /SET LOCAL search_path = ai_control/)
  assert.equal(r.workflow.stage, 'completed'); const rep = r.workflow.report
  assert.equal(rep.sql.migrations[0].status, 'applied'); assert.equal(rep.sql.reviewed_by, 'agent1'); assert.equal(rep.zip.base_commit, u.wf.zip.base_commit)
  assert.ok(rep.stages.some((s: Row) => s.name === 'Agent 1 SQL migrations' && s.status === 'done')); assert.ok(/SQL/.test(rep.rollback_guidance)); assert.equal(rep.production_touched, false)
  await must('apply_sql', { workflow_id: u.id, db_ack: 'RUN-SQL' }, 409, 'wrong_stage'); assert.equal(sqlExec.length, 1, 'never executed twice')
  assert.equal(db.agents[2].status, 'offline'); assert.ok(!allUrls.some(x => /agent3/i.test(x)))
  assert.ok(!db.approvals.some(a => ['promote', 'workflow_run', 'redeploy', 'rollback', 'env_change'].includes(a.details.kind)))
})

test('SQL: destructive statements need the extra confirmation; rejection or failure stops the workflow; no second execution', async () => {
  const sql = "delete from ai_control.deploy_notes where note = 'x';"
  const u = await zipUp([...CODE_ZIP, { name: 'supabase/sql/002.sql', data: sql }]); assert.equal(u.wf.zip.sql[0].risk, 'destructive')
  approve(u.apId); const b = (await ok('apply', { workflow_id: u.id })).workflow.steps.agent2_apply.branch
  runs = [{ id: 9, name: 'CI', status: 'completed', conclusion: 'success', head_branch: b, head_sha: refs.get(b)!, html_url: '' }]
  await ok('check_ci', { workflow_id: u.id }); approve(sqlApprovals()[0].id); sqlWritesAllowed = true; sqlFail = true
  await must('apply_sql', { workflow_id: u.id, db_ack: 'RUN-SQL' }, 403, 'destructive_ack'); assert.equal(sqlExec.length, 0)
  const bad = await post({ action: 'apply_sql', params: { workflow_id: u.id, db_ack: 'RUN-SQL', destructive_ack: 'APPROVE-DESTRUCTIVE' } })
  assert.equal(bad.status, 502, JSON.stringify(bad.body)); assert.equal(stageOf(u.id), 'failed'); assert.equal(sqlExec.length, 1)
  assert.equal(db.tasks.find(t => t.id === u.id)!.payload.steps.sql.items[0].status, 'failed')
  await must('apply_sql', { workflow_id: u.id, db_ack: 'RUN-SQL', destructive_ack: 'APPROVE-DESTRUCTIVE' }, 409, 'wrong_stage'); assert.equal(sqlExec.length, 1)
})

test('SQL: a rejected SQL approval stops the workflow and nothing runs', async () => {
  const u = await zipUp([...CODE_ZIP, { name: 'supabase/sql/001.sql', data: SQL_OK }]); approve(u.apId)
  const b = (await ok('apply', { workflow_id: u.id })).workflow.steps.agent2_apply.branch
  runs = [{ id: 9, name: 'CI', status: 'completed', conclusion: 'success', head_branch: b, head_sha: refs.get(b)!, html_url: '' }]
  await ok('check_ci', { workflow_id: u.id }); sqlApprovals()[0].status = 'rejected'; sqlWritesAllowed = true
  await must('apply_sql', { workflow_id: u.id, db_ack: 'RUN-SQL' }, 409); assert.equal(stageOf(u.id), 'failed'); assert.equal(sqlExec.length, 0)
})

test('SQL: tampered approval (SQL changed after upload) is refused by checksum', async () => {
  const u = await zipUp([...CODE_ZIP, { name: 'supabase/sql/001.sql', data: SQL_OK }]); approve(u.apId)
  const b = (await ok('apply', { workflow_id: u.id })).workflow.steps.agent2_apply.branch
  runs = [{ id: 9, name: 'CI', status: 'completed', conclusion: 'success', head_branch: b, head_sha: refs.get(b)!, html_url: '' }]
  await ok('check_ci', { workflow_id: u.id }); const a = sqlApprovals()[0]; approve(a.id); a.details.sql = 'create table ai_control.other (id int);'; sqlWritesAllowed = true
  await must('apply_sql', { workflow_id: u.id, db_ack: 'RUN-SQL' }, 409, 'sql_checksum'); assert.equal(sqlExec.length, 0)
})

test('SQL that Agent 1 safeguards forbid is BLOCKED with the reason, never silently skipped, never executed; code still flows', async () => {
  const evil = ['create table public.profiles (id int);', 'insert into ai_control.ledger_entries values (1);', 'alter table ai_control.x drop column y; -- c', 'drop table ai_control.deploy_notes;', 'select 1;']
  const u = await zipUp([...CODE_ZIP, ...evil.map((d, i) => ({ name: `supabase/sql/9${i}.sql`, data: d }))])
  assert.equal(u.wf.zip.sql.length, 5)
  for (const s of u.wf.zip.sql.slice(0, 4)) { assert.equal(s.status, 'blocked', s.path); assert.ok(s.reason && s.reason.length > 10) }
  assert.match(u.wf.zip.sql[0].reason, /protected schema|ai_control/); assert.match(u.wf.zip.sql[1].reason, /billing|ledger/)
  assert.equal(u.wf.zip.sql[4].status, 'blocked', 'must reference ai_control')
  approve(u.apId); const b = (await ok('apply', { workflow_id: u.id })).workflow.steps.agent2_apply.branch
  runs = [{ id: 9, name: 'CI', status: 'completed', conclusion: 'success', head_branch: b, head_sha: refs.get(b)!, html_url: '' }]
  const ci = await ok('check_ci', { workflow_id: u.id }); assert.equal(ci.workflow.stage, 'completed')
  assert.equal(sqlApprovals().length, 0); assert.equal(sqlExec.length, 0); assert.equal(ci.workflow.report.verdict, 'attention')
  assert.equal(ci.workflow.report.sql.blocked.length, 5); assert.ok(ci.workflow.report.warnings.filter((w: string) => /BLOCKED/.test(w)).length === 5)
  assert.ok(ci.workflow.report.next_actions.some((x: string) => /Do NOT promote/.test(x)))
})

test('ZIP with only SQL is refused with a clear message and creates nothing', async () => {
  await must('upload_zip', zipParams([{ name: 'supabase/sql/001.sql', data: SQL_OK }]), 422, 'sql_only'); assert.equal(orchRows().length, 0); assert.equal(sqlApprovals().length, 0)
})

test('CI failure stops the workflow BEFORE any SQL is proposed or run', async () => {
  const u = await zipUp([...CODE_ZIP, { name: 'supabase/sql/001.sql', data: SQL_OK }]); approve(u.apId)
  const b = (await ok('apply', { workflow_id: u.id })).workflow.steps.agent2_apply.branch
  runs = [{ id: 9, name: 'CI', status: 'completed', conclusion: 'failure', head_branch: b, head_sha: refs.get(b)!, html_url: '' }]
  await must('check_ci', { workflow_id: u.id }, 409, 'ci_failed'); assert.equal(stageOf(u.id), 'failed'); assert.equal(sqlApprovals().length, 0); assert.equal(sqlExec.length, 0)
})

test('ZIP safety: traversal, absolute, symlink, duplicate, binary, secret, unsupported, bomb and bad base64 are all refused; nothing is created', async () => {
  const cases: [string, ZE[], number][] = [
    ['traversal', [{ name: '../evil.js', data: 'x' }], 400], ['nested traversal', [{ name: 'src/../../evil.js', data: 'x' }], 400], ['absolute', [{ name: '/etc/passwd.txt', data: 'x' }], 400],
    ['symlink', [{ name: 'src/link.js', data: 'target.js', mode: 0o120777 }], 400], ['duplicate', [{ name: 'src/a.js', data: '1' }, { name: 'SRC/A.js', data: '2' }], 400],
    ['binary', [{ name: 'src/a.js', data: Buffer.from([1, 2, 0, 3]) }], 400], ['unsupported', [{ name: 'img/logo.png', data: 'x' }], 400],
    ['secret', [{ name: 'src/c.js', data: 'const k = "' + 'ghp_' + 'a'.repeat(36) + '"\n' }], 422], ['.env file', [{ name: '.env', data: 'A=1' }], 403],
    ['bomb', [{ name: 'src/big.txt', data: 'a'.repeat(190_000) }], 413], ['git dir', [{ name: '.git/config', data: 'x' }], 403]
  ]
  for (const [name, entries, status] of cases) { const r = await post({ action: 'upload_zip', params: zipParams(entries) }); assert.equal(r.status, status, name + ' ' + JSON.stringify(r.body)) }
  assert.equal((await post({ action: 'upload_zip', params: { ...zipParams(CODE_ZIP), zip_base64: '!!!notbase64' } })).status, 400)
  assert.equal((await post({ action: 'upload_zip', params: { ...zipParams(CODE_ZIP), zip_base64: Buffer.from('not a zip at all').toString('base64') } })).status, 400)
  assert.equal(orchRows().length, 0); assert.equal(ghWrites.length, 0); assert.equal(db.approvals.length, 0)
})

test('ZIP: OS junk (__MACOSX, .DS_Store) is skipped and reported; data-descriptor archives are accepted', async () => {
  const u = await zipUp([...CODE_ZIP.map(e => ({ ...e, dd: true })), { name: '__MACOSX/src/._App.jsx', data: 'junk' }, { name: '.DS_Store', data: 'junk' }])
  assert.equal(u.wf.zip.changed_files.length, 2); assert.equal(u.wf.zip.ignored_entries.length, 2)
})

test('ZIP: deletions via .blisscco-delete.txt are detected, shown as deleting, and must exist in the base', async () => {
  const u = await zipUp([...CODE_ZIP, { name: '.blisscco-delete.txt', data: 'big.txt\n' }])
  assert.ok(u.wf.zip.changed_files.some((f: Row) => f.op === 'delete' && f.path === 'big.txt')); assert.ok(u.wf.steps.agent2_propose.warnings.some((w: string) => /DELETES big\.txt/.test(w)))
  await must('upload_zip', zipParams([...CODE_ZIP, { name: '.blisscco-delete.txt', data: 'nope.txt\n' }]), 404, 'delete_missing')
  await must('upload_zip', zipParams([...CODE_ZIP, { name: '.blisscco-delete.txt', data: 'src/App.jsx\n' }]), 400)
})

test('ZIP: same ZIP twice is refused (idempotency); wrong repo, wrong expected base SHA and protected-branch writes are refused', async () => {
  const p = zipParams(CODE_ZIP); await ok('upload_zip', p); await must('upload_zip', { ...p, request_id: randomUUID() }, 409, 'duplicate_zip'); await must('upload_zip', p, 409)
  await must('upload_zip', zipParams(CODE_ZIP, { repo: 'evil/other' }), 403, 'repo_not_allowed')
  await must('upload_zip', zipParams([{ name: 'src/Z.js', data: 'z' }], { expected_base_sha: 'a'.repeat(40) }), 409, 'base_changed')
  await must('upload_zip', zipParams([{ name: 'src/Y.js', data: 'y' }], { expected_base_sha: 'zzz' }), 400)
  const ok1 = await ok('upload_zip', zipParams([{ name: 'src/W.js', data: 'w' }], { expected_base_sha: refs.get('main') })); assert.equal(ok1.workflow.zip.base_commit, refs.get('main'))
  assert.equal(ghWrites.length, 0)
})

test('ZIP: sensitive files keep the extra confirmation; the base moving between upload and proposal is refused', async () => {
  const u = await zipUp([{ name: 'package.json', data: '{"name":"x","version":"2"}\n' }]); approve(u.apId)
  await must('apply', { workflow_id: u.id }, 403, 'sensitive_ack'); assert.deepEqual(agentBranches(), [])
  // base moves after the ZIP was verified but before Agent 2 builds the proposal
  const orig = globalThis.fetch; let moved = false
  globalThis.fetch = (async (i: any, init: any) => { const r = await (orig as any)(i, init); if (!moved && String(i).includes('/git/ref/heads/main')) { moved = true; const m = new Map(treeOf(refs.get('main')!)); m.set('late.txt', { mode: '100644', sha: putBlob('late\n') }); refs.set('main', putCommit(putTree(m), [refs.get('main')!], 'late')) } return r }) as any
  try { const r = await post({ action: 'upload_zip', params: zipParams([{ name: 'src/Q.js', data: 'q' }]) }); assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal((r.body as any).code, 'base_changed') } finally { globalThis.fetch = orig }
})

test('Orchestrator allow-lists: SQL actions are reachable only through the dedicated SQL stages; Agent 1 allow-list for generic calls is unchanged', () => {
  assert.deepEqual([...A1_ALLOWED], ['health_report']); assert.deepEqual([...A1_SQL_ALLOWED], ['propose_db_change', 'apply_db_change'])
  assert.ok((ACTIONS as readonly string[]).includes('upload_zip') && (ACTIONS as readonly string[]).includes('apply_sql'))
  for (const a of ['apply_db_change', 'propose_db_change', 'agent3', 'promote']) assert.ok(!(ACTIONS as readonly string[]).includes(a), a)
})

test('ZIP: no secret appears in any response, database row or Gemini request', async () => {
  const r = await post({ action: 'upload_zip', params: zipParams([...CODE_ZIP, { name: 'supabase/sql/1.sql', data: SQL_OK }]) })
  const dump = JSON.stringify([r.body, db, geminiBodies]); for (const s of SECRETS) assert.ok(!dump.includes(s), 'leaked ' + s.slice(0, 6))
})

// ---------------------------------------------------------------- durable duplicate ZIP / SQL protection
const locks = (kind?: string) => db.tasks.filter(t => t.payload && t.payload.kind === 'orchestration_lock' && (!kind || t.payload.lock === kind))
async function toAwaitingSql(u: any, runList: any[]) {
  approve(u.apId); const b = (await ok('apply', { workflow_id: u.id })).workflow.steps.agent2_apply.branch
  runList.push({ id: 9 + runList.length, name: 'CI', status: 'completed', conclusion: 'success', head_branch: b, head_sha: refs.get(b)!, html_url: '' }); runs = runList
  await ok('check_ci', { workflow_id: u.id })
}

test('durable: duplicate ZIP is blocked by a permanent lock even when the workflow is outside the 100-row list window', async () => {
  const p = zipParams(CODE_ZIP); const first = await ok('upload_zip', p); assert.equal(locks('zip').length, 1)
  const row = db.tasks.find(t => t.id === first.workflow.id)!; delete row.payload.zip.checksum // simulate: not visible to the old list-scan
  await must('upload_zip', { ...p, request_id: randomUUID() }, 409, 'duplicate_zip'); assert.equal(orchRows().length, 1)
  assert.equal(locks().every(l => !(l.payload.kind === 'orchestration' )), true)
  assert.equal((await ok('list', {})).workflows.every((w: Row) => w.id === first.workflow.id), true, 'lock rows are never listed as workflows')
})

test('durable: two parallel uploads of the same ZIP create exactly one workflow', async () => {
  const entries = CODE_ZIP; const a = zipParams(entries), b = { ...a, request_id: randomUUID() }
  const [r1, r2] = await Promise.all([post({ action: 'upload_zip', params: a }), post({ action: 'upload_zip', params: b })])
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409], JSON.stringify([r1.body, r2.body])); assert.equal(orchRows().length, 1); assert.equal(locks('zip').length, 1)
})

test('durable: a failed/cancelled ZIP workflow may be re-uploaded (atomic takeover); an active one may not', async () => {
  const p = zipParams(CODE_ZIP); const f = await ok('upload_zip', p)
  await must('upload_zip', { ...p, request_id: randomUUID() }, 409, 'duplicate_zip')
  await ok('cancel', { workflow_id: f.workflow.id })
  const again = await ok('upload_zip', { ...p, request_id: randomUUID() }); assert.notEqual(again.workflow.id, f.workflow.id)
  assert.equal(locks('zip').length, 1); assert.equal(locks('zip')[0].payload.holder, again.workflow.id)
  await must('upload_zip', { ...p, request_id: randomUUID() }, 409, 'duplicate_zip')
})

test('durable: an applied migration is permanently blocked in later uploads (no list window needed)', async () => {
  const u = await zipUp([...CODE_ZIP, { name: 'supabase/sql/001.sql', data: SQL_OK }]); await toAwaitingSql(u, [])
  approve(sqlApprovals()[0].id); sqlWritesAllowed = true; await ok('apply_sql', { workflow_id: u.id, db_ack: 'RUN-SQL' })
  assert.equal(locks('sql').length, 1); assert.equal(locks('sql')[0].payload.status, 'applied')
  const row = db.tasks.find(t => t.id === u.id)!; row.payload.steps.sql.items.forEach((i: Row) => { i.status = 'pending' }) // hide from old scan
  const u2 = await zipUp([{ name: 'src/Other.js', data: 'export const o = 1\n' }, { name: 'supabase/sql/001.sql', data: SQL_OK }])
  assert.equal(u2.wf.zip.sql[0].status, 'blocked'); assert.match(u2.wf.zip.sql[0].reason, /already applied/); assert.equal(sqlExec.length, 1)
})

test('durable: two workflows holding the same reviewed migration - the second can never execute it', async () => {
  const u1 = await zipUp([...CODE_ZIP, { name: 'supabase/sql/001.sql', data: SQL_OK }])
  const u2 = await zipUp([{ name: 'src/Other.js', data: 'export const o = 1\n' }, { name: 'supabase/sql/001.sql', data: SQL_OK }], { title: 'ZIP: second workflow' })
  assert.equal(u1.wf.zip.sql[0].status, 'reviewed'); assert.equal(u2.wf.zip.sql[0].status, 'reviewed')
  const rl: any[] = []; await toAwaitingSql(u1, rl); await toAwaitingSql(u2, rl)
  for (const a of sqlApprovals()) approve(a.id); sqlWritesAllowed = true
  await ok('apply_sql', { workflow_id: u1.id, db_ack: 'RUN-SQL' }); assert.equal(sqlExec.length, 1)
  await must('apply_sql', { workflow_id: u2.id, db_ack: 'RUN-SQL' }, 409, 'sql_duplicate'); assert.equal(sqlExec.length, 1, 'identical SQL never runs twice'); assert.equal(stageOf(u2.id), 'failed')
})

test('durable: parallel apply_sql of the same workflow executes once; a definitively failed migration is released for a later retry', async () => {
  const u = await zipUp([...CODE_ZIP, { name: 'supabase/sql/001.sql', data: SQL_OK }]); await toAwaitingSql(u, [])
  approve(sqlApprovals()[0].id); sqlWritesAllowed = true
  const rs = await Promise.all([post({ action: 'apply_sql', params: { workflow_id: u.id, db_ack: 'RUN-SQL' } }), post({ action: 'apply_sql', params: { workflow_id: u.id, db_ack: 'RUN-SQL' } })])
  assert.equal(rs.filter(r => r.status === 200).length, 1, JSON.stringify(rs.map(r => r.body))); assert.equal(sqlExec.length, 1)
  // failure path releases the lock
  const f = await zipUp([{ name: 'src/F.js', data: 'export const f = 1\n' }, { name: 'supabase/sql/009.sql', data: 'create table if not exists ai_control.f_notes (id int);' }], { title: 'ZIP: failing sql' }); await toAwaitingSql(f, [])
  approve(sqlApprovals().find(a => a.details.sql.includes('f_notes'))!.id); sqlFail = true
  const bad = await post({ action: 'apply_sql', params: { workflow_id: f.id, db_ack: 'RUN-SQL' } }); assert.ok(bad.status >= 400)
  assert.equal(locks('sql').find(l => l.payload.path === 'supabase/sql/009.sql')!.payload.status, 'failed')
})

// ================================================================ Phase 3 Part 1 - automatic coordination, sensitive-only approval
const greenRuns = (id: string) => { const b = db.tasks.find(t => t.id === id)!.payload.steps.agent2_apply.branch as string; runs = [{ id: 9, name: 'CI', status: 'completed', conclusion: 'success', head_branch: b, head_sha: refs.get(b)!, html_url: '' }]; return b }
const logsOf = (id: string) => db.activity_logs.filter(l => l.task_id === id && String(l.action).startsWith('orchestrator_'))

test('auto 1+5: routine stages run without any owner action; a successful workflow shows only "Successful" and writes no success/info log', async () => {
  const s = await started(); approve(s.apId)
  const a1 = await ok('advance', { workflow_id: s.id }); assert.equal(a1.workflow.stage, 'ci_waiting'); assert.equal(a1.waiting.for, 'ci')
  const br = greenRuns(s.id); vDeps.unshift({ uid: 'd2', readyState: 'READY', target: 'preview', created: Date.now(), meta: { githubCommitRef: br } })
  const a2 = await ok('advance', { workflow_id: s.id })
  assert.equal(a2.workflow.stage, 'completed'); assert.equal(a2.workflow.report.verdict, 'healthy'); assert.equal(a2.workflow.outcome, 'Successful'); assert.deepEqual(a2.workflow.events, [], 'no event log for a successful run'); assert.equal(a2.waiting, null)
  assert.equal(db.approvals.length, 1, 'no extra approval for CI check / verification'); assert.equal(agentBranches().length, 1)
  assert.ok(logsOf(s.id).every(l => l.level !== 'success' && l.level !== 'info'), JSON.stringify(logsOf(s.id)))
  assert.ok(a2.workflow.tasks.every((t: Row) => t.status === 'Successful'), JSON.stringify(a2.workflow.tasks))
  assert.equal((await ok('list', {})).workflows[0].outcome, 'Successful')
})

test('auto 2+10: code approval stays mandatory - advance never writes to GitHub until the owner approved, and records the owner decision', async () => {
  const s = await started()
  const w = await ok('advance', { workflow_id: s.id }); assert.equal(w.waiting.for, 'owner_approval'); assert.equal(w.workflow.stage, 'awaiting_approval'); assert.equal(ghWrites.length, 0); assert.equal(agentBranches().length, 0)
  assert.equal(w.workflow.pending_approvals[0].kind, 'code_change'); assert.equal(w.workflow.outcome, 'Waiting for owner')
  assert.equal(db.approvals.find(a => a.id === s.apId)!.status, 'pending', 'the Orchestrator never decides an approval')
  approve(s.apId); const r = await ok('advance', { workflow_id: s.id }); assert.equal(r.workflow.stage, 'ci_waiting')
  const dec = db.tasks.find(t => t.id === s.id)!.payload.steps.approval.decision
  assert.equal(dec.decided_by, 'user-owner'); assert.equal(dec.approval_id, s.apId); assert.match(dec.operation, /agent2\/\* branch/)
})

test('auto 2: sensitive files (Agent 2 list and Orchestrator additions) never run without the explicit confirmation', async () => {
  for (const path of ['.github/workflows/ci.yml', 'api/health.js', 'src/auth/login.js']) {
    resetAll()
    const s = await started({ files: [{ path, op: 'create', content: '// x\n' }] })
    assert.equal(s.wf.approval_policy.sensitive_paths[0], path); assert.equal(s.wf.pending_approvals[0].sensitive, true)
    approve(s.apId)
    const w = await ok('advance', { workflow_id: s.id }); assert.equal(w.waiting.for, 'sensitive_confirmation', path); assert.equal(ghWrites.length, 0, path)
    await must('apply', { workflow_id: s.id }, 403, 'sensitive_ack')
    const r = await ok('advance', { workflow_id: s.id, sensitive_ack: 'APPROVE-SENSITIVE' }); assert.equal(r.workflow.stage, 'ci_waiting', path)
  }
})

test('auto 2: SQL is never auto-approved; destructive SQL never auto-runs; approved non-destructive SQL runs by itself', async () => {
  const u = await zipUp([...CODE_ZIP, { name: 'supabase/sql/001.sql', data: SQL_OK }]); approve(u.apId)
  await ok('advance', { workflow_id: u.id }); greenRuns(u.id)
  const w = await ok('advance', { workflow_id: u.id }); assert.equal(w.workflow.stage, 'awaiting_sql'); assert.equal(w.waiting.for, 'owner_approval')
  assert.equal(sqlApprovals()[0].status, 'pending'); assert.equal(sqlExec.length, 0); assert.equal(w.workflow.pending_approvals[0].kind, 'db_change')
  approve(sqlApprovals()[0].id); sqlWritesAllowed = true
  const r = await ok('advance', { workflow_id: u.id }); assert.equal(r.workflow.stage, 'completed'); assert.equal(sqlExec.length, 1)
  assert.equal(db.tasks.find(t => t.id === u.id)!.payload.steps.sql.items[0].decision.decided_by, 'user-owner')
  resetAll()
  const d = await zipUp([...CODE_ZIP, { name: 'supabase/sql/002.sql', data: "delete from ai_control.deploy_notes where note = 'x';" }], { title: 'ZIP: destructive' }); approve(d.apId)
  await ok('advance', { workflow_id: d.id }); greenRuns(d.id); await ok('advance', { workflow_id: d.id }); approve(sqlApprovals()[0].id); sqlWritesAllowed = true
  const x = await ok('advance', { workflow_id: d.id }); assert.equal(x.waiting.for, 'destructive_confirmation'); assert.equal(sqlExec.length, 0)
  const y = await ok('advance', { workflow_id: d.id, destructive_ack: 'APPROVE-DESTRUCTIVE' }); assert.equal(y.workflow.stage, 'completed'); assert.equal(sqlExec.length, 1)
})

test('auto 3+6: unauthorized callers and actions stay blocked; an approval not decided by an owner is refused; an unreadable approval is not approval', async () => {
  const s = await started(); approve(s.apId)
  assert.equal((await post({ action: 'advance', params: { workflow_id: s.id } }, 'tok-other')).status, 403)
  for (const a of ['promote', 'merge', 'agent3', 'apply_db_change', 'run_sql']) await must(a, { workflow_id: s.id }, 400, 'unknown_action')
  db.approvals.find(a => a.id === s.apId)!.decided_by = 'user-not-owner'
  const r = await post({ action: 'advance', params: { workflow_id: s.id } }); assert.equal(r.status, 200); assert.equal((r.body as any).workflow.failure.code, 'approval_not_owner'); assert.equal(ghWrites.length, 0); assert.equal(agentBranches().length, 0)
  resetAll(); const t = await started(); approve(t.apId)
  const orig = globalThis.fetch
  globalThis.fetch = (async (i: any, init: any) => String(i).includes('/rest/v1/approvals') ? json({ message: 'down' }, 500) : (orig as any)(i, init)) as any
  try { const w = await post({ action: 'advance', params: { workflow_id: t.id } }); const b: any = w.body; assert.ok(w.status >= 400 || (b.waiting && b.waiting.for === 'approval_unavailable'), JSON.stringify(b)); assert.equal(ghWrites.length, 0); assert.equal(agentBranches().length, 0) } finally { globalThis.fetch = orig }
  assert.equal(stageOf(t.id), 'awaiting_approval')
})

test('auto 4+6: a failed task shows agent, stage, task, real error and recovery guidance; dependent tasks are blocked and Agent 1 never starts', async () => {
  const s = await started(); approve(s.apId); await ok('advance', { workflow_id: s.id })
  const b = db.tasks.find(t => t.id === s.id)!.payload.steps.agent2_apply.branch
  runs = [{ id: 9, name: 'CI', status: 'completed', conclusion: 'failure', head_branch: b, head_sha: refs.get(b)!, html_url: '' }]
  const r = await ok('advance', { workflow_id: s.id }); const w = r.workflow, f = w.failure
  assert.equal(w.outcome, 'Failed'); assert.equal(f.agent, 'agent2'); assert.equal(f.stage, 'ci_waiting'); assert.equal(f.task, 'GitHub CI'); assert.equal(f.code, 'ci_failed'); assert.match(f.message, /CI failed/); assert.match(f.message, /test-build \(npm test\)/); assert.ok(f.recovery.length > 20); assert.equal(f.retryable, false)
  const t = Object.fromEntries(w.tasks.map((x: Row) => [x.key, x])); assert.equal(t.ci.status, 'Failed'); assert.equal(t.agent1_verify.status, 'Blocked'); assert.equal(t.agent1_verify.blocked_by, 'ci'); assert.equal(t.agent2_apply.status, 'Successful')
  assert.equal(a1Used(), false, 'Agent 1 never starts after a failed CI'); await must('retry', { workflow_id: s.id }, 409, 'not_retryable')
  // The full error log of the failed step is carried (no timestamps, no other steps, no secrets); a passing CI carries none.
  assert.match(f.log, /Cannot find module \.\/missing/); assert.match(f.log, /ERROR: Process completed with exit code 1\./); assert.match(f.log, /> Run npm run build/)
  assert.doesNotMatch(f.log, /actions\/checkout|cleanup noise|2026-11-17T|ghp_abc/)
  assert.ok(logsOf(s.id).some(l => l.level === 'error'))
})

test('auto 7: transient read failures retry safely without a second commit; permanent failures are not retried; commit stage is never retried', async () => {
  const s = await started(); approve(s.apId); await ok('advance', { workflow_id: s.id }); greenRuns(s.id)
  const orig = globalThis.fetch; let down = true
  globalThis.fetch = (async (i: any, init: any) => down && String(i).includes('/actions/runs') ? json({ message: 'unavailable' }, 503) : (orig as any)(i, init)) as any
  try {
    for (let n = 1; n <= 2; n++) { const w = await ok('advance', { workflow_id: s.id }); assert.equal(w.workflow.stage, 'ci_waiting'); assert.equal(w.workflow.steps.ci.read_retries, n); assert.equal(w.waiting.for, 'ci') }
    const f = await ok('advance', { workflow_id: s.id }); assert.equal(f.workflow.stage, 'failed'); assert.equal(f.workflow.failure.retryable, true); assert.match(f.workflow.failure.recovery, /Retry/)
    down = false
    const r = await ok('retry', { workflow_id: s.id }); assert.equal(r.workflow.stage, 'completed'); assert.equal(r.workflow.retries, 1)
  } finally { globalThis.fetch = orig }
  assert.equal(agentBranches().length, 1, 'no second branch'); assert.equal(ghWrites.filter(w => w.path === '/git/commits').length, 1, 'no second commit')
  await must('retry', { workflow_id: s.id }, 409, 'wrong_stage')
  resetAll(); const t = await started(); approve(t.apId); failNextBlob = true
  await post({ action: 'advance', params: { workflow_id: t.id } }); assert.equal(stageOf(t.id), 'failed'); await must('retry', { workflow_id: t.id }, 409, 'not_retryable'); assert.equal(agentBranches().length, 0)
})

test('auto 7: safe retry of Agent 1 verification keeps completed steps and never repeats the commit', async () => {
  const s = await started(); approve(s.apId); await ok('advance', { workflow_id: s.id }); greenRuns(s.id)
  failAgent1Db = true; vercelDown = true
  const orig = globalThis.fetch
  globalThis.fetch = (async (i: any, init: any) => String(i).includes('api.vercel.com') || String(i).includes('api.supabase.com') ? json({ message: 'unavailable' }, 503) : (orig as any)(i, init)) as any
  try { await post({ action: 'advance', params: { workflow_id: s.id } }) } finally { globalThis.fetch = orig }
  failAgent1Db = false; vercelDown = false
  const st = stageOf(s.id)
  if (st === 'failed') { const w = db.tasks.find(t => t.id === s.id)!.payload; assert.equal(w.failure.stage, 'verifying'); assert.equal(w.failure.retryable, true); const r = await ok('retry', { workflow_id: s.id }); assert.equal(r.workflow.stage, 'completed') } else { assert.equal(st, 'completed') }
  assert.equal(agentBranches().length, 1); assert.equal(ghWrites.filter(w => w.path === '/git/commits').length, 1)
})

test('auto 8: expired code and SQL approvals are rejected; nothing runs', async () => {
  const s = await started(); approve(s.apId, new Date(Date.now() - 25 * 3600 * 1000).toISOString())
  const r: any = await ok('advance', { workflow_id: s.id }); assert.equal(r.workflow.failure.code, 'expired'); assert.equal(ghWrites.length, 0); assert.match(r.workflow.failure.recovery, /expired|24 hours/)
  resetAll(); const u = await zipUp([...CODE_ZIP, { name: 'supabase/sql/001.sql', data: SQL_OK }]); approve(u.apId); await ok('advance', { workflow_id: u.id }); greenRuns(u.id); await ok('advance', { workflow_id: u.id })
  approve(sqlApprovals()[0].id, new Date(Date.now() - 25 * 3600 * 1000).toISOString()); sqlWritesAllowed = true
  const x: any = await ok('advance', { workflow_id: u.id }); assert.equal(x.workflow.failure.code, 'sql_approval_expired'); assert.equal(sqlExec.length, 0)
})

test('auto 9+11: Agent 3 is never imported, called or started; Orchestrator routes only Agent 1 and Agent 2; allow-lists are unchanged', async () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  for (const f of readdirSync(srcDir).filter(x => x.endsWith('.ts') && !x.endsWith('.test.ts'))) {
    const src = readFileSync(join(srcDir, f), 'utf8'); assert.ok(!/from ['"][^'"]*agent3/.test(src), f + ' imports agent3'); assert.ok(!/AGENT3_/.test(src), f + ' reads Agent 3 env')
  }
  const { ROUTES } = await import('./policy.js'); assert.ok(Object.values(ROUTES).every(r => r.agent === 'agent1' || r.agent === 'agent2'))
  assert.deepEqual([...A1_ALLOWED], ['health_report']); assert.deepEqual([...A2_ALLOWED], ['propose_change', 'ai_fix', 'apply_change', 'actions_status'])
  const s = await started(); approve(s.apId); await ok('advance', { workflow_id: s.id }); greenRuns(s.id); await ok('advance', { workflow_id: s.id })
  assert.equal(db.agents[2].status, 'offline'); assert.ok(!allUrls.some(x => /agent3/i.test(x))); assert.ok(!db.approvals.some(a => ['promote', 'workflow_run', 'redeploy', 'rollback', 'env_change'].includes(a.details.kind))); assert.equal(prs.length, 0); assert.equal(refs.get('main'), db.tasks.find(t => t.id === s.id)!.payload.steps.agent2_propose.base ? refs.get('main') : refs.get('main'))
})

test('auto 7: parallel advance calls never duplicate the commit or SQL run', async () => {
  const s = await started(); approve(s.apId)
  const rs = await Promise.all([post({ action: 'advance', params: { workflow_id: s.id } }), post({ action: 'advance', params: { workflow_id: s.id } }), post({ action: 'advance', params: { workflow_id: s.id } })])
  assert.ok(rs.every(r => r.status === 200), JSON.stringify(rs.map(r => r.body))); assert.equal(agentBranches().length, 1); assert.equal(ghWrites.filter(w => w.path === '/git/commits').length, 1)
})

test('auto: an interrupted read-only step can be retried; an interrupted commit step cannot', async () => {
  const s = await applied(); greenRuns(s.id)
  const row = db.tasks.find(t => t.id === s.id)!; row.payload.stage = 'verifying'; row.payload.steps.ci.state = 'passing'; row.payload.steps.agent1_verify = { status: 'running' }; row.updated_at = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const g: any = await ok('get', { workflow_id: s.id }); assert.equal(g.workflow.failure.code, 'interrupted'); assert.equal(g.workflow.failure.retryable, true); assert.match(g.workflow.failure.recovery, /safe to press Retry/)
  const r = await ok('retry', { workflow_id: s.id }); assert.equal(r.workflow.stage, 'completed')
  resetAll(); const t = await started(); approve(t.apId); const row2 = db.tasks.find(x => x.id === t.id)!; row2.payload.stage = 'applying'; row2.payload.steps.agent2_apply = { status: 'running' }; row2.updated_at = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const g2: any = await ok('get', { workflow_id: t.id }); assert.equal(g2.workflow.failure.retryable, false); assert.match(g2.workflow.failure.recovery, /NOT retried automatically/); await must('retry', { workflow_id: t.id }, 409, 'not_retryable')
})

// ================================================================ Phase 3 Part 2 hardening (protected paths, uncertain SQL, durable commit lock, Gemini config)
test('hardening: an uploaded ZIP can never change the deployment workflow\'s own security rules (create/update/delete refused, nothing stored)', async () => {
  const bad: [string, ZE[]][] = [
    ['agent2 guard', [...CODE_ZIP, { name: 'agent2/guard.ts', data: 'export const x = 1\n' }]],
    ['orchestrator', [...CODE_ZIP, { name: 'orchestrator/policy.ts', data: 'export const x = 1\n' }]],
    ['agent1 checks', [...CODE_ZIP, { name: 'agent1/checks.ts', data: 'export const x = 1\n' }]],
    ['api entry', [...CODE_ZIP, { name: 'api/orchestrator.js', data: 'export default 1\n' }]],
    ['ci workflow', [...CODE_ZIP, { name: '.github/workflows/ci.yml', data: 'name: x\n' }]],
    ['case trick', [...CODE_ZIP, { name: 'Agent2/guard.ts', data: 'x\n' }]],
    ['delete manifest', [...CODE_ZIP, { name: '.blisscco-delete.txt', data: 'orchestrator/workflow.ts\n' }]]
  ]
  for (const [name, entries] of bad) { const r = await post({ action: 'upload_zip', params: zipParams(entries) }); assert.equal(r.status, 403, name + JSON.stringify(r.body)); assert.equal((r.body as any).code, 'protected_path', name) }
  assert.equal(orchRows().length, 0); assert.equal(locks().length, 0); assert.equal(ghWrites.length, 0); assert.equal(db.approvals.length, 0)
  await ok('upload_zip', zipParams(CODE_ZIP)) // normal files still work
})

test('hardening: Gemini limits are configurable, clamped, and omitted content is reported while security findings are kept', async () => {
  const { reviewLimits } = await import('../agent2/gemini.js')
  assert.deepEqual(reviewLimits({}), { maxInputChars: 14000, maxOutputTokens: 1200 })
  assert.deepEqual(reviewLimits({ AGENT2_REVIEW_MAX_INPUT_CHARS: '5000', AGENT2_REVIEW_MAX_OUTPUT_TOKENS: '300' }), { maxInputChars: 5000, maxOutputTokens: 300 })
  assert.deepEqual(reviewLimits({ AGENT2_REVIEW_MAX_INPUT_CHARS: '999999999', AGENT2_REVIEW_MAX_OUTPUT_TOKENS: '-5' }), { maxInputChars: 60000, maxOutputTokens: 1200 })
  assert.equal(reviewLimits({ AGENT2_REVIEW_MAX_INPUT_CHARS: 'abc' }).maxInputChars, 14000)
  const old = process.env.AGENT2_REVIEW_MAX_INPUT_CHARS; process.env.AGENT2_REVIEW_MAX_INPUT_CHARS = '3000'
  try {
    const big = Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n'
    const entries: ZE[] = [{ name: 'package.json', data: '{"name":"x","version":"2"}\n' }]
    for (let i = 0; i < 12; i++) entries.push({ name: `src/gen/f${i}.js`, data: big })
    const u = await zipUp(entries)
    assert.equal(u.wf.zip.gemini.input_max_chars, 3000); assert.ok(u.wf.zip.gemini.review_partial)
    assert.ok(u.wf.zip.gemini.omitted && (u.wf.zip.gemini.omitted.hunks_truncated.length + u.wf.zip.gemini.omitted.hunks_removed.length + u.wf.zip.gemini.omitted.files_dropped.length) > 0, 'omitted content is reported')
    assert.ok(geminiBodies.length >= 1); for (const b of geminiBodies) assert.ok(b.length <= 3000, 'sent ' + b.length)
    assert.ok(geminiBodies.every(b => b.includes('security_summary') || b.length <= 3000))
  } finally { if (old === undefined) delete process.env.AGENT2_REVIEW_MAX_INPUT_CHARS; else process.env.AGENT2_REVIEW_MAX_INPUT_CHARS = old }
})

test('hardening: an UNCERTAIN SQL result is never repeated; the lock stays; the same migration is blocked afterwards', async () => {
  const u = await zipUp([...CODE_ZIP, { name: 'supabase/sql/001.sql', data: SQL_OK }]); await toAwaitingSql(u, [])
  approve(sqlApprovals()[0].id); sqlWritesAllowed = true; sqlFail = true; sqlFailStatus = 500
  const r = await post({ action: 'apply_sql', params: { workflow_id: u.id, db_ack: 'RUN-SQL' } })
  assert.equal(r.status, 502); assert.equal((r.body as any).code, 'sql_uncertain'); assert.match((r.body as any).error || (r.body as any).message || JSON.stringify(r.body), /UNCERTAIN/)
  assert.equal(sqlExec.length, 1); assert.equal(stageOf(u.id), 'failed')
  const w = db.tasks.find(t => t.id === u.id)!.payload; assert.equal(w.steps.sql.items[0].status, 'uncertain'); assert.equal(w.failure.retryable, false)
  assert.equal(locks('sql')[0].payload.status, 'uncertain', 'lock is NOT released')
  sqlFail = false
  await must('apply_sql', { workflow_id: u.id, db_ack: 'RUN-SQL' }, 409, 'wrong_stage'); await must('retry', { workflow_id: u.id }, 409, 'not_retryable'); assert.equal(sqlExec.length, 1)
  const u2 = await zipUp([{ name: 'src/Other.js', data: 'export const o = 1\n' }, { name: 'supabase/sql/001.sql', data: SQL_OK }])
  assert.equal(u2.wf.zip.sql[0].status, 'blocked'); assert.match(u2.wf.zip.sql[0].reason, /already applied/)
  // a definitive SQL error (4xx) is still released for a corrected retry
  const f = await zipUp([{ name: 'src/F.js', data: 'export const f = 1\n' }, { name: 'supabase/sql/009.sql', data: 'create table if not exists ai_control.f2_notes (id int);' }], { title: 'ZIP: definitive failure' }); await toAwaitingSql(f, [])
  approve(sqlApprovals().find(a => a.details.sql.includes('f2_notes'))!.id); sqlFail = true; sqlFailStatus = 400
  await post({ action: 'apply_sql', params: { workflow_id: f.id, db_ack: 'RUN-SQL' } })
  assert.equal(locks('sql').find(l => l.payload.path === 'supabase/sql/009.sql')!.payload.status, 'failed')
})

test('hardening: durable commit lock - the same change set is committed once, ever (even from a different ZIP)', async () => {
  const u = await zipToCi(CODE_ZIP); assert.equal(locks('commit').length, 1); assert.equal(locks('commit')[0].payload.status, 'committed'); assert.equal(locks('commit')[0].payload.commit_sha, refs.get(u.branch))
  const commitsBefore = ghWrites.filter(w => /git\/commits$/.test(w.path) && w.method === 'POST').length
  // Same file contents, different archive bytes (extra README entry is a different change set only if it differs) -> rebuild with a comment-free reorder + ignored entry
  const second = await ok('upload_zip', zipParams([{ name: '__MACOSX/._x', data: 'junk' }, ...[...CODE_ZIP].reverse()], { title: 'ZIP: same content again' }))
  approve(second.workflow.steps.approval.id)
  await must('apply', { workflow_id: second.workflow.id }, 409, 'commit_duplicate')
  assert.equal(stageOf(second.workflow.id), 'failed'); assert.equal(ghWrites.filter(w => /git\/commits$/.test(w.path) && w.method === 'POST').length, commitsBefore, 'no second commit')
})

test('hardening: a ZIP whose earlier workflow already committed is NOT re-uploadable after it failed (no accidental duplicate)', async () => {
  const p = zipParams(CODE_ZIP); const f = await ok('upload_zip', p); approve(f.workflow.steps.approval.id)
  const b = (await ok('apply', { workflow_id: f.workflow.id })).workflow.steps.agent2_apply.branch
  runs = [{ id: 9, name: 'CI', status: 'completed', conclusion: 'failure', head_branch: b, head_sha: refs.get(b)!, html_url: '' }]
  await post({ action: 'check_ci', params: { workflow_id: f.workflow.id } }); assert.equal(stageOf(f.workflow.id), 'failed')
  await must('upload_zip', { ...p, request_id: randomUUID() }, 409, 'duplicate_zip')
})

test('hardening: Agent 3 stays independent (not imported, not called) after the hardening changes', async () => {
  const u = await zipToCi([...CODE_ZIP, { name: 'supabase/sql/001.sql', data: SQL_OK }]); void u
  assert.equal(db.agents[2].status, 'offline'); assert.ok(!allUrls.some(x => /agent3/i.test(x)))
  for (const f of ['workflow.ts', 'policy.ts', 'zip.ts', 'store.ts']) assert.ok(!/agent3/i.test(readFileSync(join(srcDir(), f), 'utf8')) || f === 'workflow.ts' || f === 'policy.ts', f)
})

// ================================================================ Phase 3 Part 3 - persistent monitoring, recovery, health
const rowOf = (id: string) => db.tasks.find(t => t.id === id)!
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString()
const mon = async () => (await ok('monitor', {}))
const allTasks = (m: Row) => [...m.tasks.running, ...m.tasks.recent_succeeded, ...m.tasks.recent_failed] as Row[]

test('part3: green dot - based on persisted pending approvals; multiple, resolved, rejected, expired; survives refresh/restart; nothing auto-approved', async () => {
  assert.equal((await mon()).approvals.pending_count, 0)
  const a = await started(); assert.equal((await mon()).approvals.pending_count, 1)
  const b = await started({ title: 'Second change', files: [{ path: 'src/Two.js', op: 'create', content: 'x\n' }] }); const m2 = await mon()
  assert.equal(m2.approvals.pending_count, 2); assert.deepEqual(m2.approvals.pending.map((x: Row) => x.id).sort(), [a.apId, b.apId].sort())
  assert.equal((await mon()).approvals.pending_count, 2, 'a refresh / restart (fresh request, no in-memory state) shows the same indicator')
  approve(a.apId); assert.equal((await mon()).approvals.pending_count, 1)
  db.approvals.find(x => x.id === b.apId)!.status = 'expired'; assert.equal((await mon()).approvals.pending_count, 0, 'expired is not pending')
  const c = await started({ title: 'Third', files: [{ path: 'src/Three.js', op: 'create', content: 'y\n' }] }); assert.equal((await mon()).approvals.pending_count, 1)
  db.approvals.find(x => x.id === c.apId)!.status = 'rejected'; assert.equal((await mon()).approvals.pending_count, 0)
  assert.ok(db.approvals.every(x => x.status !== 'pending'), 'monitoring never decides an approval'); assert.equal(agentBranches().length, 0)
})

test('part3: running tasks stay visible past five minutes; finished/failed tasks stay >= 5 min from THEIR stored end time; refresh never resets the countdown; audit rows survive', async () => {
  const s = await applied() // CI step is running
  rowOf(s.id).payload.steps.agent2_apply.finished_at = ago(3600); rowOf(s.id).updated_at = ago(3600)
  let m = await mon(); const ci = m.tasks.running.find((t: Row) => t.key === 'ci'); assert.ok(ci, 'a running task remains visible after an hour'); assert.equal(ci.remaining_s, null)
  // success
  const done = await zipToCi(CODE_ZIP); let m2 = await mon()
  const ver = m2.tasks.recent_succeeded.find((t: Row) => t.workflow_id === done.id && t.key === 'agent1_verify'); assert.ok(ver); assert.ok(ver.remaining_s > 290 && ver.remaining_s <= 300, 'fresh success: ~5 min left'); assert.equal(m2.retention_seconds, 300)
  const stepEnd = (k: string) => rowOf(done.id).payload.steps[k]
  stepEnd('agent1_verify').finished_at = ago(200)
  const r1 = (await mon()).tasks.recent_succeeded.find((t: Row) => t.workflow_id === done.id && t.key === 'agent1_verify').remaining_s
  const r2 = (await mon()).tasks.recent_succeeded.find((t: Row) => t.workflow_id === done.id && t.key === 'agent1_verify').remaining_s
  assert.ok(r1 >= 98 && r1 <= 100 && r2 <= r1 && r2 >= 97, `countdown is derived from the stored timestamp, not reset by refresh (${r1}, ${r2})`)
  stepEnd('agent1_verify').finished_at = ago(299); assert.ok((await mon()).tasks.recent_succeeded.some((t: Row) => t.workflow_id === done.id && t.key === 'agent1_verify'), 'still visible just under five minutes')
  stepEnd('agent1_verify').finished_at = ago(400); rowOf(done.id).finished_at = ago(400); rowOf(done.id).updated_at = ago(400)
  assert.ok(!(await mon()).tasks.recent_succeeded.some((t: Row) => t.workflow_id === done.id && t.key === 'agent1_verify'), 'display entry expires')
  assert.ok(rowOf(done.id) && rowOf(done.id).payload.stage === 'completed' && db.approvals.length > 0, 'permanent audit records are untouched')
  assert.equal(retentionSeconds({ ORCH_VISIBILITY_SECONDS: '10' }), 300, 'never below five minutes'); assert.equal(retentionSeconds({ ORCH_VISIBILITY_SECONDS: '900' }), 900)
  // failure
  const f = await applied({ title: 'will fail' , files: [{ path: 'src/Fail.js', op: 'create', content: 'f\n' }] }); ciOverride = 'failing'
  await post({ action: 'check_ci', params: { workflow_id: f.id } }); assert.equal(stageOf(f.id), 'failed')
  const mf = await mon(); const ft = mf.tasks.recent_failed.find((t: Row) => t.workflow_id === f.id); assert.ok(ft, 'failed task visible'); assert.match(ft.error, /CI failed/); assert.ok(ft.remaining_s > 290)
  rowOf(f.id).payload.failure.at = ago(400)
  assert.ok(!(await mon()).tasks.recent_failed.some((t: Row) => t.workflow_id === f.id), 'failed entry expires after 5 min'); assert.ok(rowOf(f.id).payload.failure, 'failure record is kept')
  void allTasks
})

test('part3: interrupted workflows are detected; an interrupted commit is VERIFIED on GitHub, found commits are never repeated, missing commits release the lock', async () => {
  const u = await zipUp(CODE_ZIP); approve(u.apId); const b = (await ok('apply', { workflow_id: u.id })).workflow.steps.agent2_apply.branch
  const commit = refs.get(b)!; const writes = ghWrites.length
  // rewind the stored state to "crashed while applying": the commit really exists on GitHub
  const row = rowOf(u.id); row.payload.stage = 'applying'; row.status = 'running'; row.payload.steps.agent2_apply = { status: 'running', agent: 'agent2', started_at: ago(900) }; delete row.payload.steps.ci; row.updated_at = ago(900)
  const m = await mon(); assert.equal(m.interrupted.length, 1); assert.equal(m.interrupted[0].action, 'verify_commit'); assert.equal(m.interrupted[0].uncertain, true); assert.equal(m.failures.length, 1)
  const r = await ok('resume', { workflow_id: u.id }); assert.equal(r.verified, 'commit_found'); assert.equal(r.workflow.stage, 'ci_waiting')
  assert.equal(rowOf(u.id).payload.steps.agent2_apply.commit_sha, commit); assert.equal(ghWrites.length, writes, 'the completed commit was NOT repeated'); assert.equal(refs.get(b), commit)
  assert.equal((await mon()).interrupted.length, 0)
  // second case: crashed before anything reached GitHub
  const v = await zipUp([{ name: 'src/Zed.js', data: 'z\n' }], { title: 'crash before commit' }); approve(v.apId); const b2 = (await ok('apply', { workflow_id: v.id })).workflow.steps.agent2_apply.branch
  refs.delete(b2); const r2 = rowOf(v.id); r2.payload.stage = 'applying'; r2.payload.steps.agent2_apply = { status: 'running' }; delete r2.payload.steps.ci; r2.updated_at = ago(900)
  const x = await ok('resume', { workflow_id: v.id }); assert.equal(x.verified, 'no_commit'); assert.equal(x.resumed, false); assert.equal(stageOf(v.id), 'failed')
  assert.equal(locks('commit').find(l => l.payload.holder === v.id)!.payload.status, 'failed', 'commit lock released only after proving nothing was committed')
  await must('resume', { workflow_id: v.id }, 200)
})

test('part3: a safe read-only interruption resumes and completes without repeating any earlier operation', async () => {
  const u = await zipToCi(CODE_ZIP); const writes = ghWrites.length; const sqlN = sqlExec.length
  const row = rowOf(u.id); row.payload.stage = 'verifying'; row.status = 'running'; row.payload.steps.agent1_verify = { status: 'running', agent: 'agent1', started_at: ago(900) }; delete row.payload.steps.agent1_verify.finished_at; delete row.result; row.finished_at = null; row.updated_at = ago(900)
  assert.equal((await mon()).interrupted[0].action, 'retry_read_only')
  const r = await ok('resume', { workflow_id: u.id }); assert.equal(r.workflow.stage, 'completed'); assert.equal(ghWrites.length, writes); assert.equal(sqlExec.length, sqlN); assert.equal(agentBranches().length, 1)
})

test('part3: uncertain SQL is verified before any retry; proven-not-run goes back to approval (never automatic when destructive); owner confirmation resolves the rest', async () => {
  // (a) uncertain (5xx): resume cannot prove anything -> nothing re-run; owner attests "applied" -> continues to verification
  const u = await zipUp([...CODE_ZIP, { name: 'supabase/sql/001.sql', data: SQL_OK }]); await toAwaitingSql(u, [])
  approve(sqlApprovals()[0].id); sqlWritesAllowed = true; sqlFail = true; sqlFailStatus = 500
  await must('apply_sql', { workflow_id: u.id, db_ack: 'RUN-SQL' }, 502, 'sql_uncertain'); assert.equal(sqlExec.length, 1); sqlFail = false
  const m = await mon(); assert.equal(m.interrupted[0].action, 'verify_sql'); assert.equal(m.interrupted[0].uncertain, true)
  const v = await ok('resume', { workflow_id: u.id }); assert.equal(v.verified, 'uncertain'); assert.equal(sqlExec.length, 1, 'verification never re-runs SQL'); assert.equal(stageOf(u.id), 'failed')
  await must('resolve_sql', { workflow_id: u.id, path: 'supabase/sql/001.sql', outcome: 'applied' }, 403, 'ack'); assert.equal(sqlExec.length, 1)
  await must('resolve_sql', { workflow_id: u.id, path: 'nope.sql', outcome: 'applied', ack: 'VERIFIED-IN-SUPABASE' }, 409)
  const fin = await ok('resolve_sql', { workflow_id: u.id, path: 'supabase/sql/001.sql', outcome: 'applied', ack: 'VERIFIED-IN-SUPABASE' })
  assert.equal(fin.workflow.stage, 'completed'); assert.equal(sqlExec.length, 1, 'confirmed-applied migration is not executed again'); assert.equal(locks('sql')[0].payload.status, 'applied')
  assert.equal(rowOf(u.id).payload.steps.sql.items[0].resolved.outcome, 'applied')
  // (b) owner says NOT applied: stays failed, lock released, approval cannot be reused
  const w = await zipUp([{ name: 'src/W2.js', data: 'w\n' }, { name: 'supabase/sql/002.sql', data: 'create table if not exists ai_control.w2_notes (id int);' }], { title: 'second sql' }); await toAwaitingSql(w, [])
  approve(sqlApprovals().find(a => a.details.sql.includes('w2_notes'))!.id); sqlFail = true; sqlFailStatus = 503
  await post({ action: 'apply_sql', params: { workflow_id: w.id, db_ack: 'RUN-SQL' } }); sqlFail = false
  const n = await ok('resolve_sql', { workflow_id: w.id, path: 'supabase/sql/002.sql', outcome: 'not_applied', ack: 'VERIFIED-IN-SUPABASE' })
  assert.equal(n.workflow.stage, 'failed'); assert.equal(locks('sql').find(l => l.payload.path === 'supabase/sql/002.sql')!.payload.status, 'failed'); assert.equal(sqlExec.length, 2)
  // (c) definitive 4xx failure of a DESTRUCTIVE migration: proven not run -> back to approval; never executes by itself
  const d = await zipUp([{ name: 'src/D.js', data: 'd\n' }, { name: 'supabase/sql/003.sql', data: "delete from ai_control.deploy_notes where note = 'x';" }], { title: 'destructive' }); await toAwaitingSql(d, [])
  approve(sqlApprovals().find(a => a.details.sql.includes('delete from'))!.id); sqlFail = true; sqlFailStatus = 400
  await post({ action: 'apply_sql', params: { workflow_id: d.id, db_ack: 'RUN-SQL', destructive_ack: 'APPROVE-DESTRUCTIVE' } }); sqlFail = false; const execs = sqlExec.length
  const back = await ok('resume', { workflow_id: d.id }); assert.equal(back.verified, 'not_applied'); assert.equal(stageOf(d.id), 'awaiting_sql'); assert.equal(sqlExec.length, execs)
  const adv = await ok('advance', { workflow_id: d.id }); assert.equal(adv.waiting.for, 'destructive_confirmation'); assert.equal(sqlExec.length, execs, 'destructive SQL is never retried automatically')
  await ok('apply_sql', { workflow_id: d.id, db_ack: 'RUN-SQL', destructive_ack: 'APPROVE-DESTRUCTIVE' }); assert.equal(sqlExec.length, execs + 1)
})

test('part3: controlled retries - configurable attempts, exponential backoff, total-duration cap, no retry of permanent errors, no infinite loop', async () => {
  const transient = () => new AgentError('GitHub API 503', 503, 'github_read')
  const env = { ORCH_RETRY_MAX_ATTEMPTS: '4', ORCH_RETRY_BASE_MS: '8', ORCH_RETRY_MAX_TOTAL_MS: '5000' }
  const stamps: number[] = []; let n = 0
  const v = await readOnlyWithRetry(async () => { stamps.push(Date.now()); if (++n < 3) throw transient(); return 'ok' }, env)
  assert.equal(v, 'ok'); assert.equal(n, 3); assert.ok(stamps[1] - stamps[0] >= 7 && stamps[2] - stamps[1] >= 15, 'exponential backoff: ' + stamps.map((s, i) => i ? s - stamps[i - 1] : 0))
  let calls = 0; await assert.rejects(readOnlyWithRetry(async () => { calls++; throw transient() }, env)); assert.equal(calls, 4, 'stops after the configured attempts')
  calls = 0; await assert.rejects(readOnlyWithRetry(async () => { calls++; throw new AgentError('Forbidden', 403, 'forbidden') }, env)); assert.equal(calls, 1, 'unauthorized / permanent errors are never retried')
  calls = 0; await assert.rejects(readOnlyWithRetry(async () => { calls++; throw transient() }, { ORCH_RETRY_MAX_ATTEMPTS: '6', ORCH_RETRY_BASE_MS: '50', ORCH_RETRY_MAX_TOTAL_MS: '120' })); assert.ok(calls <= 3, 'maximum total duration respected: ' + calls)
  calls = 0; await assert.rejects(readOnlyWithRetry(async () => { calls++; throw transient() }, { ORCH_RETRY_MAX_ATTEMPTS: '999', ORCH_RETRY_BASE_MS: '0' })); assert.equal(calls, 6, 'attempts are clamped (no infinite loop)')
  // manual retry limit and the never-retry list are unchanged
  const u = await zipToCi(CODE_ZIP); void u
})

test('part3: two workers cannot run the same stage (parallel apply / resume execute once)', async () => {
  const s = await started(); approve(s.apId)
  const rs = await Promise.all([post({ action: 'apply', params: { workflow_id: s.id } }), post({ action: 'apply', params: { workflow_id: s.id } }), post({ action: 'advance', params: { workflow_id: s.id } })])
  assert.ok(rs.filter(r => r.status === 200).length >= 1); assert.equal(agentBranches().length, 1); assert.equal(ghWrites.filter(w => w.method === 'POST' && w.path === '/git/commits').length, 1, 'exactly one commit')
  const row = rowOf(s.id); row.payload.stage = 'applying'; row.payload.steps.agent2_apply = { status: 'running' }; delete row.payload.steps.ci; row.updated_at = ago(900)
  const before = ghWrites.length
  await Promise.all([post({ action: 'resume', params: { workflow_id: s.id } }), post({ action: 'resume', params: { workflow_id: s.id } })])
  assert.equal(ghWrites.length, before, 'resume only reads'); assert.equal(agentBranches().length, 1)
})

test('part3: agent / integration health - states, cached polling, backoff, no secrets, Agent 3 untouched', async () => {
  process.env.ORCH_HEALTH_TTL_SCALE = '1'
  try {
    const h = await ok('health', {}); const c = h.components
    for (const k of ['orchestrator', 'agent1', 'agent2', 'gemini', 'github', 'supabase', 'vercel']) assert.equal(c[k].state, 'healthy', k + JSON.stringify(c[k]))
    assert.equal(h.agent3.independent, true); assert.ok(!allUrls.some(x => /agent3/i.test(x))); assert.equal(db.agents[2].status, 'offline')
    const body = JSON.stringify(h); for (const sct of SECRETS) assert.ok(!body.includes(sct), 'secret leaked in health')
    const n = allUrls.length; const h2 = await ok('health', {}); assert.ok(!allUrls.slice(n).some(x => /api\.github\.com|api\.vercel\.com|generativelanguage|rest\/v1\/agents/.test(x)), 'second call reuses the cache: no provider is called again'); assert.equal(h2.components.github.cached, true)
    // failure states
    resetHealthCache(); healthStatus = { github: 401, gemini: 429, vercel: 403 }
    const bad = (await ok('health', {})).components
    assert.equal(bad.github.state, 'failed'); assert.equal(bad.gemini.state, 'busy'); assert.equal(bad.vercel.state, 'failed'); assert.equal(bad.agent2.state, 'failed'); assert.equal(bad.agent1.state, 'failed'); assert.equal(bad.orchestrator.state, 'healthy')
    const m = allUrls.length; await ok('health', {}); assert.ok(!allUrls.slice(m).some(x => /api\.github\.com|api\.vercel\.com|generativelanguage/.test(x)), 'a failing service is not hammered (backoff)')
    resetHealthCache(); healthStatus = { vercel: 503 }; assert.equal((await ok('health', {})).components.vercel.state, 'unavailable')
    // not configured -> unknown; busy agent
    resetHealthCache(); healthStatus = {}; const { AGENT1_VERCEL_TOKEN: _v, ...noVercel } = ENV
    const r = await post({ action: 'health', params: {} }, 'tok-owner', noVercel); assert.equal((r.body as any).components.vercel.state, 'unknown')
    resetHealthCache(); await applied(); assert.equal((await ok('health', {})).components.agent2.state, 'busy')
    assert.equal((await post({ action: 'health', params: {} }, 'tok-other')).status, 403, 'owner only')
  } finally { delete process.env.ORCH_HEALTH_TTL_SCALE }
})

test('part3: failure notifications - one per failure event with agent/stage/reason/recovery; none for success; history carries timeline fields', async () => {
  const ok1 = await zipToCi(CODE_ZIP); const m0 = await mon(); assert.equal(m0.failures.length, 0, 'success creates no notification'); assert.ok(!db.activity_logs.some(l => l.level === 'error'))
  const f = await applied({ title: 'ci will fail', files: [{ path: 'src/F2.js', op: 'create', content: 'f\n' }] }); ciOverride = 'failing'
  await Promise.all([post({ action: 'check_ci', params: { workflow_id: f.id } }), post({ action: 'check_ci', params: { workflow_id: f.id } })])
  assert.equal(db.activity_logs.filter(l => l.task_id === f.id && l.action === 'orchestrator_workflow_failed').length, 1, 'duplicate failure events are logged once')
  const m = await mon(); assert.equal(m.failures.length, 1); const n = m.failures[0]
  assert.equal(n.agent, 'agent2'); assert.equal(n.stage, 'ci_waiting'); assert.match(n.message, /CI failed/); assert.ok(n.recovery.length > 10); assert.equal((await mon()).failures[0].event_id, n.event_id, 'same event keeps its id (dashboard can de-duplicate)')
  const list = (await ok('list', {})).workflows as Row[]; const wf = list.find(w => w.id === f.id)!, good = list.find(w => w.id === ok1.id)!
  assert.ok(wf.started_at && wf.finished_at && wf.retries === 0 && wf.approval === 'approved'); assert.equal(wf.failure_detail.agent, 'agent2'); assert.ok(wf.failure_detail.recovery)
  assert.ok(good.started_at && good.finished_at && good.failure_detail === null)
})

test('part3: monitoring is read-only, Agent 3 independent, no Agent 3 reference in the new code', async () => {
  const s = await started(); const before = JSON.stringify(db.approvals); const w = ghWrites.length
  await mon(); await ok('health', {}); assert.equal(JSON.stringify(db.approvals), before); assert.equal(ghWrites.length, w); assert.equal(sqlExec.length, 0); assert.equal(stageOf(s.id), 'awaiting_approval')
  assert.ok(!allUrls.some(x => /agent3/i.test(x)))
  const src = readFileSync(join(srcDir(), 'monitor.ts'), 'utf8'); assert.ok(!/from\s+['"][^'"]*agent3/.test(src) && !/AGENT3_/.test(src))
  assert.ok((ACTIONS as readonly string[]).includes('monitor') && !(A2_ALLOWED as readonly string[]).includes('apply_promote'))
})

test('delete: a finished ZIP task is removed, its ZIP + commit locks are released, the same ZIP can be uploaded again; unfinished tasks and non-owners are refused', async () => {
  const p = zipParams(CODE_ZIP); const u = await ok('upload_zip', p); const id = u.workflow.id as string
  await must('delete_workflow', { workflow_id: id }, 409, 'not_finished'); assert.equal(orchRows().length, 1)
  approve(u.workflow.steps.approval.id)
  const ap = await ok('apply', { workflow_id: id }); const b = ap.workflow.steps.agent2_apply.branch
  runs = [{ id: 9, name: 'CI', status: 'completed', conclusion: 'failure', head_branch: b, head_sha: refs.get(b)!, html_url: '' }]
  await must('check_ci', { workflow_id: id }, 409, 'ci_failed'); assert.equal(stageOf(id), 'failed')
  const dup = await post({ action: 'upload_zip', params: { ...p, request_id: randomUUID() } })
  assert.equal(dup.status, 409); assert.equal((dup.body as any).code, 'duplicate_zip'); assert.match(String((dup.body as any).error), /red Delete button/)
  assert.equal(locks('zip').length, 1); assert.equal(locks('commit').length, 1)
  const other = await post({ action: 'delete_workflow', params: { workflow_id: id } }, 'tok-other'); assert.equal(other.status, 403); assert.equal(orchRows().length, 1)
  const d = await ok('delete_workflow', { workflow_id: id })
  assert.equal(d.deleted, true); assert.equal(d.released_locks, 2); assert.equal(orchRows().length, 0); assert.equal(locks().length, 0)
  assert.ok(db.approvals.length > 0, 'approvals are kept'); assert.ok(refs.has(b), 'the agent2 branch on GitHub is not touched')
  const again = await ok('upload_zip', zipParams(CODE_ZIP, { title: 'ZIP: again' })); approve(again.workflow.steps.approval.id)
  const ap2 = await ok('apply', { workflow_id: again.workflow.id }); assert.notEqual(ap2.workflow.steps.agent2_apply.branch, b); assert.equal(agentBranches().length, 2)
  assert.equal(locks('zip').length, 1); assert.equal(locks('commit').length, 1)
})

test('delete: SQL that already ran stays blocked (never runs twice); an uncertain SQL result blocks deletion', async () => {
  const entries = [...CODE_ZIP, { name: 'supabase/sql/001.sql', data: SQL_OK }]
  const u = await zipUp(entries); await toAwaitingSql(u, [])
  approve(sqlApprovals()[0].id); sqlWritesAllowed = true; await ok('apply_sql', { workflow_id: u.id, db_ack: 'RUN-SQL' })
  assert.equal(stageOf(u.id), 'completed'); assert.equal(sqlExec.length, 1)
  const d = await ok('delete_workflow', { workflow_id: u.id }); assert.match(d.note, /never run twice/)
  assert.equal(orchRows().length, 0); assert.equal(locks('sql').length, 1); assert.equal(locks('sql')[0].payload.status, 'applied'); assert.equal(locks('zip').length, 0)
  const again = await ok('upload_zip', zipParams(entries, { title: 'ZIP: again' }))
  assert.equal(again.workflow.zip.sql[0].status, 'blocked'); assert.match(again.workflow.zip.sql[0].reason, /already applied/); assert.equal(sqlExec.length, 1)
  const w = await ok('upload_zip', zipParams([{ name: 'src/Z.js', data: 'z' }])); const row = db.tasks.find(t => t.id === w.workflow.id)!
  row.payload.stage = 'failed'; row.payload.steps.sql = { items: [{ path: 'x.sql', status: 'uncertain' }] }
  await must('delete_workflow', { workflow_id: w.workflow.id }, 409, 'sql_uncertain_open'); assert.ok(orchRows().some(r => r.id === w.workflow.id))
})
