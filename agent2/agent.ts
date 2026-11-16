import { loadConfig, readiness, secretValues, type Config } from './config.js'
import { AgentError, clip, errMsg, redact } from './util.js'
import { Store } from './store.js'
import { GitHub, type CommitFile } from './github.js'
import { planCommand, proposeFix, review, type AiResult } from './gemini.js'
import { assertAgentBranch, branchFor, diffStats, gitBlobSha, isProtected, isSensitivePath, sha256, validatePath, validRepo, validateFiles, type FileIn } from './guard.js'

export interface Actor { type: 'user' | 'system'; id: string | null }
export interface Ctx { cfg: Config; store: Store; actor: Actor; calls: Record<string, number> }
// Actions that need only GitHub + Supabase, so they can run on Vercel (/api/agent2) and in Termux.
export const ACTIONS = ['heartbeat', 'repo_inspect', 'actions_status', 'propose_change', 'ai_fix', 'apply_change', 'request_promote', 'apply_promote', 'request_rollback', 'apply_rollback', 'ai_command', 'request_workflow', 'apply_workflow'] as const
export type Action = typeof ACTIONS[number]

export function makeCtx(cfg: Config, actor: Actor): Ctx { return { cfg, store: new Store(cfg), actor, calls: {} } }

export const now = () => new Date().toISOString()
export interface Out { result: any; status?: 'succeeded' | 'awaiting_approval' }

export async function withTask(ctx: Ctx, action: string, title: string, payload: Record<string, unknown>, fn: (taskId: string) => Promise<Out>) {
  const secrets = secretValues(ctx.cfg)
  await ctx.store.ensureAgent()
  await ctx.store.setStatus('running')
  const task = await ctx.store.createTask({ title, description: 'Agent 2 - ' + action, status: 'running', payload: { action, ...payload }, created_by: ctx.actor.id, started_at: now() })
  await ctx.store.log('info', `agent2_${action}_start`, title, {}, task.id, ctx.actor.id)
  try {
    const out = await fn(task.id)
    const status = out.status || 'succeeded'
    const result = clip(redact(out.result, secrets))
    await ctx.store.updateTask(task.id, { status, result, finished_at: status === 'succeeded' ? now() : null })
    for (const [provider, n] of Object.entries(ctx.calls)) if (n > 0) await ctx.store.usage({ provider, endpoint: action, request_count: n })
    ctx.calls = {}
    await ctx.store.log(status === 'succeeded' ? 'success' : 'info', `agent2_${action}_${status}`, title, {}, task.id, ctx.actor.id)
    await ctx.store.setStatus('idle')
    return { task_id: task.id, status, result }
  } catch (e) {
    const msg = redact(errMsg(e), secrets) as string
    await ctx.store.updateTask(task.id, { status: 'failed', error_message: msg, finished_at: now() }).catch(() => {})
    await ctx.store.log('error', `agent2_${action}_failed`, msg, {}, task.id, ctx.actor.id)
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

// Approval gate shared by every apply_* action: approved, not expired, not already executed.
export async function loadApproved(ctx: Ctx, id: unknown, kind: string) {
  const ap = await ctx.store.getApproval(String(id || ''))
  const d = ap && ap.details
  if (!ap || !d || d.kind !== kind) throw new AgentError('Approval not found', 404, 'not_found')
  if (ap.status !== 'approved') throw new AgentError('Not approved yet (status: ' + ap.status + ')', 409, 'not_approved')
  if (d.executed_at) throw new AgentError('Already executed', 409, 'already_executed')
  if (!ap.decided_at || Date.now() - new Date(ap.decided_at).getTime() > 24 * 3600 * 1000) throw new AgentError('Approval older than 24h; request again', 409, 'expired')
  return { ap, d }
}

export async function claim(ctx: Ctx, ap: any, d: any) {
  const ok = await ctx.store.claimApproval(ap.id, { ...d, executed_at: now(), executed_by: ctx.actor.id })
  if (!ok) throw new AgentError('Already executed', 409, 'already_executed')
}
export async function release(ctx: Ctx, ap: any, d: any, e: unknown) {
  await ctx.store.patchApproval(ap.id, { details: { ...d, executed_at: null, last_error: errMsg(e).slice(0, 300) } }).catch(() => {})
}

const READ_LIMIT = 60_000

// ---------------------------------------------------------------- read actions
async function repoInspect(ctx: Ctx, p: any): Promise<Out> {
  const repo = validRepo(p.repo)
  const gh = new GitHub(ctx.cfg, ctx.calls)
  const info = await gh.info(repo)
  const ref = String(p.ref || info.default_branch)
  const sha = await gh.branchSha(repo, ref)
  if (!sha) throw new AgentError('Branch not found: ' + ref, 404, 'not_found')
  const tree = await gh.tree(repo, await gh.commitTreeSha(repo, sha))
  const path = p.path ? validatePath(p.path) : ''
  if (path) {
    const hit = tree.find(e => e.path === path)
    if (hit) {
      const text = await gh.blobText(repo, hit.sha, 1_000_000)
      return { result: { repo, ref, path, bytes: Buffer.byteLength(text), content: text.slice(0, READ_LIMIT), truncated: text.length > READ_LIMIT } }
    }
    const children = tree.filter(e => e.path.startsWith(path + '/')).map(e => e.path).slice(0, 200)
    if (!children.length) throw new AgentError('Path not found: ' + path, 404, 'not_found')
    return { result: { repo, ref, path, files: children } }
  }
  const top = new Map<string, number>()
  for (const e of tree) { const t = e.path.split('/')[0]; top.set(e.path.includes('/') ? t + '/' : t, (top.get(e.path.includes('/') ? t + '/' : t) || 0) + 1) }
  return { result: { repo, ref, default_branch: info.default_branch, pushed_at: info.pushed_at, file_count: tree.length, top_level: [...top.entries()].map(([name, files]) => ({ name, files })).slice(0, 80), recent_commits: await gh.recentCommits(repo, ref, 5) } }
}

export async function monitor(ctx: Ctx, repo: string, branch?: string) {
  const gh = new GitHub(ctx.cfg, ctx.calls)
  const runs = await gh.runs(repo, branch, 5)
  const latest = runs[0]
  const overall = !latest ? 'none' : latest.status !== 'completed' ? 'running' : latest.conclusion === 'success' ? 'passing' : 'failing'
  const failed = latest && latest.conclusion === 'failure' ? await gh.failedJobs(repo, latest.id).catch(() => []) : []
  const deployments = branch ? await gh.deployments(repo, branch).catch(() => []) : []
  return { repo, branch: branch || null, overall, runs, failed_jobs: failed, deployments }
}

async function actionsStatus(ctx: Ctx, p: any): Promise<Out> {
  return { result: await monitor(ctx, validRepo(p.repo), p.branch ? String(p.branch) : undefined) }
}

// ---------------------------------------------------------------- propose (nothing is written to GitHub)
async function proposeChange(ctx: Ctx, p: any, fix?: { explanation: string }): Promise<any> {
  const gh = new GitHub(ctx.cfg, ctx.calls)
  const repo = gh.repo(validRepo(p.repo))
  const title = String(p.title || '').trim().slice(0, 120)
  if (!title) throw new AgentError('title is required', 400)
  const description = String(p.description || '').slice(0, 1000)
  const files: FileIn[] = validateFiles(p.files)
  return withTask(ctx, 'propose_change', 'Propose: ' + title, { repo, files }, async taskId => {
    const info = await gh.info(repo)
    const base = String(p.base || info.default_branch)
    const baseSha = await gh.branchSha(repo, base)
    if (!baseSha) throw new AgentError('Base branch not found: ' + base, 404, 'not_found')
    const tree = await gh.tree(repo, await gh.commitTreeSha(repo, baseSha))
    const byPath = new Map(tree.map(e => [e.path, e]))
    const entries: any[] = []
    const warnings: string[] = []
    const previews: any[] = []
    for (const f of files) {
      const ex = byPath.get(f.path)
      if (ex && ex.mode !== '100644' && ex.mode !== '100755') throw new AgentError('Not a regular file: ' + f.path, 400, 'bad_path')
      if (f.op === 'create' && ex) throw new AgentError(`${f.path} already exists. Use op "update" so nothing is overwritten by accident.`, 409, 'exists')
      if (f.op !== 'create' && !ex) throw new AgentError(`${f.path} does not exist in ${base}`, 404, 'not_found')
      const old = ex ? await gh.blobText(repo, ex.sha) : null
      if (f.op === 'update' && old === f.content) throw new AgentError('No change in ' + f.path, 400, 'no_change')
      const st = diffStats(old, f.op === 'delete' ? null : (f.content as string))
      if (f.op === 'delete') warnings.push('DELETES ' + f.path)
      if (f.op === 'update' && old && old.length > 2000 && (f.content as string).length < old.length * 0.3) warnings.push(`${f.path} shrinks by more than 70%`)
      const content = f.content ?? ''
      entries.push({ path: f.path, op: f.op, mode: ex ? ex.mode : '100644', old_sha: ex ? ex.sha : null, new_sha: f.op === 'delete' ? null : gitBlobSha(content), sha256: sha256(content), bytes: Buffer.byteLength(content), added: st.added, removed: st.removed, sensitive: isSensitivePath(f.path), preview: st.patch.slice(0, 700) })
      previews.push({ path: f.path, op: f.op, added: st.added, removed: st.removed, patch: st.patch.slice(0, 1500) })
    }
    const sensitive = entries.filter(e => e.sensitive).map(e => e.path)
    if (sensitive.length) warnings.push('Touches sensitive files: ' + sensitive.join(', '))
    const ai = await review(ctx.cfg, { title, description, base, files: previews })
    await recordAi(ctx, 'propose_change_review', ai)
    const branch = branchFor(title)
    assertAgentBranch(branch, ctx.cfg.protectedBranches)
    const ap = await ctx.store.createApproval({
      task_id: taskId, title: `Code change: ${title}`,
      details: { kind: 'code_change', repo, title, description, base_branch: base, base_sha: baseSha, branch, files: entries, sensitive_paths: sensitive, warnings, ai_review: ai.text, ai_fix: fix ? fix.explanation.slice(0, 500) : undefined, production: false, note: `Creates branch ${branch} from ${base}@${baseSha.slice(0, 7)} with one commit. ${base} is not touched.` }
    })
    await ctx.store.log('warn', 'agent2_approval_requested', 'Code change: ' + title, { approval_id: ap.id }, taskId, ctx.actor.id)
    return { status: 'awaiting_approval', result: { approval_id: ap.id, branch, base: `${base}@${baseSha.slice(0, 7)}`, changed_files: entries.map(({ path, op, added, removed, sensitive: s }) => ({ path, op, added, removed, sensitive: s })), warnings, ai_review: ai.text, ai_note: ai.text ? undefined : ai.error, next: 'Approve in the Approvals tab, then press "Create branch & commit" in the Agent 2 console.' + (sensitive.length ? ' Sensitive files need the extra confirmation tick.' : '') } }
  })
}

async function aiFix(ctx: Ctx, p: any): Promise<any> {
  const gh = new GitHub(ctx.cfg, ctx.calls)
  const repo = gh.repo(validRepo(p.repo))
  const problem = String(p.problem || '').trim().slice(0, 2000)
  const paths: string[] = (Array.isArray(p.paths) ? p.paths : []).slice(0, 5).map(validatePath)
  if (!problem || !paths.length) throw new AgentError('problem and paths[] (max 5) are required', 400)
  const info = await gh.info(repo)
  const base = String(p.base || info.default_branch)
  const sha = await gh.branchSha(repo, base)
  if (!sha) throw new AgentError('Base branch not found: ' + base, 404, 'not_found')
  const tree = await gh.tree(repo, await gh.commitTreeSha(repo, sha))
  const current: { path: string; content: string }[] = []
  for (const path of paths) {
    const e = tree.find(x => x.path === path)
    if (!e) throw new AgentError(path + ' does not exist in ' + base, 404, 'not_found')
    current.push({ path, content: await gh.blobText(gh.repo(repo), e.sha, 60_000) })
  }
  const ai = await proposeFix(ctx.cfg, { problem, error_log: String(p.error_log || '').slice(0, 6000), files: current })
  await ctx.store.ensureAgent()
  await recordAi(ctx, 'ai_fix', ai)
  if (!ai.text) throw new AgentError('Gemini could not produce a fix: ' + (ai.error || 'empty'), 502, 'gemini')
  let parsed: any
  try { parsed = JSON.parse(ai.text.replace(/^```(?:json)?\s*|\s*```$/g, '')) } catch { throw new AgentError('Gemini returned invalid JSON; nothing was changed', 502, 'gemini_format') }
  const out = (Array.isArray(parsed.files) ? parsed.files : []).filter((f: any) => f && typeof f.content === 'string')
  for (const f of out) if (!paths.includes(f.path)) throw new AgentError('Gemini tried to change a file you did not select (' + String(f.path).slice(0, 80) + '); nothing was changed', 422, 'out_of_scope')
  if (!out.length) throw new AgentError('Gemini proposed no changes', 422, 'no_change')
  return proposeChange(ctx, { repo, base, title: String(p.title || 'Fix: ' + problem).slice(0, 100), description: problem, files: out.map((f: any) => ({ path: f.path, op: 'update', content: f.content })) }, { explanation: String(parsed.explanation || '') })
}

// ---------------------------------------------------------------- apply (create branch + commit on GitHub)
async function applyChange(ctx: Ctx, p: any): Promise<any> {
  const { ap, d } = await loadApproved(ctx, p.approval_id, 'code_change')
  if ((d.sensitive_paths || []).length && p.sensitive_ack !== 'APPROVE-SENSITIVE') throw new AgentError('This change touches sensitive files (' + d.sensitive_paths.join(', ') + '). Tick the confirmation to continue.', 403, 'sensitive_ack')
  const task = ap.task_id ? await ctx.store.getTask(ap.task_id) : null
  const stored: any[] = (task && task.payload && task.payload.files) || []
  const files: CommitFile[] = []
  for (const e of d.files as any[]) {
    if (e.op === 'delete') { files.push({ path: e.path, delete: true }); continue }
    const s = stored.find(x => x.path === e.path)
    if (!s || typeof s.content !== 'string' || sha256(s.content) !== e.sha256) throw new AgentError('Stored content for ' + e.path + ' does not match what was approved; request the change again', 409, 'content_mismatch')
    files.push({ path: e.path, mode: e.mode, content: s.content })
  }
  if (stored.length !== (d.files as any[]).length) throw new AgentError('Stored change set does not match the approval; request the change again', 409, 'content_mismatch')
  assertAgentBranch(d.branch, ctx.cfg.protectedBranches)
  return withTask(ctx, 'apply_change', 'Apply: ' + ap.title, { approval_id: ap.id, branch: d.branch }, async () => {
    await claim(ctx, ap, d)
    const gh = new GitHub(ctx.cfg, ctx.calls)
    let created = false
    try {
      await gh.createBranch(d.repo, d.branch, d.base_sha)
      created = true
      const commitSha = await gh.commit(d.repo, d.branch, d.base_sha, `${d.title}\n\nAgent 2 change ${ap.id}`, files)
      await ctx.store.patchApproval(ap.id, { details: { ...d, executed_at: now(), executed_by: ctx.actor.id, commit_sha: commitSha } })
      if (ap.task_id) await ctx.store.updateTask(ap.task_id, { status: 'succeeded', finished_at: now(), result: { applied: true, branch: d.branch, commit_sha: commitSha } })
      await ctx.store.log('success', 'agent2_branch_pushed', `${d.repo} ${d.branch}`, { approval_id: ap.id, commit: commitSha }, null, ctx.actor.id)
      const mon = await monitor(ctx, d.repo, d.branch).catch(() => null)
      return { result: { applied: true, repo: d.repo, branch: d.branch, commit_sha: commitSha, base: `${d.base_branch}@${String(d.base_sha).slice(0, 7)}`, changed_files: d.files.map((e: any) => ({ path: e.path, op: e.op, added: e.added, removed: e.removed })), compare_url: `https://github.com/${d.repo}/compare/${d.base_branch}...${d.branch}`, ci_runs: mon ? mon.runs : [], deployments: mon ? mon.deployments : [], deployment_trigger: mon && (mon.runs.length || mon.deployments.length) ? 'triggered (see ci_runs / deployments)' : 'not seen yet; open Monitor in about a minute', production_touched: false, rollback: 'Request rollback deletes this branch; ' + d.base_branch + ' was never touched.' } }
    } catch (e) {
      if (created) await gh.deleteBranch(d.repo, d.branch).catch(() => {}) // leave nothing half-done so a retry is clean
      await release(ctx, ap, d, e)
      throw e
    }
  })
}

// ---------------------------------------------------------------- promote to production (PR + merge)
async function requestPromote(ctx: Ctx, p: any): Promise<any> {
  const gh = new GitHub(ctx.cfg, ctx.calls)
  const repo = gh.repo(validRepo(p.repo))
  const branch = String(p.branch || '')
  assertAgentBranch(branch, ctx.cfg.protectedBranches)
  return withTask(ctx, 'request_promote', `Promote ${branch} to production`, { repo, branch }, async taskId => {
    const info = await gh.info(repo)
    const headSha = await gh.branchSha(repo, branch)
    if (!headSha) throw new AgentError('Branch not found: ' + branch, 404, 'not_found')
    const mon = await monitor(ctx, repo, branch)
    const production = isProtected(info.default_branch, ctx.cfg.protectedBranches)
    const title = `Promote ${branch} -> ${info.default_branch}${production ? ' - PRODUCTION' : ''}`
    const ap = await ctx.store.createApproval({ task_id: taskId, title, details: { kind: 'promote', repo, branch, base_branch: info.default_branch, head_sha: headSha, production, ci: mon.overall, ci_runs: mon.runs.slice(0, 3), note: 'Opens a pull request and squash-merges it. Merge is pinned to head_sha: if the branch changes after approval, nothing is merged.' } })
    await ctx.store.log('warn', 'agent2_approval_requested', title, { approval_id: ap.id }, taskId, ctx.actor.id)
    return { status: 'awaiting_approval', result: { approval_id: ap.id, production, ci: mon.overall, next: 'Approve in the Approvals tab, then press Merge in the Agent 2 console' + (production ? ' (needs the PRODUCTION tick).' : '.') } }
  })
}

async function applyPromote(ctx: Ctx, p: any): Promise<any> {
  const { ap, d } = await loadApproved(ctx, p.approval_id, 'promote')
  if (d.production && p.production_ack !== 'APPROVE-PRODUCTION') throw new AgentError('Production merge needs explicit confirmation (production_ack)', 403, 'production_ack')
  assertAgentBranch(d.branch, ctx.cfg.protectedBranches)
  return withTask(ctx, 'apply_promote', 'Apply: ' + ap.title, { approval_id: ap.id, branch: d.branch }, async () => {
    const gh = new GitHub(ctx.cfg, ctx.calls)
    const head = await gh.branchSha(d.repo, d.branch)
    if (head !== d.head_sha) throw new AgentError('Branch changed after approval; request promotion again', 409, 'head_moved')
    const mon = await monitor(ctx, d.repo, d.branch)
    const mine = mon.runs.filter(r => d.head_sha.startsWith(r.sha))
    if (mine.some(r => r.status !== 'completed')) throw new AgentError('CI is still running for this commit; wait and retry', 409, 'ci_running')
    if (mine.some(r => r.conclusion !== 'success' && r.conclusion !== 'skipped')) throw new AgentError('CI failed for this commit; fix it before promoting', 409, 'ci_failed')
    await claim(ctx, ap, d)
    try {
      const baseBefore = await gh.branchSha(d.repo, d.base_branch)
      const existing = await gh.findPr(d.repo, d.branch, d.base_branch)
      const pr = existing || await gh.createPr(d.repo, d.branch, d.base_branch, 'Agent 2: ' + d.branch, `Approved promotion (approval ${ap.id}).`)
      const mergeSha = await gh.mergePr(d.repo, pr.number, d.head_sha)
      await ctx.store.patchApproval(ap.id, { details: { ...d, executed_at: now(), executed_by: ctx.actor.id, merge_sha: mergeSha, base_before_sha: baseBefore, pr_number: pr.number } })
      await ctx.store.log('success', 'agent2_promoted', `${d.repo} ${d.branch} -> ${d.base_branch}`, { approval_id: ap.id, merge_sha: mergeSha }, null, ctx.actor.id)
      return { result: { merged: true, repo: d.repo, pr_url: pr.url, merge_sha: mergeSha, base_before_sha: baseBefore, production: d.production, deployment_trigger: 'Merging to ' + d.base_branch + ' triggers your Vercel production deploy. Check Agent 1 > Vercel status.', rollback: 'Request rollback creates a revert pull request.' } }
    } catch (e) { await release(ctx, ap, d, e); throw e }
  })
}

// ---------------------------------------------------------------- rollback
async function requestRollback(ctx: Ctx, p: any): Promise<any> {
  const gh = new GitHub(ctx.cfg, ctx.calls)
  const repo = gh.repo(validRepo(p.repo))
  const branch = String(p.branch || '')
  assertAgentBranch(branch, ctx.cfg.protectedBranches)
  return withTask(ctx, 'request_rollback', `Rollback ${branch}`, { repo, branch }, async taskId => {
    const changes = (await ctx.store.findApprovals('code_change', branch)).filter(a => a.details && a.details.executed_at && a.details.repo === repo)
    const promotes = (await ctx.store.findApprovals('promote', branch)).filter(a => a.details && a.details.merge_sha && a.details.repo === repo)
    const change = changes[0]
    let details: any
    if (promotes.length) {
      if (!change) throw new AgentError('This branch was merged but was not created by an Agent 2 API change. Use `git revert` in Termux (needs approval).', 409, 'no_record')
      const c = change.details
      details = { kind: 'rollback', mode: 'revert_pr', repo, branch, merge_sha: promotes[0].details.merge_sha, base_branch: c.base_branch, files: c.files.map((f: any) => ({ path: f.path, op: f.op, mode: f.mode, old_sha: f.old_sha, new_sha: f.new_sha })), production: true, note: 'Creates a revert branch and opens a pull request restoring ONLY the files this change touched. Nothing is merged automatically.' }
    } else {
      const head = await gh.branchSha(repo, branch)
      if (!head) throw new AgentError('Branch not found (already removed?): ' + branch, 404, 'not_found')
      details = { kind: 'rollback', mode: 'delete_branch', repo, branch, expected_head: head, production: false, note: 'Deletes the unmerged branch. Its commits stay recoverable on GitHub for a while via the SHA ' + head.slice(0, 7) + '.' }
    }
    const title = `Rollback ${branch} (${details.mode})`
    const ap = await ctx.store.createApproval({ task_id: taskId, title, details })
    await ctx.store.log('warn', 'agent2_approval_requested', title, { approval_id: ap.id }, taskId, ctx.actor.id)
    return { status: 'awaiting_approval', result: { approval_id: ap.id, mode: details.mode, next: 'Approve in the Approvals tab, then press Rollback in the Agent 2 console.' } }
  })
}

async function applyRollback(ctx: Ctx, p: any): Promise<any> {
  const { ap, d } = await loadApproved(ctx, p.approval_id, 'rollback')
  if (d.production && p.production_ack !== 'APPROVE-PRODUCTION') throw new AgentError('Rollback of merged code needs explicit confirmation (production_ack)', 403, 'production_ack')
  assertAgentBranch(d.branch, ctx.cfg.protectedBranches)
  return withTask(ctx, 'apply_rollback', 'Apply: ' + ap.title, { approval_id: ap.id, mode: d.mode }, async () => {
    const gh = new GitHub(ctx.cfg, ctx.calls)
    await claim(ctx, ap, d)
    try {
      if (d.mode === 'delete_branch') {
        const head = await gh.branchSha(d.repo, d.branch)
        if (head && head !== d.expected_head) throw new AgentError('Branch has new commits since the request; request rollback again', 409, 'head_moved')
        if (head) await gh.deleteBranch(d.repo, d.branch)
        await ctx.store.log('success', 'agent2_branch_deleted', `${d.repo} ${d.branch}`, { approval_id: ap.id }, null, ctx.actor.id)
        return { result: { rolled_back: true, mode: d.mode, branch_deleted: d.branch, production_touched: false } }
      }
      const baseSha = await gh.branchSha(d.repo, d.base_branch)
      if (!baseSha) throw new AgentError('Base branch not found', 404, 'not_found')
      const tree = await gh.tree(d.repo, await gh.commitTreeSha(d.repo, baseSha))
      const cur = new Map(tree.map(e => [e.path, e]))
      const conflicts: string[] = []
      const files: CommitFile[] = []
      for (const f of d.files as any[]) {
        const now_ = cur.get(f.path)
        if (f.op === 'delete') { if (now_) conflicts.push(f.path); else files.push({ path: f.path, mode: f.mode, sha: f.old_sha }); continue }
        if (!now_ || now_.sha !== f.new_sha) { conflicts.push(f.path); continue } // someone changed it since: never overwrite
        files.push(f.op === 'create' ? { path: f.path, delete: true } : { path: f.path, mode: f.mode, sha: f.old_sha })
      }
      if (conflicts.length) throw new AgentError('Files changed again since the merge, so an automatic revert could overwrite newer work: ' + conflicts.join(', '), 409, 'conflict')
      const rb = branchFor('revert ' + d.branch.replace(/^agent2\//, '')).replace('agent2/', 'agent2/revert-').replace('revert-revert-', 'revert-')
      await gh.createBranch(d.repo, rb, baseSha)
      try {
        await gh.commit(d.repo, rb, baseSha, `Revert ${d.branch}\n\nAgent 2 rollback ${ap.id}`, files)
      } catch (e) { await gh.deleteBranch(d.repo, rb).catch(() => {}); throw e }
      const pr = await gh.createPr(d.repo, rb, d.base_branch, 'Revert ' + d.branch, `Agent 2 rollback (approval ${ap.id}). Restores only the files changed by ${d.branch}.`)
      await ctx.store.log('success', 'agent2_revert_pr', `${d.repo} ${pr.url}`, { approval_id: ap.id }, null, ctx.actor.id)
      return { result: { rolled_back: false, mode: d.mode, revert_branch: rb, pr_url: pr.url, next: 'Review the PR. To merge it use Request promote on the revert branch.', production_touched: false } }
    } catch (e) { await release(ctx, ap, d, e); throw e }
  })
}

// ---------------------------------------------------------------- workflow run (needs approval)
async function requestWorkflow(ctx: Ctx, p: any): Promise<any> {
  const gh = new GitHub(ctx.cfg, ctx.calls)
  const repo = gh.repo(validRepo(p.repo))
  const wanted = String(p.workflow || '').trim().toLowerCase().slice(0, 120)
  if (!wanted) throw new AgentError('Which workflow? Write its file name, for example ci.yml', 400)
  return withTask(ctx, 'request_workflow', 'Run workflow ' + wanted, { repo, workflow: wanted }, async taskId => {
    const info = await gh.info(repo)
    const ref = String(p.ref || info.default_branch)
    if (!/^[\w./-]{1,100}$/.test(ref) || ref.includes('..')) throw new AgentError('Bad branch name', 400)
    const head = await gh.branchSha(repo, ref)
    if (!head) throw new AgentError('Branch not found: ' + ref, 404, 'not_found')
    const all = await gh.workflows(repo)
    const file = (w: { path: string }) => w.path.split('/').pop()!.toLowerCase()
    let hits = all.filter(w => file(w) === wanted || w.name.toLowerCase() === wanted || String(w.id) === wanted)
    if (!hits.length) hits = all.filter(w => file(w).includes(wanted) || w.name.toLowerCase().includes(wanted))
    if (hits.length !== 1) throw new AgentError((hits.length ? 'More than one workflow matches: ' : 'Workflow not found. Available: ') + (hits.length ? hits : all).map(w => file(w)).join(', '), 404, 'not_found')
    const wf = hits[0]
    if (wf.state !== 'active') throw new AgentError('Workflow is not active: ' + file(wf), 409, 'workflow_inactive')
    const production = isProtected(ref, ctx.cfg.protectedBranches)
    const details = { kind: 'workflow_run', repo, workflow_id: wf.id, workflow_path: wf.path, workflow_name: wf.name, ref, expected_head: head, production, note: 'Starts this workflow by hand on ' + ref + '. It runs the code already in that branch. Nothing is changed in GitHub except the new run.' }
    const title = `Run workflow ${file(wf)} on ${ref}`
    const ap = await ctx.store.createApproval({ task_id: taskId, title, details })
    await ctx.store.log('warn', 'agent2_approval_requested', title, { approval_id: ap.id }, taskId, ctx.actor.id)
    return { status: 'awaiting_approval', result: { approval_id: ap.id, workflow: wf.path, ref, production, next: 'Approve in the Approvals tab, then press Run workflow in the Agent 2 console.' } }
  })
}

async function applyWorkflow(ctx: Ctx, p: any): Promise<any> {
  const { ap, d } = await loadApproved(ctx, p.approval_id, 'workflow_run')
  if (d.production && p.production_ack !== 'APPROVE-PRODUCTION') throw new AgentError('Running a workflow on a protected branch needs explicit confirmation (production_ack)', 403, 'production_ack')
  return withTask(ctx, 'apply_workflow', 'Apply: ' + ap.title, { approval_id: ap.id }, async () => {
    const gh = new GitHub(ctx.cfg, ctx.calls)
    await claim(ctx, ap, d)
    try {
      const head = await gh.branchSha(d.repo, d.ref)
      if (!head) throw new AgentError('Branch not found: ' + d.ref, 404, 'not_found')
      if (head !== d.expected_head) throw new AgentError('Branch has new commits since the request; request again', 409, 'head_moved')
      await gh.dispatchWorkflow(d.repo, d.workflow_id, d.ref)
      await ctx.store.log('success', 'agent2_workflow_started', `${d.repo} ${d.workflow_path} on ${d.ref}`, { approval_id: ap.id }, null, ctx.actor.id)
      return { result: { started: true, repo: d.repo, workflow: d.workflow_path, branch: d.ref, next: 'Press GitHub Actions (Inspect & monitor) in a minute to see the result.' } }
    } catch (e) { await release(ctx, ap, d, e); throw e }
  })
}

// ---------------------------------------------------------------- free-text command (AI picks ONE allowed action; code validates everything)
async function aiCommand(ctx: Ctx, p: any): Promise<any> {
  const gh = new GitHub(ctx.cfg, ctx.calls)
  const repo = gh.repo(validRepo(p.repo))
  const text = String(p.text || '').trim().slice(0, 1000)
  if (!text) throw new AgentError('Write what you want Agent 2 to do', 400)
  const branches = await gh.agentBranches(repo)
  const r = await planCommand(ctx.cfg, { request: text, agent_branches: branches.slice(0, 50) })
  await recordAi(ctx, 'ai_command', r)
  if (!r.text) throw new AgentError('Gemini could not read the request: ' + (r.error || 'no answer'), 502, 'ai_unavailable')
  let plan: any
  try { plan = JSON.parse(r.text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()) } catch { throw new AgentError('Gemini answer was not valid JSON. Try again in simpler words.', 502, 'ai_bad_output') }
  const INTENTS = ['check_ci', 'list_branches', 'inspect', 'delete_branch', 'run_workflow', 'fix_code']
  const intent = INTENTS.includes(String(plan && plan.intent)) ? String(plan.intent) : 'unsupported'
  const understood = { intent, explanation: String((plan && plan.explanation) || '').slice(0, 300) }
  const safeRef = (v: unknown) => (typeof v === 'string' && /^[\w./-]{1,100}$/.test(v) && !v.includes('..') ? v : undefined)
  let out: any
  switch (intent) {
    case 'check_ci': { const branch = safeRef(plan.branch); out = await withTask(ctx, 'actions_status', 'GitHub Actions status ' + repo, { repo, branch: branch || null }, () => actionsStatus(ctx, { repo, branch })); break }
    case 'list_branches': out = await withTask(ctx, 'list_branches', 'List agent2 branches ' + repo, { repo }, async () => ({ result: { repo, branches, count: branches.length } })); break
    case 'inspect': out = await withTask(ctx, 'repo_inspect', 'Inspect repo ' + repo, { repo }, () => repoInspect(ctx, { repo, path: typeof plan.path === 'string' ? plan.path : undefined, ref: safeRef(plan.ref) })); break
    case 'delete_branch': {
      const branch = String(plan.branch || '')
      if (!branches.includes(branch)) throw new AgentError('That branch is not one of the agent2/* branches: ' + (branches.join(', ') || 'none exist'), 404, 'not_found')
      out = await requestRollback(ctx, { repo, branch }); break
    }
    case 'run_workflow': out = await requestWorkflow(ctx, { repo, workflow: plan.workflow, ref: safeRef(plan.ref) }); break
    case 'fix_code': out = await aiFix(ctx, { repo, paths: Array.isArray(plan.paths) ? plan.paths.map(String) : [], problem: String(plan.problem || text) }); break
    default:
      await ctx.store.log('warn', 'agent2_command_unsupported', understood.explanation || 'unsupported request', {}, null, ctx.actor.id)
      return { status: 'succeeded', result: { unsupported: true, message: understood.explanation || 'This request is not something Agent 2 can do safely.' }, understood }
  }
  return { ...out, understood }
}

export async function runAction(ctx: Ctx, action: string, params: any = {}): Promise<any> {
  if (!(ACTIONS as readonly string[]).includes(action)) throw new AgentError('Unknown action', 400, 'unknown_action')
  switch (action as Action) {
    case 'heartbeat': {
      const agent = await ctx.store.heartbeat()
      return { agent: { id: agent.id, name: agent.name, status: agent.status, last_heartbeat_at: agent.last_heartbeat_at }, ready: readiness(ctx.cfg), repos: ctx.cfg.githubRepos, protected_branches: ctx.cfg.protectedBranches, model: ctx.cfg.geminiModel }
    }
    case 'repo_inspect': return withTask(ctx, action, 'Inspect repo ' + String(params.repo || '') + (params.path ? '/' + params.path : ''), { repo: params.repo, path: params.path || null }, () => repoInspect(ctx, params))
    case 'actions_status': return withTask(ctx, action, 'GitHub Actions status ' + String(params.repo || ''), { repo: params.repo, branch: params.branch || null }, () => actionsStatus(ctx, params))
    case 'propose_change': return proposeChange(ctx, params)
    case 'ai_fix': return aiFix(ctx, params)
    case 'apply_change': return applyChange(ctx, params)
    case 'request_promote': return requestPromote(ctx, params)
    case 'apply_promote': return applyPromote(ctx, params)
    case 'request_rollback': return requestRollback(ctx, params)
    case 'apply_rollback': return applyRollback(ctx, params)
    case 'ai_command': return aiCommand(ctx, params)
    case 'request_workflow': return requestWorkflow(ctx, params)
    case 'apply_workflow': return applyWorkflow(ctx, params)
  }
}

export { loadConfig }
