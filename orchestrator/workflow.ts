import { randomUUID, createHash } from 'node:crypto'
import { loadOrchConfig, orchReadiness, type OrchConfig } from './config.js'
import { OStore, isUuid } from './store.js'
import { AgentError, clip, errMsg, redact } from '../agent2/util.js'
import { repoAllowed } from '../agent2/config.js'
import { validRepo, validatePath } from '../agent2/guard.js'
import { REVIEW_MAX_INPUT_CHARS, REVIEW_MAX_OUTPUT_TOKENS } from '../agent2/gemini.js'
import { makeCtx as makeCtx2, runAction as runA2 } from '../agent2/agent.js'
import { makeCtx as makeCtx1, runAction as runA1 } from '../agent1/agent.js'
import { inspectZip, ZIP_LIMITS } from './zip.js'
import { classifyExecutableSql } from '../agent1/checks.js'

type Row = Record<string, any>

export interface OCtx { cfg: OrchConfig; store: OStore; userId: string }
export function makeOCtx(cfg: OrchConfig, userId: string): OCtx { return { cfg, store: new OStore(cfg), userId } }

// ---------------------------------------------------------------- what the Orchestrator may ask of each agent
// A hard allow-list. Promotion/merge, rollback, workflow runs, env changes, DB changes and redeploys are NOT here,
// so the Orchestrator cannot trigger them, whatever a request says. Agent 3 does not exist in this module.
export const A2_ALLOWED = ['propose_change', 'ai_fix', 'apply_change', 'actions_status'] as const
export const A1_ALLOWED = ['health_report'] as const
// Only for uploaded SQL migrations: Agent 1's EXISTING propose/apply pair (ai_control only, classifier + separate approval + db_ack).
// Reached only through callA1Sql, only from the sql stages below, never from a generic request.
export const A1_SQL_ALLOWED = ['propose_db_change', 'apply_db_change'] as const

export const ACTIONS = ['heartbeat', 'start', 'upload_zip', 'list', 'get', 'apply', 'check_ci', 'apply_sql', 'verify', 'cancel'] as const
export type Action = typeof ACTIONS[number]

export const STAGES = ['proposing', 'awaiting_approval', 'applying', 'ci_waiting', 'awaiting_sql', 'applying_sql', 'ci_passed', 'verifying', 'completed', 'failed', 'cancelled'] as const
export type Stage = typeof STAGES[number]
const TERMINAL: Stage[] = ['completed', 'failed', 'cancelled']
const TRANSIENT: Stage[] = ['proposing', 'applying', 'applying_sql', 'verifying']
const STALE_MS = 5 * 60 * 1000
const APPROVAL_TTL_MS = 24 * 3600 * 1000

const STATUS_OF: Record<Stage, string> = { proposing: 'running', awaiting_approval: 'awaiting_approval', applying: 'running', ci_waiting: 'running', awaiting_sql: 'awaiting_approval', applying_sql: 'running', ci_passed: 'running', verifying: 'running', completed: 'succeeded', failed: 'failed', cancelled: 'cancelled' }
const now = () => new Date().toISOString()

async function callA2(o: OCtx, action: string, params: Row): Promise<any> {
  if (!(A2_ALLOWED as readonly string[]).includes(action)) throw new AgentError('Orchestrator may not call Agent 2 action: ' + action, 403, 'action_not_allowed')
  return runA2(makeCtx2(o.cfg.c2, { type: 'user', id: o.userId }), action, params)
}
async function callA1(o: OCtx, action: string, params: Row = {}): Promise<any> {
  if (!(A1_ALLOWED as readonly string[]).includes(action)) throw new AgentError('Orchestrator may not call Agent 1 action: ' + action, 403, 'action_not_allowed')
  return runA1(makeCtx1(o.cfg.c1, { type: 'user', id: o.userId }), action, params)
}

async function callA1Sql(o: OCtx, action: string, params: Row): Promise<any> {
  if (!(A1_SQL_ALLOWED as readonly string[]).includes(action)) throw new AgentError('Orchestrator may not call Agent 1 action: ' + action, 403, 'action_not_allowed')
  return runA1(makeCtx1(o.cfg.c1, { type: 'user', id: o.userId }), action, params)
}

// ---------------------------------------------------------------- state helpers
function clean<T>(o: OCtx, v: T): T { return redact(v, o.cfg.secrets) }

// Move a workflow to its next state. Optimistic lock on payload.rev: if another request got there first, nothing is written.
async function advance(o: OCtx, wf: Row, mutate: (p: Row) => void, extra: Row = {}): Promise<Row> {
  const p: Row = JSON.parse(JSON.stringify(wf.payload))
  const before: Stage = p.stage
  mutate(p)
  p.rev = (Number(wf.payload.rev) || 0) + 1
  p.events = [...(p.events || []), ...(before !== p.stage ? [{ at: now(), stage: p.stage, message: `${before} -> ${p.stage}` }] : [])].slice(-60)
  const stage: Stage = p.stage
  const patch: Row = { payload: clean(o, p), status: STATUS_OF[stage], ...extra }
  if (TERMINAL.includes(stage)) patch.finished_at = now()
  const row = await o.store.casUpdate(wf.id, Number(wf.payload.rev) || 0, clean(o, patch))
  if (!row) throw new AgentError('This workflow was changed by another request; refresh and try again', 409, 'conflict')
  return row
}

async function fail(o: OCtx, wf: Row, f: { agent: 'orchestrator' | 'agent1' | 'agent2'; code: string; message: string }): Promise<Row> {
  const message = String(clean(o, f.message)).slice(0, 600)
  let row = wf
  try {
    row = await advance(o, wf, p => { const at = p.stage; p.stage = 'failed'; p.failure = { stage: at, agent: f.agent, code: f.code, message, at: now() }; if (p.steps && p.steps[stepOf(at)]) p.steps[stepOf(at)].status = 'failed' }, { error_message: message })
  } catch { /* someone else already moved it; the original error is still reported */ }
  await o.store.log('error', 'orchestrator_workflow_failed', message, { stage: wf.payload.stage, agent: f.agent, code: f.code }, wf.id, o.userId)
  return row
}

function stepOf(stage: string): string {
  return ({ proposing: 'agent2_propose', awaiting_approval: 'approval', applying: 'agent2_apply', ci_waiting: 'ci', awaiting_sql: 'sql', applying_sql: 'sql', ci_passed: 'ci', verifying: 'agent1_verify' } as Record<string, string>)[stage] || 'none'
}

function view(o: OCtx, wf: Row) {
  const p = wf.payload || {}
  return clean(o, {
    id: wf.id, title: String(wf.title || '').replace(/^Orchestrated: /, ''), status: wf.status, stage: p.stage, repo: p.repo, mode: p.mode,
    request: p.request, steps: p.steps, failure: p.failure || null, events: p.events || [], report: wf.result || null,
    safety: p.safety, zip: p.zip || null, created_at: wf.created_at, updated_at: wf.updated_at, finished_at: wf.finished_at || null, rev: p.rev
  })
}
function summary(o: OCtx, wf: Row) {
  const p = wf.payload || {}
  const s = p.steps || {}
  return clean(o, { id: wf.id, title: String(wf.title || '').replace(/^Orchestrated: /, ''), status: wf.status, stage: p.stage, repo: p.repo, branch: s.agent2_propose && s.agent2_propose.branch || null, commit_sha: s.agent2_apply && s.agent2_apply.commit_sha || null, ci: s.ci && s.ci.state || null, verdict: wf.result && wf.result.verdict || null, failure: p.failure ? p.failure.message : null, created_at: wf.created_at, updated_at: wf.updated_at })
}

async function load(o: OCtx, id: unknown): Promise<Row> {
  const wf = await o.store.getWorkflow(String(id || ''))
  if (!wf) throw new AgentError('Workflow not found', 404, 'not_found')
  return wf
}

// Bring a stored workflow up to date with the outside world (rejected approval, interrupted run).
async function sync(o: OCtx, wf: Row): Promise<Row> {
  const p = wf.payload
  const stage: Stage = p.stage
  if (TERMINAL.includes(stage)) return wf
  if (TRANSIENT.includes(stage) && Date.now() - new Date(wf.updated_at).getTime() > STALE_MS) {
    return fail(o, wf, { agent: 'orchestrator', code: 'interrupted', message: `The ${stage} step was interrupted (no result after 5 minutes). Check the agent's own task and branch before starting again.` })
  }
  if (stage === 'awaiting_approval' && p.steps.approval && p.steps.approval.id) {
    const ap = await o.store.getApproval(p.steps.approval.id).catch(() => null)
    if (ap && (ap.status === 'rejected' || ap.status === 'expired')) return fail(o, wf, { agent: 'orchestrator', code: 'approval_' + ap.status, message: `Approval ${ap.status}. Nothing was applied; the workflow is stopped.` })
    if (ap && ap.status === 'approved' && p.steps.approval.status !== 'approved') {
      try { return await advance(o, wf, q => { q.steps.approval.status = 'approved' }) } catch { return wf }
    }
  }
  if (stage === 'awaiting_sql' && p.steps.sql && Array.isArray(p.steps.sql.items)) {
    const approvedPaths = new Set<string>()
    for (const it of p.steps.sql.items as Row[]) {
      const ap = it.approval_id ? await o.store.getApproval(it.approval_id).catch(() => null) : null
      if (ap && (ap.status === 'rejected' || ap.status === 'expired')) return fail(o, wf, { agent: 'orchestrator', code: 'sql_approval_' + ap.status, message: `SQL approval for ${it.path} was ${ap.status}. No SQL was executed by this workflow; it is stopped.` })
      if (ap && ap.status === 'approved' && it.status === 'pending') approvedPaths.add(it.path)
    }
    if (approvedPaths.size) { try { return await advance(o, wf, q => { for (const it of q.steps.sql.items) if (approvedPaths.has(it.path)) it.status = 'approved' }) } catch { return wf } }
  }
  return wf
}

// ---------------------------------------------------------------- start (steps 1-4)
const BRANCH_RE = /^[\w./-]{1,100}$/
export async function startWorkflow(o: OCtx, p: any) {
  const repo = validRepo(String(p.repo || ''))
  if (!repoAllowed(o.cfg.c2, repo)) throw new AgentError('Repo is not in AGENT2_GITHUB_REPOS: ' + repo, 403, 'repo_not_allowed')
  const title = String(p.title || '').trim().slice(0, 120)
  if (!title) throw new AgentError('title is required', 400, 'bad_request')
  const description = String(p.description || '').slice(0, 1000)
  const mode = String(p.mode || 'files')
  if (mode !== 'files' && mode !== 'fix') throw new AgentError('mode must be "files" or "fix"', 400, 'bad_request')
  const base = p.base ? String(p.base) : undefined
  if (base && (!BRANCH_RE.test(base) || base.includes('..'))) throw new AgentError('Bad base branch name', 400, 'bad_request')
  const requestId = p.request_id === undefined ? randomUUID() : String(p.request_id)
  if (!isUuid(requestId)) throw new AgentError('request_id must be a UUID', 400, 'bad_request')
  let files: any[] | undefined
  let paths: string[] = []
  let problem = ''
  if (mode === 'files') {
    if (!Array.isArray(p.files) || !p.files.length) throw new AgentError('files[] is required for mode "files"', 400, 'bad_request')
    files = p.files
  } else {
    problem = String(p.problem || '').trim().slice(0, 2000)
    paths = (Array.isArray(p.paths) ? p.paths : []).slice(0, 5).map(String)
    if (!problem || !paths.length) throw new AgentError('problem and paths[] (max 5) are required for mode "fix"', 400, 'bad_request')
  }
  // Pre-flight: refuse to start a workflow that cannot reach the end.
  const ready = orchReadiness(o.cfg)
  if (!ready.agent2.github) throw new AgentError('Agent 2 is not configured (AGENT2_GITHUB_TOKEN / AGENT2_GITHUB_REPOS)', 503, 'not_configured')
  if (!ready.agent1.vercel && !ready.agent1.supabase_mgmt && !ready.agent1.github) throw new AgentError('Agent 1 is not configured (no Vercel, Supabase or GitHub access), so the workflow could not be verified', 503, 'not_configured')

  const payload = {
    kind: 'orchestration', version: 1, rev: 0, stage: 'proposing', repo, mode,
    request: { title, description, base: base || null, file_paths: files ? files.map(f => String(f && f.path)).slice(0, 50) : paths, problem: problem || undefined },
    steps: { agent2_propose: { status: 'running', agent: 'agent2', started_at: now() } },
    events: [{ at: now(), stage: 'proposing', message: 'created; assigned to Agent 2' }],
    safety: { production_promotion: 'never automatic; separate Agent 2 approval', agent3: 'not part of this workflow; start manually', file_contents_stored: mode === 'files' ? 'private Agent 2 ai_control task storage' : false }, zip: p.zip_meta || null
  }
  let wf = await o.store.createWorkflow(clean(o, { id: requestId, title: 'Orchestrated: ' + title, description: 'Orchestrator workflow (Agent 2 + Agent 1)', status: 'running', priority: 2, payload, created_by: o.userId, started_at: now() }))
  await o.store.log('info', 'orchestrator_workflow_started', title, { repo, mode }, wf.id, o.userId)

  let out: any
  try {
    out = mode === 'files'
      ? await callA2(o, 'propose_change', { repo, title, description, files, base, ...(p.zip_meta ? { expected_base_sha: p.zip_meta.base_commit } : {}) })
      : await callA2(o, 'ai_fix', { repo, title, problem, paths, base })
  } catch (e) {
    const ae = asErr(e)
    const row = await fail(o, wf, { agent: 'agent2', code: ae.code, message: 'Agent 2 could not prepare the proposal: ' + ae.message })
    throw withWf(new AgentError('Agent 2 could not prepare the proposal: ' + clean(o, ae.message), ae.status, ae.code), row.id)
  }
  const r = out.result || {}
  if (out.status !== 'awaiting_approval' || !r.approval_id) {
    const row = await fail(o, wf, { agent: 'agent2', code: 'no_approval', message: 'Agent 2 did not return an approval request; stopping instead of continuing.' })
    throw withWf(new AgentError('Agent 2 did not return an approval request', 502, 'no_approval'), row.id)
  }
  wf = await advance(o, wf, q => {
    q.stage = 'awaiting_approval'
    q.branch = r.branch
    q.steps.agent2_propose = { status: 'done', agent: 'agent2', agent2_task_id: out.task_id, branch: r.branch, base: r.base, changed_files: r.changed_files, warnings: r.warnings || [], ai_review: r.ai_review ? String(r.ai_review).slice(0, 1500) : null, ai_usage: r.ai_usage || null, checks: 'Server-side Agent 2 does not run lint/tests; GitHub Actions CI runs after the commit.', finished_at: now() }
    q.steps.approval = { id: r.approval_id, status: 'pending', requested_at: now() }
    if (q.zip && r.ai_usage) q.zip.gemini = { ...(q.zip.gemini || {}), ...r.ai_usage, review_partial: Boolean(r.ai_usage.partial), review_available: Boolean(r.ai_review) }
  })
  await o.store.log('warn', 'orchestrator_awaiting_approval', title, { approval_id: r.approval_id }, wf.id, o.userId)
  return { workflow: view(o, wf), next: 'Review and approve in the Approvals tab, then press "Apply approved change".' }
}

// Agent 1 and Agent 2 each define their own AgentError class, so match by shape, not by instanceof.
function asErr(e: unknown): AgentError {
  const x = e as any
  if (x && typeof x.status === 'number' && typeof x.code === 'string' && typeof x.message === 'string') return x as AgentError
  return new AgentError(errMsg(e), 500, 'internal')
}

function withWf(e: AgentError, id: string): AgentError { (e as any).workflowId = id; return e }

// ---------------------------------------------------------------- apply (steps 5-7). Approval gate is checked twice: here and inside Agent 2.
export async function applyWorkflow(o: OCtx, p: any) {
  const loaded = await load(o, p.workflow_id)
  let wf = await sync(o, loaded)
  const st = wf.payload
  if (loaded.payload.stage === 'awaiting_approval' && st.stage === 'failed' && st.failure) throw withWf(new AgentError('Workflow stopped: ' + st.failure.message, 409, st.failure.code), wf.id) // e.g. approval was rejected
  if (st.stage !== 'awaiting_approval') throw withWf(new AgentError(`Cannot apply: workflow is "${st.stage}", not awaiting approval`, 409, 'wrong_stage'), wf.id)
  const ap = await o.store.getApproval(String(st.steps.approval.id))
  const d = ap && ap.details
  if (!ap || !d || d.kind !== 'code_change' || ap.task_id !== st.steps.agent2_propose.agent2_task_id) {
    await fail(o, wf, { agent: 'orchestrator', code: 'approval_mismatch', message: 'The approval does not belong to this workflow; stopped.' })
    throw withWf(new AgentError('Approval does not belong to this workflow', 409, 'approval_mismatch'), wf.id)
  }
  if (ap.status === 'pending') throw withWf(new AgentError('Not approved yet. Approve it in the Approvals tab first.', 409, 'not_approved'), wf.id)
  if (ap.status !== 'approved') { await fail(o, wf, { agent: 'orchestrator', code: 'approval_' + ap.status, message: `Approval ${ap.status}; nothing was applied.` }); throw withWf(new AgentError('Approval is ' + ap.status, 409, 'approval_' + ap.status), wf.id) }
  if (d.executed_at) { await fail(o, wf, { agent: 'orchestrator', code: 'already_executed', message: 'This approval was already used; it cannot be executed twice.' }); throw withWf(new AgentError('Already executed', 409, 'already_executed'), wf.id) }
  if (!ap.decided_at || Date.now() - new Date(ap.decided_at).getTime() > APPROVAL_TTL_MS) { await fail(o, wf, { agent: 'orchestrator', code: 'expired', message: 'Approval is older than 24h; start the workflow again.' }); throw withWf(new AgentError('Approval older than 24h', 409, 'expired'), wf.id) }
  if ((d.sensitive_paths || []).length && p.sensitive_ack !== 'APPROVE-SENSITIVE') throw withWf(new AgentError('This change touches sensitive files (' + d.sensitive_paths.join(', ') + '). Tick the confirmation to continue.', 403, 'sensitive_ack'), wf.id)

  wf = await advance(o, wf, q => { q.stage = 'applying'; q.steps.approval.status = 'approved'; q.steps.agent2_apply = { status: 'running', agent: 'agent2', started_at: now() } }) // lock: a second click gets 409
  let out: any
  try {
    out = await callA2(o, 'apply_change', { approval_id: ap.id, sensitive_ack: p.sensitive_ack })
  } catch (e) {
    const ae = asErr(e)
    const row = await fail(o, wf, { agent: 'agent2', code: ae.code, message: 'Agent 2 could not apply the change: ' + ae.message })
    throw withWf(new AgentError('Agent 2 could not apply the change: ' + clean(o, ae.message), ae.status, ae.code), row.id)
  }
  const r = out.result || {}
  if (!r.applied || !r.commit_sha) {
    const row = await fail(o, wf, { agent: 'agent2', code: 'no_commit', message: 'Agent 2 reported no commit; stopped.' })
    throw withWf(new AgentError('Agent 2 reported no commit', 502, 'no_commit'), row.id)
  }
  wf = await advance(o, wf, q => {
    q.stage = 'ci_waiting'
    q.steps.agent2_apply = { status: 'done', agent: 'agent2', agent2_task_id: out.task_id, branch: r.branch, commit_sha: r.commit_sha, compare_url: r.compare_url, changed_files: r.changed_files, production_touched: false, finished_at: now() }
    q.steps.ci = { state: 'unknown', checked_at: null, runs: ((r.ci_runs || []) as any[]).slice(0, 5) }
  })
  await o.store.log('success', 'orchestrator_change_applied', `${r.branch} @ ${String(r.commit_sha).slice(0, 7)}`, { approval_id: ap.id }, wf.id, o.userId)
  return { workflow: view(o, wf), next: 'Check CI. When it passes, Agent 1 verification starts.' }
}

// ---------------------------------------------------------------- CI check, then hand over to Agent 1 (steps 7-8)
export function evalCi(runs: { sha: string; status: string; conclusion: string | null }[], commit: string): 'none' | 'running' | 'passing' | 'failing' {
  const mine = runs.filter(r => r.sha && commit.startsWith(r.sha))
  if (!mine.length) return 'none'
  if (mine.some(r => r.status !== 'completed')) return 'running'
  return mine.every(r => r.conclusion === 'success' || r.conclusion === 'skipped') ? 'passing' : 'failing'
}

export async function checkCi(o: OCtx, p: any) {
  let wf = await sync(o, await load(o, p.workflow_id))
  const st = wf.payload
  if (st.stage !== 'ci_waiting') throw withWf(new AgentError(`Cannot check CI: workflow is "${st.stage}"`, 409, 'wrong_stage'), wf.id)
  const commit = String(st.steps.agent2_apply.commit_sha)
  let res: any
  try { res = await callA2(o, 'actions_status', { repo: st.repo, branch: st.steps.agent2_apply.branch }) }
  catch (e) {
    const ae = asErr(e)
    const row = await fail(o, wf, { agent: 'agent2', code: ae.code, message: 'Agent 2 could not read CI status: ' + ae.message })
    throw withWf(new AgentError('Agent 2 could not read CI status: ' + clean(o, ae.message), ae.status, ae.code), row.id)
  }
  const runs: any[] = (res.result && res.result.runs) || []
  const state = evalCi(runs, commit)
  const ciStep = { state, checked_at: now(), runs: runs.filter(r => r.sha && commit.startsWith(r.sha)).slice(0, 5), deployments: ((res.result && res.result.deployments) || []).slice(0, 5), failed_jobs: state === 'failing' ? ((res.result && res.result.failed_jobs) || []).slice(0, 5) : undefined }
  if (state === 'failing') {
    const jobs = ciStep.failed_jobs && ciStep.failed_jobs.length ? ' Failed: ' + ciStep.failed_jobs.map((j: any) => j.job + ' (' + (j.failed_steps || []).join(', ') + ')').join('; ') : ''
    await advance(o, wf, q => { q.steps.ci = ciStep })
      .then(w => fail(o, w, { agent: 'agent2', code: 'ci_failed', message: `GitHub Actions CI failed for commit ${commit.slice(0, 7)}.` + jobs }))
      .catch(() => {})
    throw withWf(new AgentError('CI failed for this commit; workflow stopped.' + jobs, 409, 'ci_failed'), wf.id)
  }
  if (state !== 'passing') {
    wf = await advance(o, wf, q => { q.steps.ci = ciStep })
    return { workflow: view(o, wf), ci_state: state, next: state === 'running' ? 'CI is still running. Check again in a minute.' : 'No CI run seen for this commit yet. Check again shortly.' }
  }
  wf = await advance(o, wf, q => { q.stage = 'ci_passed'; q.steps.ci = ciStep })
  return nextAfterCi(o, wf) // CI is green: Agent 1 starts here (SQL review first when the ZIP carried migrations)
}

const reviewedSql = (p: Row): Row[] => ((p.zip && p.zip.sql) || []).filter((x: Row) => x.status === 'reviewed')
async function nextAfterCi(o: OCtx, wf: Row) {
  const p = wf.payload
  if (!reviewedSql(p).length) return runVerify(o, wf)
  if (p.steps.sql && p.steps.sql.status === 'done') return runVerify(o, wf)
  return startSqlStage(o, wf)
}

// ---------------------------------------------------------------- Agent 1: SQL review + separate approvals (step 9)
// One Agent 1 db_change approval per migration file. Nothing executes here; the owner approves each one in the
// Approvals tab and then presses "Run approved SQL" (apply_sql). Agent 1's own classifier runs again at execution.
async function startSqlStage(o: OCtx, wf: Row) {
  const p0_ = wf.payload
  const files = reviewedSql(p0_).sort((a, b) => String(a.path).localeCompare(String(b.path)))
  wf = await advance(o, wf, q => { q.steps.sql = q.steps.sql || { status: 'proposing', agent: 'agent1', items: [], started_at: now() } })
  for (const f of files) {
    if (wf.payload.steps.sql.items.some((x: Row) => x.path === f.path && x.approval_id)) continue // retry never creates a second approval
    let out: any
    try { out = await callA1Sql(o, 'propose_db_change', { title: ('SQL: ' + f.path + ' (' + p0(wf) + ')').slice(0, 120), sql: f.sql }) }
    catch (e) {
      const ae = asErr(e)
      const row = await fail(o, wf, { agent: 'agent1', code: ae.code, message: `Agent 1 refused the SQL migration ${f.path}: ${ae.message}. No SQL was executed.` })
      throw withWf(new AgentError(`Agent 1 refused the SQL migration ${f.path}: ` + clean(o, ae.message), ae.status, ae.code), row.id)
    }
    const apId = out.result && out.result.approval_id
    if (out.status !== 'awaiting_approval' || !apId) {
      const row = await fail(o, wf, { agent: 'agent1', code: 'no_approval', message: `Agent 1 did not return an approval request for ${f.path}; nothing was executed.` })
      throw withWf(new AgentError('Agent 1 did not return an approval request', 502, 'no_approval'), row.id)
    }
    wf = await advance(o, wf, q => { q.steps.sql.items.push({ path: f.path, sha256: f.sha256, risk: f.risk, approval_id: apId, status: 'pending' }) })
  }
  wf = await advance(o, wf, q => { q.stage = 'awaiting_sql'; q.steps.sql.status = 'awaiting_approval' })
  await o.store.log('warn', 'orchestrator_awaiting_sql_approval', p0(wf), { files: files.map(f => f.path) }, wf.id, o.userId)
  return { workflow: view(o, wf), ci_state: 'passing', next: 'Code is on its agent2/* branch and CI passed. Approve each SQL migration in the Approvals tab, then press "Run approved SQL".' }
}

export async function applySqlWorkflow(o: OCtx, p: any) {
  const loaded = await load(o, p.workflow_id)
  let wf = await sync(o, loaded)
  const st = wf.payload
  if (loaded.payload.stage === 'awaiting_sql' && st.stage === 'failed' && st.failure) throw withWf(new AgentError('Workflow stopped: ' + st.failure.message, 409, st.failure.code), wf.id)
  if (st.stage !== 'awaiting_sql') throw withWf(new AgentError(`Cannot run SQL: workflow is "${st.stage}", not awaiting SQL approval`, 409, 'wrong_stage'), wf.id)
  if (p.db_ack !== 'RUN-SQL') throw withWf(new AgentError('Explicit confirmation needed (db_ack)', 403, 'db_ack'), wf.id)
  const items: Row[] = st.steps.sql.items
  if (items.some(i => i.risk === 'destructive') && p.destructive_ack !== 'APPROVE-DESTRUCTIVE') throw withWf(new AgentError('This migration contains destructive statements (DELETE/UPDATE/ALTER ... DROP). Tick the destructive confirmation to continue.', 403, 'destructive_ack'), wf.id)
  // Check EVERY approval before executing ANY of them, so a half-approved set never runs partially.
  for (const it of items) {
    const ap = await o.store.getApproval(String(it.approval_id))
    const d = ap && ap.details
    if (!ap || !d || d.kind !== 'db_change') { await fail(o, wf, { agent: 'orchestrator', code: 'approval_mismatch', message: `The SQL approval for ${it.path} is missing or of the wrong kind; stopped.` }); throw withWf(new AgentError('SQL approval mismatch', 409, 'approval_mismatch'), wf.id) }
    if (ap.status === 'pending') throw withWf(new AgentError(`Not approved yet: ${it.path}. Approve it in the Approvals tab first.`, 409, 'not_approved'), wf.id)
    if (ap.status !== 'approved') { await fail(o, wf, { agent: 'orchestrator', code: 'sql_approval_' + ap.status, message: `SQL approval for ${it.path} is ${ap.status}; no SQL was executed.` }); throw withWf(new AgentError('SQL approval is ' + ap.status, 409, 'approval_' + ap.status), wf.id) }
    if (d.executed_at) { await fail(o, wf, { agent: 'orchestrator', code: 'already_executed', message: `The SQL approval for ${it.path} was already used; it cannot be executed twice.` }); throw withWf(new AgentError('Already executed', 409, 'already_executed'), wf.id) }
    if (createHash('sha256').update(String(d.sql || '')).digest('hex') !== it.sha256) { await fail(o, wf, { agent: 'orchestrator', code: 'sql_checksum', message: `The approved SQL for ${it.path} does not match the uploaded file (checksum); no SQL was executed.` }); throw withWf(new AgentError('SQL checksum mismatch', 409, 'sql_checksum'), wf.id) }
  }
  wf = await advance(o, wf, q => { q.stage = 'applying_sql'; q.steps.sql.status = 'running' }) // lock: a second click gets 409
  for (const it of items) {
    let out: any
    try { out = await callA1Sql(o, 'apply_db_change', { approval_id: it.approval_id, db_ack: 'RUN-SQL' }) }
    catch (e) {
      const ae = asErr(e)
      const row = await fail(o, wf, { agent: 'agent1', code: ae.code, message: `Agent 1 could not run ${it.path}: ${ae.message}. Later migrations were NOT run. Earlier ones are not rolled back automatically.` }).then(async w => {
        try { return await advance(o, w, q => { for (const x of q.steps.sql.items) if (x.status !== 'applied') x.status = x.path === it.path ? 'failed' : 'not_run'; q.steps.sql.status = 'failed' }) } catch { return w }
      })
      throw withWf(new AgentError(`Agent 1 could not run ${it.path}: ` + clean(o, ae.message), ae.status, ae.code), row.id)
    }
    const rows = out.result && typeof out.result.rows === 'number' ? out.result.rows : null
    wf = await advance(o, wf, q => { const x = q.steps.sql.items.find((y: Row) => y.path === it.path); x.status = 'applied'; x.rows = rows; x.applied_at = now() })
    await o.store.log('success', 'orchestrator_sql_applied', it.path, { approval_id: it.approval_id }, wf.id, o.userId)
  }
  wf = await advance(o, wf, q => { q.stage = 'ci_passed'; q.steps.sql.status = 'done'; q.steps.sql.finished_at = now() })
  return runVerify(o, wf) // SQL is in place: Agent 1 now verifies Supabase / Vercel / GitHub
}

// ---------------------------------------------------------------- Agent 1 verification + final report (steps 8-10)
function area(issues: any[], a: string) { return issues.filter(i => i.area === a) }
function compStatus(part: any, issues: any[]): 'ok' | 'attention' | 'unavailable' {
  if (!part || !part.available) return 'unavailable'
  return issues.some(i => i.severity === 'critical' || i.severity === 'error') ? 'attention' : 'ok'
}

export function summarizeAgent1(res: any, repo: string, branch: string) {
  const r = res.result || {}
  const issues: any[] = r.issues || []
  const vProjects: any[] = (r.vercel && r.vercel.data && r.vercel.data.projects) || []
  const branchDeps = vProjects.flatMap(pr => ((pr.deployments || []) as any[]).filter(d => d.branch === branch).map(d => ({ project: pr.name, state: d.state, target: d.target, at: d.at, error: d.error })))
  const ghRepos: any[] = (r.github && r.github.data) || []
  const mine = ghRepos.find(g => String(g.repo).toLowerCase() === repo.toLowerCase())
  return {
    task_id: res.task_id, overall: r.overall, counts: r.counts, generated_at: r.generated_at,
    github: { status: compStatus(r.github, area(issues, 'github')), reason: r.github && r.github.reason || null, repo_monitored: Boolean(mine), latest_runs: mine && mine.runs ? mine.runs.slice(0, 3) : [] },
    vercel: { status: compStatus(r.vercel, area(issues, 'vercel')), reason: r.vercel && r.vercel.reason || null, projects: vProjects.map(pr => ({ name: pr.name, latest: pr.deployments && pr.deployments[0] ? pr.deployments[0].state : null })), branch_deployments: branchDeps },
    supabase: { status: compStatus(r.supabase, area(issues, 'supabase')), reason: r.supabase && r.supabase.reason || null, anon_leaks: ((r.supabase && r.supabase.data && r.supabase.data.anon_probe) || []).filter((x: any) => x.verdict === 'LEAK').length },
    issues: issues.slice(0, 15).map(i => ({ severity: i.severity, area: i.area, message: i.message, target: i.target })),
    ai_summary: r.ai_summary ? String(r.ai_summary).slice(0, 1200) : null
  }
}

export function buildReport(wfId: string, p: Row, a1: any) {
  const s = p.steps
  const warnings: string[] = []
  if (a1.overall && a1.overall !== 'healthy') warnings.push(`Agent 1 overall status: ${a1.overall}. Review the issues below.`)
  for (const c of ['github', 'vercel', 'supabase']) if (a1[c].status === 'unavailable') warnings.push(`${c} could not be verified (${a1[c].reason || 'unavailable'}).`)
  if (!a1.github.repo_monitored && a1.github.status !== 'unavailable') warnings.push('This repo is not in AGENT1_GITHUB_REPOS, so Agent 1 did not check it.')
  if (a1.vercel.status !== 'unavailable' && !a1.vercel.branch_deployments.length) warnings.push('No Vercel deployment seen yet for branch ' + p.branch + ' (a preview may still be building, or previews are off).')
  const zipSql: Row[] = (p.zip && p.zip.sql) || []
  const sqlItems: Row[] = (s.sql && s.sql.items) || []
  const blockedSql = zipSql.filter(x => x.status === 'blocked')
  for (const b of blockedSql) warnings.push(`SQL migration ${b.path} is BLOCKED and was NOT executed: ${b.reason} Code that depends on it must not be promoted until the migration is handled separately.`)
  for (const it of sqlItems) if (it.status !== 'applied') warnings.push(`SQL migration ${it.path} was not applied (${it.status}).`)
  const sqlReport = zipSql.length ? {
    reviewed_by: 'agent1', blocked: blockedSql.map(x => ({ path: x.path, reason: x.reason })),
    migrations: sqlItems.map(it => ({ path: it.path, sha256: it.sha256, risk: it.risk, status: it.status, rows: it.rows ?? null, approval_id: it.approval_id })),
    verified_by: 'agent1 health report (Supabase RLS / schema, Vercel, GitHub)'
  } : null
  const verdict = a1.overall === 'critical' ? 'critical' : warnings.length || a1.overall === 'attention' ? 'attention' : 'healthy'
  return {
    workflow_id: wfId, title: p.request.title, repo: p.repo, verdict, generated_at: now(),
    stages: [
      { name: 'Agent 2 proposal', status: s.agent2_propose.status },
      { name: 'Your approval', status: s.approval.status },
      { name: 'Agent 2 commit', status: s.agent2_apply.status },
      { name: 'GitHub CI', status: s.ci.state },
      ...(zipSql.length ? [{ name: 'Agent 1 SQL migrations', status: sqlItems.length ? (s.sql && s.sql.status) || '-' : 'blocked' }] : []),
      { name: 'Agent 1 verification', status: 'done' }
    ],
    zip: p.zip ? { checksum: p.zip.checksum, base_commit: p.zip.base_commit, base_branch: p.zip.base_branch, files: p.zip.changed_files, gemini: p.zip.gemini || null } : null,
    sql: sqlReport,
    approval: s.approval,
    agent2: { branch: s.agent2_apply.branch, commit_sha: s.agent2_apply.commit_sha, compare_url: s.agent2_apply.compare_url, changed_files: s.agent2_apply.changed_files, warnings: s.agent2_propose.warnings, checks: s.agent2_propose.checks, ci: { state: s.ci.state, runs: s.ci.runs }, production_touched: false },
    agent1: a1,
    warnings,
    next_actions: [
      ...(blockedSql.length ? ['SQL was blocked (see warnings). Do NOT promote this code until the migration is applied some other approved way.'] : []),
      'Review the changes: ' + (s.agent2_apply.compare_url || p.branch),
      ...(verdict !== 'healthy' ? ['Review the Agent 1 issues and warnings above before promoting.'] : []),
      'To go to production: Agent 2 console > Request promote (separate approval + production confirmation). The Orchestrator never merges or deploys.',
      'To run QA: start Agent 3 yourself when you want testing. It was not triggered.'
    ],
    production_touched: false,
    rollback_guidance: 'No automatic rollback is performed. Code: if the preview branch is faulty, stop promotion and revert through a separately approved GitHub change (the agent2/* branch can simply be left unmerged). SQL: migrations that already ran are NOT undone automatically; prepare a separate, reviewed corrective migration (it goes through the same Agent 1 approval) or restore from a Supabase backup. Production is never promoted by this workflow.',
    agent3: { triggered: false, note: 'Reserved for manual QA' }
  }
}

async function runVerify(o: OCtx, wf: Row) {
  const st = wf.payload
  if (st.stage !== 'ci_passed' || st.steps.ci.state !== 'passing') throw withWf(new AgentError('Agent 1 starts only after CI has passed', 409, 'wrong_stage'), wf.id)
  if (reviewedSql(st).length && !(st.steps.sql && st.steps.sql.status === 'done')) throw withWf(new AgentError('SQL migrations in this ZIP have not been run yet. Approve and run them first (the code must not be verified or promoted before its migration is applied).', 409, 'sql_pending'), wf.id)
  wf = await advance(o, wf, q => { q.stage = 'verifying'; q.steps.agent1_verify = { status: 'running', agent: 'agent1', started_at: now() } })
  let res: any
  try { res = await callA1(o, 'health_report') }
  catch (e) {
    const ae = asErr(e)
    const row = await fail(o, wf, { agent: 'agent1', code: ae.code, message: 'Agent 1 verification failed: ' + ae.message })
    throw withWf(new AgentError('Agent 1 verification failed: ' + clean(o, ae.message), ae.status, ae.code), row.id)
  }
  const a1 = summarizeAgent1(res, wf.payload.repo, wf.payload.branch)
  const report = clean(o, buildReport(wf.id, wf.payload, a1))
  wf = await advance(o, wf, q => { q.stage = 'completed'; q.steps.agent1_verify = { status: 'done', agent: 'agent1', agent1_task_id: res.task_id, overall: a1.overall, finished_at: now() } }, { result: clip(report) })
  await o.store.log(report.verdict === 'healthy' ? 'success' : 'warn', 'orchestrator_workflow_completed', `${p0(wf)} verdict: ${report.verdict}`, {}, wf.id, o.userId)
  return { workflow: view(o, wf), ci_state: 'passing', next: 'Workflow finished. Read the combined report.' }
}
const p0 = (wf: Row) => String(wf.title || '').replace(/^Orchestrated: /, '')

export async function verifyWorkflow(o: OCtx, p: any) {
  const wf = await sync(o, await load(o, p.workflow_id))
  if (wf.payload.stage === 'ci_passed') return nextAfterCi(o, wf)
  return runVerify(o, wf)
}

export async function cancelWorkflow(o: OCtx, p: any) {
  let wf = await load(o, p.workflow_id)
  const stage: Stage = wf.payload.stage
  if (!['awaiting_approval', 'ci_waiting', 'awaiting_sql', 'ci_passed'].includes(stage)) throw withWf(new AgentError(`Cannot cancel a workflow that is "${stage}"`, 409, 'wrong_stage'), wf.id)
  wf = await advance(o, wf, q => { q.stage = 'cancelled'; q.failure = { stage, agent: 'orchestrator', code: 'cancelled', message: 'Cancelled by you.' + (stage === 'awaiting_approval' || stage === 'awaiting_sql' ? ' The approval(s) stay pending: reject them in the Approvals tab.' : ' Any branch already created stays on GitHub.'), at: now() } })
  await o.store.log('warn', 'orchestrator_workflow_cancelled', p0(wf), { stage }, wf.id, o.userId)
  return { workflow: view(o, wf) }
}


// ---------------------------------------------------------------- ZIP deployment (steps 1-5)
// The archive is decoded and validated only on the server and is never forwarded anywhere. Agent 2 receives the validated
// file set and builds the compact diff summary (paths, ops, +/- counts, bounded hunks) that is the ONLY thing Gemini sees.
// SQL files are never committed or sent to Gemini: they go to Agent 1's existing classifier / approval / ai_control-only executor.
const MAX_SQL_FILES = 10
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex')

export function reviewSql(e: { path: string; content: string; bytes: number; sha256: string }, alreadyApplied: Map<string, string>): Row {
  const c = classifyExecutableSql(e.content)
  const flat = e.content.replace(/'([^']|'')*'/g, "''")
  const flags: string[] = []
  if (/\bdelete\s+from\b/i.test(flat)) flags.push('DELETE')
  if (/\bupdate\s+(only\s+)?[\w."]+\s+(as\s+\w+\s+)?set\b/i.test(flat)) flags.push('UPDATE')
  if (/\balter\s+table\b[^;]*\bdrop\b/i.test(flat)) flags.push('ALTER TABLE ... DROP')
  if (/\balter\s+table\b[^;]*\balter\s+column\b[^;]*\btype\b/i.test(flat)) flags.push('ALTER COLUMN TYPE')
  const dup = alreadyApplied.get(e.sha256)
  const base = { path: e.path, bytes: e.bytes, sha256: e.sha256, flags, risk: flags.length ? 'destructive' : 'standard' }
  if (!c.ok) return { ...base, status: 'blocked', reason: `Agent 1 safeguards: ${c.reason}.` }
  if (dup) return { ...base, status: 'blocked', reason: `An identical migration (same SHA-256) was already applied by workflow ${dup}; refusing to run it twice.` }
  return { ...base, status: 'reviewed', reason: null, sql: e.content }
}

async function uploadZipWorkflow(o: OCtx, p: any) {
  const repo = validRepo(String(p.repo || ''))
  if (!repoAllowed(o.cfg.c2, repo)) throw new AgentError('Repo is not in AGENT2_GITHUB_REPOS', 403, 'repo_not_allowed')
  const title = String(p.title || 'ZIP deployment').trim().slice(0, 120)
  if (!title) throw new AgentError('title is required', 400, 'bad_request')
  if (!p.zip_base64 || typeof p.zip_base64 !== 'string') throw new AgentError('zip_base64 is required', 400, 'bad_request')
  const baseIn = p.base ? String(p.base) : undefined
  if (baseIn && (!BRANCH_RE.test(baseIn) || baseIn.includes('..'))) throw new AgentError('Bad base branch name', 400, 'bad_request')
  if (p.expected_base_sha !== undefined && p.expected_base_sha !== '' && !/^[a-f0-9]{40}$/i.test(String(p.expected_base_sha))) throw new AgentError('expected_base_sha must be a full 40-character commit SHA', 400, 'bad_request')
  const requestId = p.request_id === undefined ? randomUUID() : String(p.request_id)
  if (!isUuid(requestId)) throw new AgentError('request_id must be a UUID', 400, 'bad_request')

  const parsed = inspectZip(p.zip_base64) // size / path / symlink / bomb / binary / secret checks; throws on any violation
  const sqlEntries = parsed.entries.filter(e => e.sql)
  const code = parsed.entries.filter(e => !e.sql && e.path !== '.blisscco-delete.txt')
  const delManifest = parsed.entries.find(e => e.path === '.blisscco-delete.txt')
  if (sqlEntries.length > MAX_SQL_FILES) throw new AgentError(`Too many SQL files (max ${MAX_SQL_FILES} per ZIP)`, 400, 'too_many_sql')
  if (!code.length && !delManifest) throw new AgentError('This ZIP has SQL files only. Include at least one code change; a SQL-only deployment is not supported by this workflow. Nothing was applied.', 422, 'sql_only')

  // The same ZIP (checksum) may not run twice, and an identical migration may not be applied twice.
  const applied = new Map<string, string>()
  for (const w of await o.store.listWorkflows(100)) {
    const wp = w.payload || {}
    if (wp.zip && wp.zip.checksum === parsed.checksum && wp.repo === repo && !['failed', 'cancelled'].includes(wp.stage)) throw new AgentError('This exact ZIP was already uploaded (workflow ' + w.id + ').', 409, 'duplicate_zip')
    for (const it of (wp.steps && wp.steps.sql && wp.steps.sql.items) || []) if (it.status === 'applied') applied.set(it.sha256, w.id)
  }
  const sql = sqlEntries.map(e => reviewSql(e, applied))

  const delPaths = delManifest ? delManifest.content.split(/\r?\n/).map(x => x.trim()).filter(Boolean) : []
  if (delManifest && !delPaths.length) throw new AgentError('Delete manifest is empty', 400, 'bad_delete_manifest')

  // Target repository + base commit verification (read-only GitHub calls with Agent 2's token).
  const headers = { Authorization: 'Bearer ' + o.cfg.c2.githubToken, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  const api = async (path: string) => { const r = await fetch('https://api.github.com/repos/' + repo + (path ? '/' + path : ''), { headers, signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new AgentError('GitHub read failed (' + r.status + ') while verifying ZIP base', 502, 'github_read'); return r.json() as Promise<any> }
  const repoInfo = await api('')
  if (repoInfo.full_name && String(repoInfo.full_name).toLowerCase() !== repo.toLowerCase()) throw new AgentError('GitHub returned a different repository than requested; stopping', 502, 'repo_mismatch')
  const base = String(baseIn || repoInfo.default_branch || '')
  if (!base) throw new AgentError('Could not determine repository default branch', 502, 'base_unverified')
  const ref = await api('git/ref/heads/' + encodeURIComponent(base))
  const baseSha = String((ref.object && ref.object.sha) || '')
  if (!/^[a-f0-9]{40}$/i.test(baseSha)) throw new AgentError('Could not verify base commit SHA', 502, 'base_unverified')
  if (p.expected_base_sha && String(p.expected_base_sha).toLowerCase() !== baseSha.toLowerCase()) throw new AgentError(`Base branch ${base} is at ${baseSha.slice(0, 7)}, not the ${String(p.expected_base_sha).slice(0, 7)} you expected. Nothing was proposed.`, 409, 'base_changed')
  const commit = await api('git/commits/' + baseSha)
  const tree = await api('git/trees/' + commit.tree.sha + '?recursive=1')
  if (tree.truncated) throw new AgentError('GitHub base tree is truncated; refusing an incomplete change detection', 422, 'tree_truncated')
  const byPath = new Map<string, any>((tree.tree || []).filter((x: any) => x.type === 'blob').map((x: any) => [x.path, x]))

  const files: any[] = []
  const fileMeta: Row[] = []
  for (const e of code) { const op = byPath.has(e.path) ? 'update' : 'create'; files.push({ path: e.path, op, content: e.content }); fileMeta.push({ path: e.path, op, bytes: e.bytes, sha256: e.sha256 }) }
  for (const raw of delPaths) {
    const path = validatePath(raw)
    if (path === '.blisscco-delete.txt') throw new AgentError('Invalid delete manifest', 400, 'bad_delete_manifest')
    if (!byPath.has(path)) throw new AgentError('Delete target does not exist in base: ' + path, 404, 'delete_missing')
    if (files.some(f => f.path.toLowerCase() === path.toLowerCase())) throw new AgentError('Path is both changed and deleted: ' + path, 400, 'bad_delete_manifest')
    files.push({ path, op: 'delete' }); fileMeta.push({ path, op: 'delete', bytes: 0, sha256: null })
  }
  if (!files.length) throw new AgentError('ZIP contains no code changes', 422, 'empty_zip')

  const zipMeta = {
    checksum: parsed.checksum, archive_bytes: Math.floor(p.zip_base64.length * 3 / 4), total_extracted_bytes: parsed.totalBytes, limits: ZIP_LIMITS,
    ignored_entries: parsed.ignored, base_branch: base, base_commit: baseSha, changed_files: fileMeta, sql,
    gemini: { input_max_chars: REVIEW_MAX_INPUT_CHARS, output_max_tokens: REVIEW_MAX_OUTPUT_TOKENS, policy: 'Agent 2 sends a compact diff summary only (paths, operation, type, +/- counts, bounded hunks, findings). The ZIP, unchanged files and full file bodies are never sent.', review_partial: null as boolean | null },
    secret_scan: 'passed (any finding rejects the whole ZIP before anything is stored)'
  }
  const result = await startWorkflow(o, { repo, title, description: `ZIP ${parsed.checksum.slice(0, 12)}; ${files.length} code change(s); ${sql.length} SQL file(s).`, mode: 'files', files, base, request_id: requestId, zip_meta: zipMeta })
  return result
}

// ---------------------------------------------------------------- dispatcher
export async function runAction(o: OCtx, action: string, params: any = {}): Promise<any> {
  if (!(ACTIONS as readonly string[]).includes(action)) throw new AgentError('Unknown action', 400, 'unknown_action')
  switch (action as Action) {
    case 'heartbeat': return { ready: orchReadiness(o.cfg), repos: o.cfg.c2.githubRepos, stages: STAGES, agent3: 'manual (not part of the Orchestrator)' }
    case 'start': return startWorkflow(o, params)
    case 'upload_zip': return uploadZipWorkflow(o, params)
    case 'list': {
      const rows = await o.store.listWorkflows(Number(params.limit) || 30)
      const out: Row[] = []
      for (const r of rows) out.push(await sync(o, r).catch(() => r))
      return { workflows: out.map(r => summary(o, r)) }
    }
    case 'get': return { workflow: view(o, await sync(o, await load(o, params.workflow_id))) }
    case 'apply': return applyWorkflow(o, params)
    case 'check_ci': return checkCi(o, params)
    case 'apply_sql': return applySqlWorkflow(o, params)
    case 'verify': return verifyWorkflow(o, params)
    case 'cancel': return cancelWorkflow(o, params)
  }
}

export { loadOrchConfig }
