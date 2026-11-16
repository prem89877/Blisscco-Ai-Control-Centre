import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config.js'
import { redact } from './util.js'
import { assertAgentBranch, branchFor, classifyCommand, diffStats, gitBlobSha, isSensitivePath, scanSecrets, tokenize, validateFiles, validatePath } from './guard.js'
import { handleRequest } from './server.js'
import { makeCtx, runAction } from './agent.js'
import { parseGithubRepo, runLocal } from './local.js'
import { GitHub } from './github.js'

const REF = 'abcdref'
const REPO = 'me/blisscco-ai-control-center'
const SERVICE = 'svc_SECRET_KEY_1234567890'
const GHTOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123'
const GEMKEY = 'AIzaSyDUMMYDUMMYDUMMYDUMMYDUMMYDUMMY1'
const ENV: Record<string, string> = {
  VITE_SUPABASE_URL: `https://${REF}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: SERVICE,
  AGENT2_GITHUB_TOKEN: GHTOKEN, AGENT2_GITHUB_REPOS: REPO, AGENT2_GEMINI_API_KEY: GEMKEY
}

// ---------------------------------------------------------------- fake Supabase / Gemini / GitHub
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

function resetAll() {
  seq = 0; ghWrites = []; failNextBlob = false; geminiCalls = 0; prs = []
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

async function fake(input: any, init: any = {}): Promise<Response> {
  const url = new URL(String(input)); const method = (init.method || 'GET').toUpperCase()
  const body = init.body ? JSON.parse(init.body) : undefined
  const h = init.headers || {}
  if (url.host === 'api.github.com') {
    if (h.Authorization !== 'Bearer ' + GHTOKEN) return json({ message: 'Bad credentials' }, 401)
    return gh(method, url.pathname, url, body)
  }
  if (url.host === 'generativelanguage.googleapis.com') {
    geminiCalls++
    const sys = String(body.systemInstruction.parts[0].text)
    const text = sys.includes('bug fixer') ? fixReply : '- Adds a constant.\n- No risks found.'
    return json({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 40 } })
  }
  if (url.host === `${REF}.supabase.co`) {
    if (url.pathname === '/auth/v1/user') {
      const t = String(h.Authorization).replace('Bearer ', '')
      return t === 'tok-owner' ? json({ id: 'user-owner' }) : t === 'tok-other' ? json({ id: 'user-other' }) : json({}, 401)
    }
    const table = url.pathname.replace('/rest/v1/', '')
    const t = (db[table] ||= [])
    const filt = (r: Row) => [...url.searchParams.entries()].filter(([k]) => !['select', 'order', 'limit'].includes(k)).every(([k, v]) => matches(r, k, v))
    if (method === 'GET') return json(t.filter(filt))
    if (method === 'POST') { const arr = Array.isArray(body) ? body : [body]; const out = arr.map((r: Row) => ({ id: uuid(), updated_at: new Date().toISOString(), requested_at: new Date().toISOString(), ...(table === 'approvals' ? { status: 'pending' } : {}), ...r })); t.push(...out); return json(out, 201) }
    if (method === 'PATCH') { const hit = t.filter(filt); hit.forEach(r => Object.assign(r, body, { updated_at: new Date().toISOString() })); return json(hit) }
  }
  return json({ error: 'unrouted ' + url }, 500)
}

const realFetch = globalThis.fetch
test.before(() => { globalThis.fetch = fake as any })
test.after(() => { globalThis.fetch = realFetch })
test.beforeEach(() => resetAll())

const post = (body: unknown, token = 'tok-owner', env: Record<string, string | undefined> = ENV) => handleRequest({ method: 'POST', headers: { authorization: 'Bearer ' + token }, body }, env)
const approve = (id: string, at = new Date().toISOString()) => { const a = db.approvals.find(x => x.id === id)!; a.status = 'approved'; a.decided_at = at }
const ok = async (action: string, params: any) => { const r = await post({ action, params }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body as any }
const must = async (action: string, params: any, status: number, code?: string) => { const r = await post({ action, params }); assert.equal(r.status, status, JSON.stringify(r.body)); if (code) assert.equal((r.body as any).code, code); return r.body as any }
const branchesWritten = () => ghWrites.filter(w => w.path.startsWith('/git/refs')).map(w => w.path + ' ' + JSON.stringify(w.body && w.body.ref || ''))
const CHANGE = { repo: REPO, title: 'Bump b constant', files: [{ path: 'src/App.jsx', op: 'update', content: 'export const a = 1\nexport const b = 3\n' }, { path: 'src/New.js', op: 'create', content: 'export const n = 1\n' }] }

// ================================================================ unit: guard
test('paths: traversal, git internals and secret files are rejected', () => {
  for (const bad of ['../x', '/etc/passwd', 'a/../b', '.git/config', 'a\\b', 'node_modules/x', '.env', 'app/.env.local', 'k.pem', '.npmrc', '~/x', 'a//b', '.agent2/x']) assert.throws(() => validatePath(bad), bad)
  assert.equal(validatePath('src/App.jsx'), 'src/App.jsx'); assert.equal(validatePath('.env.example'), '.env.example')
})
test('secret scan finds keys by rule and line, never returns the value, ignores placeholders', () => {
  const code = `const a = 1\nconst k = "${GEMKEY}"\nconst t = '${GHTOKEN}'\napi_key: "YOUR_API_KEY_GOES_HERE_1234"\npassword = "S3cretPassw0rdValue"\n-----BEGIN RSA PRIVATE KEY-----`
  const hits = scanSecrets(code)
  assert.deepEqual(hits.map(h => h.line), [2, 3, 5, 6])
  assert.ok(!JSON.stringify(hits).includes(GEMKEY) && !JSON.stringify(hits).includes('S3cret'))
  assert.equal(scanSecrets('const url = process.env.KEY\nfetch(url, { headers: { Authorization: token } })').length, 0)
})
test('validateFiles: secrets block everything, duplicates and bad ops rejected', () => {
  assert.throws(() => validateFiles([{ path: 'a.js', op: 'create', content: `x="${GHTOKEN}"` }]), /secrets/)
  assert.throws(() => validateFiles([{ path: 'a.js', op: 'create', content: '1' }, { path: 'a.js', op: 'update', content: '2' }]), /Duplicate/)
  assert.throws(() => validateFiles([{ path: 'a.js', op: 'nuke', content: '1' }]), /op must be/)
  assert.throws(() => validateFiles([]), /required/)
  assert.equal(validateFiles([{ path: 'a.js', op: 'delete' }])[0].op, 'delete')
})
test('shell policy: safe / approval / blocked', () => {
  const c = (s: string) => classifyCommand(tokenize(s)).level
  for (const s of ['git status', 'git diff', 'git log --oneline -5', 'ls src', 'cat README.md', 'npm run lint', 'npm test', 'node -v', 'npx tsc --noEmit', 'git branch --show-current']) assert.equal(c(s), 'safe', s)
  for (const s of ['npm install', 'git checkout -b x', 'git commit', 'rm src/old.js', 'git reset --hard', 'node build.js', 'curl https://example.com', 'npm run deploy', 'git revert abc123']) assert.equal(c(s), 'approval', s)
  for (const s of ['sudo ls', 'git push origin main', 'git push --force', 'git clean -fd', 'git config user.name x', 'rm -rf /', 'rm -r ..', 'cat .env', 'cat ../x', 'env', 'printenv', 'bash -c ls', 'npm publish', 'chmod -R 777 src', 'find . -delete', 'ssh host', 'git -c core.x=1 status', '/bin/ls', 'cat .env.agent2']) assert.equal(c(s), 'blocked', s)
  for (const s of ['ls; rm -rf /', 'cat a | sh', 'echo $(id)', 'ls `id`', 'ls > x', 'ls && ls', 'rm *', 'cat "a b"']) assert.throws(() => tokenize(s), s)
})
test('branch rules: only agent2/* and never protected names', () => {
  const prot = ['main', 'master', 'production', 'prod']
  for (const b of ['main', 'master', 'production', 'release/1', 'feature/x', 'agent2/', 'agent2/../main', 'agent2/x.lock', 'AGENT2/x']) assert.throws(() => assertAgentBranch(b, prot), b)
  assertAgentBranch('agent2/fix-login-2611161200', prot)
  assert.match(branchFor('Fix: the "login" bug!!'), /^agent2\/fix-the-login-bug-\d{10}$/)
})
test('misc: diff stats, sensitive paths, repo url parsing, redaction', () => {
  const d = diffStats('a\nb\nc\n', 'a\nB\nc\n'); assert.equal(d.added, 1); assert.equal(d.removed, 1)
  assert.ok(isSensitivePath('.github/workflows/ci.yml') && isSensitivePath('vercel.json') && isSensitivePath('agent2/agent.ts') && !isSensitivePath('src/App.jsx'))
  assert.equal(parseGithubRepo('https://github.com/me/repo.git'), 'me/repo'); assert.equal(parseGithubRepo('git@github.com:me/repo.git'), 'me/repo'); assert.equal(parseGithubRepo('https://evil.com/me/repo'), null)
  assert.ok(!JSON.stringify(redact({ a: `x ${GHTOKEN}`, b: GEMKEY })).includes('ghp_'))
  assert.equal(loadConfig({ ...ENV }).geminiModel, 'gemini-3.5-flash')
})

// ================================================================ API: auth, setup, read
test('auth and routing', async () => {
  assert.equal((await handleRequest({ method: 'GET', headers: {} }, ENV)).status, 405)
  assert.equal((await handleRequest({ method: 'POST', headers: {}, body: {} }, ENV)).status, 401)
  assert.equal((await post({ action: 'heartbeat' }, 'bad')).status, 401)
  assert.equal((await post({ action: 'heartbeat' }, 'tok-other')).status, 403)
  assert.equal((await post({ action: 'heartbeat' }, 'tok-owner', {})).status, 500)
  await must('nuke_everything', {}, 400, 'unknown_action')
  await must('local_apply', {}, 400, 'unknown_action') // local actions are not reachable from Vercel
  await must('exec', { command: 'ls' }, 400, 'unknown_action')
})
test('heartbeat takes over agent slot 2 and reports setup', async () => {
  const r = await ok('heartbeat', {})
  assert.equal(r.agent.name, 'Development & GitHub Agent'); assert.deepEqual(r.ready, { supabase_rest: true, github: true, gemini: true })
  assert.deepEqual(r.repos, [REPO]); assert.equal(db.agents[0].name, 'Agent 1'); assert.equal(db.agents[1].slot, 2)
})
test('repo_inspect: overview, file, folder; secret paths and other repos refused', async () => {
  const o = (await ok('repo_inspect', { repo: REPO })).result
  assert.equal(o.default_branch, 'main'); assert.equal(o.file_count, 5)
  assert.equal((await ok('repo_inspect', { repo: REPO, path: 'src/App.jsx' })).result.content, SEED['src/App.jsx'])
  assert.deepEqual((await ok('repo_inspect', { repo: REPO, path: 'src' })).result.files, ['src/App.jsx'])
  await must('repo_inspect', { repo: REPO, path: '.env' }, 403, 'secret_file')
  await must('repo_inspect', { repo: REPO, path: '../x' }, 400)
  await must('repo_inspect', { repo: 'someone/else' }, 403, 'repo_not_allowed')
  await must('repo_inspect', { repo: REPO, path: 'nope.js' }, 404)
  assert.ok(ghWrites.length === 0)
})
test('actions_status: passing, failing with failed jobs, none', async () => {
  assert.equal((await ok('actions_status', { repo: REPO })).result.overall, 'none')
  runs = [{ id: 1, name: 'CI', status: 'completed', conclusion: 'failure', head_branch: 'agent2/x', head_sha: 'abcdef1234', html_url: 'u' }]
  const r = (await ok('actions_status', { repo: REPO, branch: 'agent2/x' })).result
  assert.equal(r.overall, 'failing'); assert.deepEqual(r.failed_jobs[0].failed_steps, ['npm test'])
  runs[0].conclusion = 'success'; assert.equal((await ok('actions_status', { repo: REPO })).result.overall, 'passing')
})

// ================================================================ API: propose -> approve -> apply
test('propose_change writes NOTHING to GitHub, creates task + approval, stores no file content in the approval', async () => {
  const r = await ok('propose_change', CHANGE)
  assert.equal(r.status, 'awaiting_approval'); assert.equal(ghWrites.length, 0)
  const ap = db.approvals.find(a => a.id === r.result.approval_id)!
  assert.equal(ap.details.kind, 'code_change'); assert.match(ap.details.branch, /^agent2\//)
  assert.equal(ap.details.files.length, 2); assert.equal(ap.details.files[0].added, 1)
  assert.ok(!JSON.stringify(ap.details).includes('export const n = 1\\n') || ap.details.files.every((f: any) => f.preview.length <= 700))
  assert.ok(r.result.ai_review); assert.equal(db.tasks[0].status, 'awaiting_approval'); assert.equal(db.agents[1].status, 'idle')
  assert.ok(db.api_usage.some(u => u.provider === 'gemini' && u.tokens_in === 200)); assert.ok(db.api_usage.some(u => u.provider === 'github'))
  assert.ok(db.activity_logs.some(l => l.action === 'agent2_approval_requested'))
})
test('propose_change refuses overwriting, missing files, secrets and unknown repos', async () => {
  await must('propose_change', { ...CHANGE, files: [{ path: 'README.md', op: 'create', content: 'x' }] }, 409, 'exists')
  await must('propose_change', { ...CHANGE, files: [{ path: 'nope.js', op: 'update', content: 'x' }] }, 404)
  await must('propose_change', { ...CHANGE, files: [{ path: 'src/App.jsx', op: 'update', content: SEED['src/App.jsx'] }] }, 400)
  const n = db.tasks.length
  await must('propose_change', { ...CHANGE, files: [{ path: 'src/k.js', op: 'create', content: `const k = "${GHTOKEN}"` }] }, 422, 'secret_detected')
  await must('propose_change', { ...CHANGE, files: [{ path: '.env', op: 'create', content: 'A=1' }] }, 403, 'secret_file')
  await must('propose_change', { ...CHANGE, repo: 'evil/repo' }, 403, 'repo_not_allowed')
  assert.equal(db.tasks.length, n); assert.equal(ghWrites.length, 0)
  assert.ok(!JSON.stringify(db).includes(GHTOKEN))
})
test('propose_change flags deletes, sensitive files and big shrinks', async () => {
  const r = await ok('propose_change', { repo: REPO, title: 'Cleanup', files: [{ path: 'README.md', op: 'delete' }, { path: 'package.json', op: 'update', content: '{"name":"y"}\n' }, { path: 'big.txt', op: 'update', content: 'tiny\n' }] })
  const w = r.result.warnings.join('|')
  assert.match(w, /DELETES README.md/); assert.match(w, /sensitive files: package.json/); assert.match(w, /big.txt shrinks/)
  assert.equal(db.approvals[0].details.sensitive_paths[0], 'package.json')
})
test('apply_change: gated by approval; creates branch + one commit from the approved base; base branch untouched', async () => {
  const r = await ok('propose_change', CHANGE); const id = r.result.approval_id; const mainBefore = refs.get('main')!
  await must('apply_change', { approval_id: id }, 409, 'not_approved')
  await must('apply_change', { approval_id: 'nope' }, 400)
  approve(id)
  const a = (await ok('apply_change', { approval_id: id })).result
  assert.equal(a.applied, true); assert.equal(a.production_touched, false)
  assert.equal(refs.get('main'), mainBefore); assert.equal(refs.get(a.branch), a.commit_sha)
  const c = commits.get(a.commit_sha)!; assert.deepEqual(c.parents, [mainBefore])
  const t = trees.get(c.tree)!
  assert.equal(blobs.get(t.get('src/App.jsx')!.sha), 'export const a = 1\nexport const b = 3\n'); assert.equal(blobs.get(t.get('src/New.js')!.sha), 'export const n = 1\n')
  for (const k of ['README.md', 'package.json', '.env.example', 'big.txt']) assert.equal(t.get(k)!.sha, treeOf(mainBefore).get(k)!.sha, 'unrelated file untouched: ' + k)
  assert.equal(a.changed_files.length, 2); assert.match(a.compare_url, /compare\/main\.\.\.agent2\//); assert.match(a.deployment_trigger, /triggered/)
  assert.ok(branchesWritten().every(x => x.includes('agent2/')), branchesWritten().join('\n'))
  assert.equal(db.approvals[0].details.commit_sha, a.commit_sha)
  await must('apply_change', { approval_id: id }, 409, 'already_executed')
  assert.equal(db.tasks.find(t2 => t2.id === db.approvals[0].task_id)!.status, 'succeeded')
})
test('apply_change: sensitive files need the extra ack; expired approvals and tampered content are refused', async () => {
  const s = await ok('propose_change', { repo: REPO, title: 'Pkg', files: [{ path: 'package.json', op: 'update', content: '{"name":"z"}\n' }] })
  approve(s.result.approval_id)
  await must('apply_change', { approval_id: s.result.approval_id }, 403, 'sensitive_ack')
  assert.equal(ghWrites.length, 0)
  assert.equal((await ok('apply_change', { approval_id: s.result.approval_id, sensitive_ack: 'APPROVE-SENSITIVE' })).result.applied, true)
  const e = await ok('propose_change', CHANGE); approve(e.result.approval_id, new Date(Date.now() - 25 * 3600e3).toISOString())
  await must('apply_change', { approval_id: e.result.approval_id }, 409, 'expired')
  const t = await ok('propose_change', { ...CHANGE, title: 'Tamper' }); approve(t.result.approval_id)
  const task = db.tasks.find(x => x.id === db.approvals.find(a => a.id === t.result.approval_id)!.task_id)!
  task.payload.files[0].content = 'export const evil = 1\n'
  await must('apply_change', { approval_id: t.result.approval_id }, 409, 'content_mismatch')
})
test('apply_change: a failure mid-way removes the half-made branch and releases the approval for a clean retry', async () => {
  const r = await ok('propose_change', CHANGE); approve(r.result.approval_id)
  failNextBlob = true
  await must('apply_change', { approval_id: r.result.approval_id }, 502)
  const ap = db.approvals[0]
  assert.equal(ap.details.executed_at, null); assert.ok(ap.details.last_error)
  assert.ok(![...refs.keys()].some(k => k.startsWith('agent2/')), 'half-made branch removed')
  assert.equal((await ok('apply_change', { approval_id: r.result.approval_id })).result.applied, true)
})
test('protected branches can never be written, even by calling the client directly', async () => {
  const g = new GitHub(loadConfig(ENV), {})
  for (const b of ['main', 'master', 'production', 'release/1']) {
    await assert.rejects(g.createBranch(REPO, b, refs.get('main')!), /agent2/)
    await assert.rejects(g.commit(REPO, b, refs.get('main')!, 'x', [{ path: 'a', content: 'b' }]), /agent2/)
    await assert.rejects(g.deleteBranch(REPO, b), /agent2/)
  }
  await must('request_promote', { repo: REPO, branch: 'main' }, 403, 'branch_blocked')
  assert.equal(ghWrites.length, 0)
})

// ================================================================ API: ai_fix
test('ai_fix: Gemini draft goes through the same approval pipeline; out-of-scope and bad JSON are refused', async () => {
  const r = await ok('ai_fix', { repo: REPO, paths: ['src/App.jsx'], problem: 'b should be 3' })
  assert.equal(r.status, 'awaiting_approval'); assert.equal(ghWrites.length, 0)
  assert.equal(db.approvals[0].details.ai_fix, 'bump b'); assert.equal(db.approvals[0].details.files[0].path, 'src/App.jsx')
  fixReply = JSON.stringify({ explanation: 'x', files: [{ path: 'package.json', content: '{}' }] })
  await must('ai_fix', { repo: REPO, paths: ['src/App.jsx'], problem: 'p' }, 422, 'out_of_scope')
  fixReply = 'not json'
  await must('ai_fix', { repo: REPO, paths: ['src/App.jsx'], problem: 'p' }, 502, 'gemini_format')
  fixReply = JSON.stringify({ explanation: 'x', files: [{ path: 'src/App.jsx', content: `const k="${GEMKEY}"` }] })
  await must('ai_fix', { repo: REPO, paths: ['src/App.jsx'], problem: 'p' }, 422, 'secret_detected')
  await must('ai_fix', { repo: REPO, paths: ['.env'], problem: 'p' }, 403)
  assert.equal(ghWrites.length, 0)
})

// ================================================================ API: promote + rollback
async function pushedBranch() {
  const r = await ok('propose_change', CHANGE); approve(r.result.approval_id)
  return (await ok('apply_change', { approval_id: r.result.approval_id })).result.branch as string
}
test('promote: needs approval, production tick, green CI and an unmoved branch; merge is sha-pinned', async () => {
  const branch = await pushedBranch(); const sha = refs.get(branch)!
  const r = await ok('request_promote', { repo: REPO, branch }); assert.equal(db.approvals.at(-1)!.details.production, true)
  const id = r.result.approval_id
  await must('apply_promote', { approval_id: id }, 409, 'not_approved'); approve(id)
  await must('apply_promote', { approval_id: id }, 403, 'production_ack')
  const ack = { approval_id: id, production_ack: 'APPROVE-PRODUCTION' }
  runs = [{ id: 1, name: 'CI', status: 'in_progress', conclusion: null, head_branch: branch, head_sha: sha, html_url: '' }]
  await must('apply_promote', ack, 409, 'ci_running')
  runs[0].status = 'completed'; runs[0].conclusion = 'failure'
  await must('apply_promote', ack, 409, 'ci_failed')
  runs[0].conclusion = 'success'
  const moved = refs.get(branch)!; refs.set(branch, 'f'.repeat(40))
  await must('apply_promote', ack, 409, 'head_moved'); refs.set(branch, moved)
  const mainBefore = refs.get('main')!
  const m = (await ok('apply_promote', ack)).result
  assert.equal(m.merged, true); assert.notEqual(refs.get('main'), mainBefore); assert.equal(refs.get('main'), m.merge_sha)
  assert.equal(blobs.get(treeOf(refs.get('main')!).get('src/App.jsx')!.sha), 'export const a = 1\nexport const b = 3\n')
  assert.ok(db.approvals.find(a => a.id === id)!.details.merge_sha)
  await must('apply_promote', ack, 409, 'already_executed')
  // main was only ever changed through the PR merge endpoint
  assert.ok(ghWrites.filter(w => w.path.startsWith('/git/')).every(w => !/main/.test(JSON.stringify(w.body) + w.path)))
})
test('rollback: unmerged branch is deleted (guarded against new commits); merged change becomes a revert PR that never overwrites newer work', async () => {
  const b1 = await pushedBranch()
  const r1 = await ok('request_rollback', { repo: REPO, branch: b1 }); assert.equal(db.approvals.at(-1)!.details.mode, 'delete_branch'); approve(r1.result.approval_id)
  refs.set(b1, 'e'.repeat(40)); await must('apply_rollback', { approval_id: r1.result.approval_id }, 409, 'head_moved')
  refs.set(b1, db.approvals.find(a => a.details.kind === 'rollback')!.details.expected_head)
  assert.equal((await ok('apply_rollback', { approval_id: r1.result.approval_id })).result.branch_deleted, b1); assert.ok(!refs.has(b1))

  resetAll(); const b2 = await pushedBranch(); const sha = refs.get(b2)!
  const pr = await ok('request_promote', { repo: REPO, branch: b2 }); approve(pr.result.approval_id)
  runs = [{ id: 1, name: 'CI', status: 'completed', conclusion: 'success', head_branch: b2, head_sha: sha, html_url: '' }]
  await ok('apply_promote', { approval_id: pr.result.approval_id, production_ack: 'APPROVE-PRODUCTION' })
  const rb = await ok('request_rollback', { repo: REPO, branch: b2 }); const rid = rb.result.approval_id; assert.equal(db.approvals.at(-1)!.details.mode, 'revert_pr'); approve(rid)
  await must('apply_rollback', { approval_id: rid }, 403, 'production_ack')
  const mainSha = refs.get('main')!
  // somebody edits a file after the merge: automatic revert must refuse
  const t = new Map(treeOf(mainSha)); t.set('src/App.jsx', { mode: '100644', sha: putBlob('export const mine = 1\n') }); refs.set('main', putCommit(putTree(t), [mainSha], 'someone else'))
  await must('apply_rollback', { approval_id: rid, production_ack: 'APPROVE-PRODUCTION' }, 409, 'conflict')
  refs.set('main', mainSha)
  const out = (await ok('apply_rollback', { approval_id: rid, production_ack: 'APPROVE-PRODUCTION' })).result
  assert.match(out.revert_branch, /^agent2\/revert-/); assert.equal(refs.get('main'), mainSha, 'revert is a PR, main not touched')
  const rt = treeOf(refs.get(out.revert_branch)!)
  assert.equal(blobs.get(rt.get('src/App.jsx')!.sha), SEED['src/App.jsx']); assert.ok(!rt.has('src/New.js')); assert.equal(rt.get('README.md')!.sha, treeOf(mainSha).get('README.md')!.sha)
})

// ================================================================ secrets
test('no secret ever appears in a response, DB row or log', async () => {
  const bodies: unknown[] = []
  const grab = async (a: string, p: any) => { const r = await post({ action: a, params: p }); bodies.push(r.body) }
  await grab('heartbeat', {}); await grab('repo_inspect', { repo: REPO }); await grab('propose_change', CHANGE); await grab('propose_change', { ...CHANGE, files: [{ path: 'k.js', op: 'create', content: `k="${GHTOKEN}"` }] })
  await grab('apply_change', { approval_id: 'x' }); await grab('actions_status', { repo: REPO })
  const all = JSON.stringify([bodies, db])
  for (const s of [SERVICE, GHTOKEN, GEMKEY]) assert.ok(!all.includes(s), 'leaked ' + s.slice(0, 6))
  const bad = await handleRequest({ method: 'POST', headers: { authorization: 'Bearer tok-owner' }, body: { action: 'actions_status', params: { repo: REPO } } }, { ...ENV, AGENT2_GITHUB_TOKEN: 'ghp_WRONGWRONGWRONGWRONGWRONGWRONG1' })
  assert.equal(bad.status, 502); assert.ok(!JSON.stringify(bad.body).includes('WRONGWRONG')); assert.equal(db.tasks.at(-1)!.status, 'failed'); assert.equal(db.agents[1].status, 'error')
})

// ================================================================ Termux (real git, real processes)
function sh(cwd: string, ...args: string[]) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
let seqDir = 0
function localRepo() {
  const root = mkdtempSync(join(tmpdir(), 'agent2-local-' + ++seqDir + '-'))
  const home = join(root, 'home'); mkdirSync(home)
  const bare = join(root, 'remote.git'); execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare])
  writeFileSync(join(home, '.gitconfig'), `[user]\n\tname = Tester\n\temail = t@example.com\n[url "file://${bare}"]\n\tinsteadOf = https://github.com/${REPO}.git\n`)
  const w = join(root, 'work'); mkdirSync(w)
  const env = { HOME: home }
  const g = (...a: string[]) => execFileSync('git', a, { cwd: w, env: { ...process.env, ...env }, encoding: 'utf8' }).trim()
  g('init', '-q', '-b', 'main'); g('remote', 'add', 'origin', `https://github.com/${REPO}.git`)
  mkdirSync(join(w, 'src')); mkdirSync(join(w, 'node_modules'))
  writeFileSync(join(w, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "console.error(1);process.exit(1)"' } }, null, 2) + '\n')
  writeFileSync(join(w, 'src/App.jsx'), SEED['src/App.jsx']); writeFileSync(join(w, 'README.md'), '# hi\n')
  g('add', '-A'); g('commit', '-q', '-m', 'init'); g('push', '-q', 'origin', 'main')
  return { w, g, bare, home }
}
const lctx = (w: string, home: string) => { process.env.HOME = home; return makeCtx(loadConfig({ ...ENV, AGENT2_WORKDIR: w }), { type: 'system', id: null }) }
const LCHANGE = { title: 'Local bump', files: [{ path: 'src/App.jsx', op: 'update', content: 'export const a = 1\nexport const b = 3\n' }, { path: 'src/New.js', op: 'create', content: 'export const n = 1\n' }] }

test('local_apply: separate branch, only the listed files, base branch untouched, no mixing with your uncommitted work', async () => {
  const { w, g, home } = localRepo(); const ctx = lctx(w, home); const base = g('rev-parse', 'HEAD')
  writeFileSync(join(w, 'mine.txt'), 'wip'); g('add', 'mine.txt')
  await assert.rejects(runLocal(ctx, 'local_apply', { changes: LCHANGE }), /uncommitted/)
  g('reset', '-q'); writeFileSync(join(w, 'mine.txt'), '')
  g('stash', '-u', '-q')
  await assert.rejects(runLocal(ctx, 'local_apply', { changes: { title: 't', files: [{ path: 'README.md', op: 'create', content: 'x' }] } }), /already exists/)
  await assert.rejects(runLocal(ctx, 'local_apply', { changes: { title: 't', files: [{ path: '../out.js', op: 'create', content: 'x' }] } }), /relative|Unsafe/)
  await assert.rejects(runLocal(ctx, 'local_apply', { changes: { title: 't', files: [{ path: 'src/ghost.js', op: 'update', content: 'x' }] } }), /not a tracked/)
  assert.equal(g('rev-parse', '--abbrev-ref', 'HEAD'), 'main')
  const r = await runLocal(ctx, 'local_apply', { changes: LCHANGE })
  assert.match(r.result.branch, /^agent2\//); assert.equal(g('rev-parse', '--abbrev-ref', 'HEAD'), r.result.branch)
  assert.equal(readFileSync(join(w, 'src/New.js'), 'utf8'), 'export const n = 1\n'); assert.equal(g('rev-parse', 'main'), base)
  assert.ok(existsSync(join(w, '.agent2/changes', r.result.branch.replace('/', '__') + '.json')))
  assert.ok(g('status', '--porcelain').split('\n').every(l => /App.jsx|New.js/.test(l)), g('status', '--porcelain'))
  assert.equal(db.tasks.at(-1)!.status, 'succeeded')
})
test('local_checks: runs lint/test, reports failures honestly, and demands an ack when package.json changed', async () => {
  const { w, g, home } = localRepo(); const ctx = lctx(w, home)
  const r = await runLocal(ctx, 'local_checks', {})
  assert.equal(r.result.passed, false); assert.equal(r.result.checks.find((c: any) => c.name === 'test').ok, true); assert.equal(r.result.checks.find((c: any) => c.name === 'lint').ok, false)
  assert.ok(r.result.skipped.some((s: string) => /typecheck/.test(s)))
  assert.equal((await runLocal(ctx, 'local_checks', { only: 'test' })).result.passed, true)
  await runLocal(ctx, 'local_apply', { changes: { title: 'Pkg', files: [{ path: 'package.json', op: 'update', content: JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"' } }) + '\n' }] } })
  await assert.rejects(runLocal(ctx, 'local_checks', { only: 'test' }), /RUN-CHANGED-SCRIPTS/)
  assert.equal((await runLocal(ctx, 'local_checks', { only: 'test', ack: 'RUN-CHANGED-SCRIPTS' })).result.passed, true)
  void g
})
test('exec: safe runs, dangerous is blocked, risky waits for an approval that matches exactly', async () => {
  const { w, home } = localRepo(); const ctx = lctx(w, home)
  const s = await runLocal(ctx, 'exec', { command: 'git status' }); assert.equal(s.result.exit_code, 0)
  for (const c of ['git push origin main', 'cat .env', 'sudo ls', 'ls; id', 'env']) await assert.rejects(runLocal(ctx, 'exec', { command: c }), /Blocked|shell characters/, c)
  assert.ok(db.activity_logs.some(l => l.action === 'agent2_command_blocked'))
  const r = await runLocal(ctx, 'exec', { command: 'node -p 1+1' }); assert.equal(r.status, 'awaiting_approval')
  const id = r.result.approval_id
  await assert.rejects(runLocal(ctx, 'apply_command', { approval_id: id }), /Not approved/)
  approve(id)
  const done = await runLocal(ctx, 'apply_command', { approval_id: id }); assert.equal(done.result.output.trim(), '2')
  await assert.rejects(runLocal(ctx, 'apply_command', { approval_id: id }), /Already executed/)
  const r2 = await runLocal(ctx, 'exec', { command: 'node -p 3+3' }); approve(r2.result.approval_id)
  db.approvals.find(a => a.id === r2.result.approval_id)!.details.argv = ['node', '-p', 'process.exit(9)']
  await assert.rejects(runLocal(ctx, 'apply_command', { approval_id: r2.result.approval_id }), /altered/)
  process.env.TOPSECRET_FOR_TEST = 'hunter2hunter2'
  const env = await runLocal(ctx, 'exec', { command: 'node -p process.env.TOPSECRET_FOR_TEST' }); approve(env.result.approval_id)
  assert.equal((await runLocal(ctx, 'apply_command', { approval_id: env.result.approval_id })).result.output.trim(), 'undefined', 'secrets are not in the child environment')
})
test('commit -> request-push -> apply-push: only approved agent branch is pushed; main on the remote never changes', async () => {
  const { w, g, bare, home } = localRepo(); const ctx = lctx(w, home); const remoteMain = sh(bare, 'rev-parse', 'main')
  const a = await runLocal(ctx, 'local_apply', { changes: LCHANGE }); const branch = a.result.branch
  writeFileSync(join(w, 'stray.txt'), 'not mine') // untracked file that must NOT be committed
  await assert.rejects(runLocal(ctx, 'local_commit', { message: '' }), /message/)
  writeFileSync(join(w, 'src/New.js'), `export const k = "${GHTOKEN}"\n`)
  await assert.rejects(runLocal(ctx, 'local_commit', { message: 'bad' }), /secrets/)
  assert.equal(g('diff', '--cached', '--name-only'), '', 'nothing left staged after a blocked commit')
  writeFileSync(join(w, 'src/New.js'), 'export const n = 1\n')
  const c = await runLocal(ctx, 'local_commit', { message: 'Bump b' }); assert.deepEqual(c.result.files.sort(), ['src/App.jsx', 'src/New.js'])
  assert.equal(g('show', '--name-only', '--format=', 'HEAD').split('\n').sort().join(), 'src/App.jsx,src/New.js'); assert.ok(g('status', '--porcelain').includes('stray.txt'))
  const rq = await runLocal(ctx, 'request_push', {}); assert.equal(rq.status, 'awaiting_approval'); assert.ok(rq.result.ai_review)
  assert.equal(sh(bare, 'rev-parse', 'main'), remoteMain); assert.throws(() => sh(bare, 'rev-parse', branch))
  await assert.rejects(runLocal(ctx, 'apply_push', { approval_id: rq.result.approval_id }), /Not approved/)
  approve(rq.result.approval_id)
  g('checkout', branch); writeFileSync(join(w, 'src/New.js'), 'export const n = 2\n'); g('commit', '-q', '-am', 'sneaky')
  await assert.rejects(runLocal(ctx, 'apply_push', { approval_id: rq.result.approval_id, wait_ms: 0 }), /changed after approval/)
  g('reset', '-q', '--hard', rq.result.commit.length ? db.approvals.at(-1)!.details.head_sha : 'HEAD')
  runs = [{ id: 1, name: 'CI', status: 'queued', conclusion: null, head_branch: branch, head_sha: 'abc', html_url: '' }]
  const p = await runLocal(ctx, 'apply_push', { approval_id: rq.result.approval_id, wait_ms: 0 })
  assert.equal(p.result.pushed, true); assert.equal(p.result.production_touched, false); assert.equal(p.result.ci, 'running'); assert.match(p.result.deployment_trigger, /triggered/)
  assert.equal(sh(bare, 'rev-parse', branch), db.approvals.at(-1)!.details.head_sha); assert.equal(sh(bare, 'rev-parse', 'main'), remoteMain, 'remote main unchanged')
  await assert.rejects(runLocal(ctx, 'apply_push', { approval_id: rq.result.approval_id, wait_ms: 0 }), /Already executed/)
  assert.ok(!JSON.stringify(db).includes(GHTOKEN))
})
test('push to a protected branch is impossible: request-push on main is refused', async () => {
  const { w, home } = localRepo(); const ctx = lctx(w, home)
  await assert.rejects(runLocal(ctx, 'request_push', {}), /agent2/)
  await assert.rejects(runLocal(ctx, 'local_commit', { message: 'x' }), /agent2/)
  await assert.rejects(runLocal(ctx, 'local_rollback', { branch: 'main' }), /agent2/)
})
test('local_rollback: restores everything, deletes only the agent branch, refuses when you have other changes', async () => {
  const { w, g, home } = localRepo(); const ctx = lctx(w, home); const base = g('rev-parse', 'HEAD')
  const a = await runLocal(ctx, 'local_apply', { changes: LCHANGE }); const branch = a.result.branch
  writeFileSync(join(w, 'mine.txt'), 'wip')
  await assert.rejects(runLocal(ctx, 'local_rollback', {}), /other uncommitted/)
  assert.ok(existsSync(join(w, 'src/New.js'))); unlinkMine(w)
  const r = await runLocal(ctx, 'local_rollback', {})
  assert.equal(r.result.rolled_back, true); assert.equal(g('rev-parse', '--abbrev-ref', 'HEAD'), 'main'); assert.equal(g('rev-parse', 'HEAD'), base)
  assert.equal(g('status', '--porcelain'), ''); assert.ok(!existsSync(join(w, 'src/New.js'))); assert.equal(readFileSync(join(w, 'src/App.jsx'), 'utf8'), SEED['src/App.jsx'])
  assert.throws(() => g('rev-parse', '--verify', branch))
  // committed branch too
  const b = await runLocal(ctx, 'local_apply', { changes: { ...LCHANGE, title: 'Second' } }); await runLocal(ctx, 'local_commit', { message: 'c' })
  await runLocal(ctx, 'local_rollback', { branch: b.result.branch }); assert.equal(g('rev-parse', 'HEAD'), base); assert.ok(!existsSync(join(w, 'src/New.js')))
})
function unlinkMine(w: string) { execFileSync('rm', ['-f', join(w, 'mine.txt')]) }
