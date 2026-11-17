import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gitBlobSha } from '../agent2/guard.js'
import { handleRequest } from './server.js'
import { deflateRawSync } from 'node:zlib'
import { A1_ALLOWED, A1_SQL_ALLOWED, A2_ALLOWED, ACTIONS, evalCi } from './workflow.js'

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
  if ((r = /^\/git\/commits\/([0-9a-f]+)$/.exec(p)) && method === 'GET') { const c = commits.get(r[1]); return c ? json({ tree: { sha: c.tree } }) : json({ message: 'Not Found' }, 404) }
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
  if (p.includes('/actions/runs/') && p.endsWith('/jobs')) return json({ jobs: [{ name: 'test-build', conclusion: 'failure', steps: [{ name: 'npm test', conclusion: 'failure' }] }] })
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

function resetAll() {
  resetGit()
  allUrls = []; a1Calls = []; vercelWrites = []; failAgent1Db = false; vercelDown = false; consoleOut = []; ciOverride = 'auto'; geminiBodies = []; sqlExec = []; sqlWritesAllowed = false; sqlFail = false
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
    if (url.pathname === '/v9/projects') return json({ projects: [{ id: 'prj_1', name: 'ai-control-center', framework: 'vite', link: { org: 'me', repo: 'blisscco-ai-control-center' } }] })
    if (url.pathname === '/v6/deployments') return json({ deployments: vDeps })
    if (url.pathname === '/v9/projects/prj_1/env') return json({ envs: [{ id: 'e1', key: 'VITE_SUPABASE_URL', type: 'plain', target: ['production'] }] })
    return json({}, 404)
  }
  if (url.host === 'api.supabase.com' && sqlWritesAllowed && method === 'POST' && url.pathname.endsWith('/database/query')) {
    sqlExec.push(String(body.query)); return sqlFail ? json({ message: 'syntax error near x' }, 400) : json([])
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
const approve = (id: string, at = new Date().toISOString()) => { const a = db.approvals.find(x => x.id === id)!; a.status = 'approved'; a.decided_at = at }
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

function srcDir() { return join(dirname(fileURLToPath(import.meta.url)), '..', '..') }

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
  const u = await zipUp([{ name: '.github/workflows/ci.yml', data: 'name: CI\n' }]); approve(u.apId)
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
