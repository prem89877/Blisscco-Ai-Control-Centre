import { loadConfig, readiness, secretValues, type Config } from './config.js'
import { AgentError, clip, errMsg, extractFailedLog, redact, redactString } from './util.js'
import { Store } from './store.js'
import { GitHub, type CommitFile } from './github.js'
import { planCommand, proposeFix, review, type AiResult } from './gemini.js'
import { runDev } from './dev.js'
import { devLimits } from './config.js'
import { assertAgentBranch, branchFor, diffStats, gitBlobSha, isProtected, LIMITS, isSensitivePath, sha256, validatePath, validRepo, validateFiles, type FileIn } from './guard.js'

export interface Actor { type: 'user' | 'system'; id: string | null }
export interface Ctx { cfg: Config; store: Store; actor: Actor; calls: Record<string, number> }
// Actions that need only GitHub + Supabase, so they can run on Vercel (/api/agent2) and in Termux.
export const ACTIONS = ['heartbeat', 'github_branches', 'repo_inspect', 'actions_status', 'propose_change', 'ai_fix', 'apply_change', 'request_promote', 'apply_promote', 'request_rollback', 'apply_rollback', 'ai_command', 'request_workflow', 'apply_workflow', 'dev_chat', 'dev_assist', 'dev_proposal', 'dev_diagnose'] as const
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

// ---------------------------------------------------------------- strict branch scope
// A request is "strict" when it comes from the dashboard (branch_context_required) or carries the owner's selection (selected_branch).
// Strict requests NEVER fall back to the repository default branch: a missing branch is 400 branch_required, a branch that differs from
// the owner's dropdown selection is 409 branch_override, a moved branch is 409 base_changed.
// Only legacy callers (CLI / Orchestrator ZIP workflow, which pins its own base + SHA) send neither flag and keep the documented default.
export interface BaseScope { strict: boolean; branch: string; pins: string[]; working: boolean }
export const isStrict = (p: any) => Boolean(p && (p.branch_context_required || p.selected_branch))
export const isWorkingBranch = (b: unknown) => typeof b === 'string' && b.startsWith('agent2/')
// CONTINUE-ON-EXISTING-BRANCH: by default every proposal creates a NEW agent2/* branch from the selected base. When the owner's request names
// an existing agent2/* branch AND says to keep using it ("existing", "naya mat banao", "isi branch"...), the change is appended as ONE more
// commit on that branch instead. Never silent: an unknown or ambiguous branch name is an error, not a quiet fallback to a new branch.
const CONTINUE_WORDS = /(existing|continue|same branch|naya mat|nayi? branch mat|new branch mat|do not create|don'?t create|isi branch|usi branch|working branch)/i
export function namedWorkingBranch(text: string, existing: string[]): string | undefined {
  const named = [...new Set((String(text).match(/agent2\/[A-Za-z0-9][A-Za-z0-9._\/-]*/g) || []).map(t => t.replace(/[.\/-]+$/, '')))]
  if (!named.length || !CONTINUE_WORDS.test(text)) return undefined
  if (named.length > 1) throw new AgentError('The request names more than one agent2/* branch (' + named.slice(0, 4).join(', ') + '). Name exactly one branch to continue on.', 400, 'branch_ambiguous')
  if (!existing.includes(named[0])) throw new AgentError('Branch to continue on does not exist: ' + named[0] + '. Nothing was proposed (no new branch is created silently).', 404, 'branch_not_found')
  return named[0]
}
export function scopeOf(p: any, key: 'ref' | 'base' | 'branch', opts: { allowWorking?: boolean } = {}): BaseScope {
  const strict = isStrict(p)
  const sel = p.selected_branch ? String(p.selected_branch) : ''
  const asked = p[key] ? String(p[key]) : ''
  const own = key === 'base' ? p.expected_base_sha : key === 'ref' ? (!p.branch || String(p.branch) === asked ? p.branch_sha : undefined) : p.branch_sha
  const uniq = (xs: unknown[]) => [...new Set(xs.filter(Boolean).map(x => String(x).toLowerCase()))]
  if (!strict) return { strict, branch: asked, pins: uniq([own]), working: false }
  if (!sel && !asked) throw new AgentError('Select a GitHub branch; default fallback is disabled.', 400, 'branch_required')
  // An explicitly named agent2/* working branch (CI check / delete / workflow on that branch) is the only allowed deviation.
  if (opts.allowWorking && asked && asked !== sel && isWorkingBranch(asked)) return { strict, branch: asked, pins: uniq([p.branch_sha]), working: true }
  if (sel && asked && asked !== sel) throw new AgentError(`Branch override blocked: the request asked for "${asked}" but the owner selected "${sel}".`, 409, 'branch_override')
  return { strict, branch: sel || asked, pins: uniq([p.selected_branch_sha, own]), working: false }
}
export function assertPins(actual: string, pins: string[], what: string) {
  for (const pin of pins) if (pin !== actual.toLowerCase()) throw new AgentError(`${what} moved since it was selected (now ${actual.slice(0, 7)}). Refresh the branch and retry; nothing was written.`, 409, 'base_changed')
}
// Approvals record their own base. A dashboard request whose selection differs from that recorded base is refused, never silently re-based.
export function assertSelectionMatches(p: any, recordedBase: unknown, what: string) {
  if (!isStrict(p)) return
  const sel = p.selected_branch ? String(p.selected_branch) : ''
  if (!sel) throw new AgentError('Select a GitHub branch; default fallback is disabled.', 400, 'branch_required')
  if (recordedBase && String(recordedBase) !== sel) throw new AgentError(`${what} is bound to base branch "${recordedBase}" but "${sel}" is selected. Select "${recordedBase}" to continue; the base is never switched silently.`, 409, 'base_mismatch')
}
// Visible Base vs Working summary attached to every dashboard result.
export function scopeSummary(p: any, r: any) {
  const sel = p.selected_branch ? String(p.selected_branch) : ''
  const base = String(r.base_branch || sel || p.base || p.ref || '') || null
  const baseSha = r.base_sha || (base && base === r.ref ? r.branch_sha : undefined) || (base && base === sel ? p.selected_branch_sha : undefined) || null
  const working = r.working_branch || (isWorkingBranch(r.branch) ? r.branch : null) || (isWorkingBranch(r.revert_branch) ? r.revert_branch : null) || null
  const ci = r.ci_target_branch || (typeof r.branch === 'string' && r.branch ? r.branch : null) || (r.overall !== undefined ? base : null)
  return { repo: r.repo || p.repo || null, base_branch: base, base_sha: baseSha ? String(baseSha) : null, working_branch: working, commit_destination: r.commit_destination || working || null, ci_target_branch: ci }
}

// ---------------------------------------------------------------- read actions
async function repoInspect(ctx: Ctx, p: any): Promise<Out> {
  const repo = validRepo(p.repo)
  const gh = new GitHub(ctx.cfg, ctx.calls)
  const sc = scopeOf(p, 'ref')
  const info = await gh.info(repo)
  const ref = sc.branch || info.default_branch // default only for legacy (non-dashboard) callers; scopeOf throws for strict ones
  const sha = await gh.branchSha(repo, ref)
  if (!sha) throw new AgentError('Branch not found: ' + ref, 404, sc.strict ? 'branch_not_found' : 'not_found')
  assertPins(sha, sc.pins, 'Selected branch')
  const tree = await gh.tree(repo, await gh.commitTreeSha(repo, sha))
  const path = p.path ? validatePath(p.path) : ''
  if (path) {
    const hit = tree.find(e => e.path === path)
    if (hit) {
      const text = await gh.blobText(repo, hit.sha, 1_000_000)
      return { result: { repo, ref, base_branch: ref, base_sha: sha, branch_sha: sha, path, bytes: Buffer.byteLength(text), content: text.slice(0, READ_LIMIT), truncated: text.length > READ_LIMIT } }
    }
    const children = tree.filter(e => e.path.startsWith(path + '/')).map(e => e.path).slice(0, 200)
    if (!children.length) throw new AgentError('Path not found: ' + path, 404, 'not_found')
    return { result: { repo, ref, base_branch: ref, base_sha: sha, branch_sha: sha, path, files: children } }
  }
  const top = new Map<string, number>()
  for (const e of tree) { const t = e.path.split('/')[0]; top.set(e.path.includes('/') ? t + '/' : t, (top.get(e.path.includes('/') ? t + '/' : t) || 0) + 1) }
  const recent = await gh.recentCommits(repo, sc.strict ? sha : ref, 5) // strict: commits of the pinned SHA of the selected branch
  if (sc.strict) assertPins((await gh.branchSha(repo, ref)) || '', [sha.toLowerCase()], 'Selected branch') // moved while reading
  return { result: { repo, ref, base_branch: ref, base_sha: sha, branch_sha: sha, default_branch: info.default_branch, pushed_at: info.pushed_at, file_count: tree.length, top_level: [...top.entries()].map(([name, files]) => ({ name, files })).slice(0, 80), recent_commits: recent } }
}

export async function monitor(ctx: Ctx, repo: string, branch?: string, pinSha?: string) {
  const gh = new GitHub(ctx.cfg, ctx.calls)
  // Branch existence + SHA pinning is enforced whenever the caller carries a selected-branch context (pinSha).
  const pinned = branch && pinSha ? await gh.branchSha(repo, branch) : null
  if (branch && pinSha && !pinned) throw new AgentError('Selected branch no longer exists: ' + branch, 404, 'branch_not_found')
  const runs = await gh.runs(repo, branch, 5)
  if (branch && pinSha && pinned && (await gh.branchSha(repo, branch)) !== pinned) throw new AgentError('Selected branch moved during GitHub checks. Refresh and retry.', 409, 'base_changed')
  const latest = runs[0]
  const overall = !latest ? 'none' : latest.status !== 'completed' ? 'running' : latest.conclusion === 'success' ? 'passing' : 'failing'
  const failed: any[] = latest && latest.conclusion === 'failure' ? await gh.failedJobs(repo, latest.id).catch(() => []) : []
  // Only when CI failed: attach the real error log of each failed job (max 3). Passing CI carries no log at all.
  for (const j of failed.slice(0, 3)) {
    const raw = j.job_id ? await gh.jobLog(repo, j.job_id) : ''
    const log = redactString(extractFailedLog(raw), secretValues(ctx.cfg))
    j.log = log || 'GitHub did not give the log for this job (it may have expired, or the token lacks Actions: Read). Open the run on GitHub.'
  }
  const deployments = branch ? await gh.deployments(repo, branch).catch(() => []) : []
  return { repo, branch: branch || null, branch_sha: pinned, ci_target_branch: branch || null, overall, runs, failed_jobs: failed, deployments }
}

async function actionsStatus(ctx: Ctx, p: any): Promise<Out> {
  const repo = validRepo(p.repo)
  // CI runs are filtered by the selected branch (or by an explicit agent2/* working branch). Strict requests are never unfiltered.
  const sc = scopeOf(p, 'branch', { allowWorking: true })
  const branch = sc.branch || undefined
  let pin: string | undefined
  if (branch && (sc.strict || sc.pins.length)) {
    const sha = await new GitHub(ctx.cfg, ctx.calls).branchSha(repo, branch)
    if (!sha) throw new AgentError('Selected branch no longer exists: ' + branch, 404, 'branch_not_found')
    assertPins(sha, sc.pins, 'Selected branch')
    pin = sha
  }
  return { result: await monitor(ctx, repo, branch, pin) }
}

// ---------------------------------------------------------------- propose (nothing is written to GitHub)
export async function proposeChange(ctx: Ctx, p: any, fix?: { explanation: string; dev_report?: unknown }): Promise<any> {
  const gh = new GitHub(ctx.cfg, ctx.calls)
  const repo = gh.repo(validRepo(p.repo))
  const title = String(p.title || '').trim().slice(0, 120)
  if (!title) throw new AgentError('title is required', 400)
  const description = String(p.description || '').slice(0, 1000)
  const files: FileIn[] = validateFiles(p.files, { ...LIMITS, maxFiles: Math.max(LIMITS.maxFiles, devLimits().maxChangeFiles) })
  scopeOf(p, 'base') // strict requests without a base fail BEFORE any task is created
  const cont = p.continue_branch ? String(p.continue_branch) : '' // optional: append one commit to this EXISTING agent2/* branch instead of creating a new one
  if (cont) assertAgentBranch(cont, ctx.cfg.protectedBranches)
  return withTask(ctx, 'propose_change', 'Propose: ' + title, { repo, files }, async taskId => {
    const sc = scopeOf(p, 'base')
    const info = await gh.info(repo)
    const base = sc.branch || info.default_branch // default only for legacy callers (Orchestrator ZIP pins base + SHA itself)
    const baseSha = await gh.branchSha(repo, base)
    if (!baseSha) throw new AgentError('Base branch not found: ' + base, 404, sc.strict ? 'branch_not_found' : 'not_found')
    assertPins(baseSha, sc.pins.filter(x => x !== String(p.expected_base_sha || '').toLowerCase()), 'Base branch')
    // Optional owner/Orchestrator pin (ZIP deployments): refuse to build a proposal against a base that has moved.
    if (p.expected_base_sha !== undefined && (!/^[a-f0-9]{40}$/i.test(String(p.expected_base_sha)) || String(p.expected_base_sha).toLowerCase() !== baseSha.toLowerCase()))
      throw new AgentError(`Base branch ${base} moved since the ZIP was checked (now ${baseSha.slice(0, 7)}). Nothing was proposed; upload again.`, 409, 'base_changed')
    // Append mode: the diff is computed against the CURRENT tip of the branch being continued, and that tip is pinned in the approval.
    let contSha: string | null = null
    if (cont) {
      contSha = await gh.branchSha(repo, cont)
      if (!contSha) throw new AgentError('Branch to continue on not found: ' + cont + '. Nothing was proposed.', 404, 'branch_not_found')
      if (p.expected_continue_sha !== undefined && String(p.expected_continue_sha).toLowerCase() !== contSha.toLowerCase())
        throw new AgentError(`Branch ${cont} moved since it was analysed (now ${contSha.slice(0, 7)}). Nothing was proposed; run the request again.`, 409, 'base_changed')
    }
    const tree = await gh.tree(repo, await gh.commitTreeSha(repo, contSha || baseSha))
    const byPath = new Map(tree.map(e => [e.path, e]))
    const entries: any[] = []
    const warnings: string[] = []
    const previews: any[] = []
    for (const f of files) {
      const ex = byPath.get(f.path)
      if (ex && ex.mode !== '100644' && ex.mode !== '100755') throw new AgentError('Not a regular file: ' + f.path, 400, 'bad_path')
      if (f.op === 'create' && ex) throw new AgentError(`${f.path} already exists. Use op "update" so nothing is overwritten by accident.`, 409, 'exists')
      if (f.op !== 'create' && !ex) throw new AgentError(`${f.path} does not exist in ${cont || base}`, 404, 'not_found')
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
    // Compact digest for Gemini: paths, operation, type, +/- counts, bounded hunk, short description, security findings.
    // Never the ZIP, never whole files. Highest-priority files first, so truncation drops the least important hunks.
    const prio = (f: any) => (f.sensitive ? 0 : f.op === 'delete' ? 1 : /(^|\/)(package\.json|vercel\.json|vite\.config\.\w+|\.github\/)/.test(f.path) ? 2 : 3)
    const digestFiles = previews.map((f, i) => ({ ...f, sensitive: entries[i].sensitive })).sort((a, b) => prio(a) - prio(b) || (b.added + b.removed) - (a.added + a.removed))
    const ai = await review(ctx.cfg, {
      title, description, base,
      total_files: previews.length,
      total_added: previews.reduce((n, f) => n + f.added, 0),
      total_removed: previews.reduce((n, f) => n + f.removed, 0),
      total_change_bytes: files.reduce((n, f) => n + Buffer.byteLength(f.content || ''), 0),
      security_summary: { sensitive_paths: sensitive.slice(0, 20), secret_scan: 'passed', deletes: previews.filter(f => f.op === 'delete').map(f => f.path).slice(0, 20) },
      files: digestFiles.map(({ sensitive: sens, ...f }) => ({
        ...f,
        file_type: f.path.includes('.') ? f.path.split('.').pop() : 'text',
        short_description: `${f.op} ${f.path} (+${f.added} -${f.removed})`,
        security_findings: sens ? ['sensitive path: requires additional owner confirmation'] : ['secret scan passed']
      }))
    })
    if (ai.error && ai.text) warnings.push(ai.error)
    await recordAi(ctx, 'propose_change_review', ai)
    const branch = cont || branchFor(title)
    assertAgentBranch(branch, ctx.cfg.protectedBranches)
    const append = Boolean(cont)
    const ap = await ctx.store.createApproval({
      task_id: taskId, title: `Code change: ${title}`,
      details: { kind: 'code_change', repo, title, description, base_branch: base, base_sha: baseSha, selected_branch: sc.strict ? base : null, branch, working_branch: branch, commit_destination: branch, ci_target_branch: branch, files: entries, sensitive_paths: sensitive, warnings, ai_review: ai.text, ai_usage: { model: ai.model, tokens_in: ai.tokensIn, tokens_out: ai.tokensOut, input_chars: ai.inputChars ?? null, partial: Boolean(ai.partial), omitted: ai.omitted || null }, ai_fix: fix ? fix.explanation.slice(0, 500) : undefined, dev_report: fix ? fix.dev_report : undefined, production: false, mode: append ? 'append' : 'new_branch', parent_sha: contSha, note: append ? `Adds ONE commit to the existing branch ${branch} (tip ${String(contSha).slice(0, 7)}). No new branch is created. ${base} is not touched.` : `Creates branch ${branch} from ${base}@${baseSha.slice(0, 7)} with one commit. ${base} is not touched.` }
    })
    await ctx.store.log('warn', 'agent2_approval_requested', 'Code change: ' + title, { approval_id: ap.id }, taskId, ctx.actor.id)
    return { status: 'awaiting_approval', result: { approval_id: ap.id, repo, branch, working_branch: branch, commit_destination: branch, ci_target_branch: branch, base_branch: base, mode: append ? 'append' : 'new_branch', parent_sha: contSha, base: append ? `${branch}@${String(contSha).slice(0, 7)} (existing branch; selected base ${base}@${baseSha.slice(0, 7)})` : `${base}@${baseSha.slice(0, 7)}`, changed_files: entries.map(({ path, op, added, removed, sensitive: s }) => ({ path, op, added, removed, sensitive: s })), warnings, ai_review: ai.text, ai_note: ai.text ? undefined : ai.error, ai_usage: { model: ai.model, tokens_in: ai.tokensIn, tokens_out: ai.tokensOut, input_chars: ai.inputChars ?? null, partial: Boolean(ai.partial), omitted: ai.omitted || null, estimated_cost_usd: Number(((ai.tokensIn * ctx.cfg.priceIn + ai.tokensOut * ctx.cfg.priceOut) / 1_000_000).toFixed(6)) }, base_sha: baseSha, next: (append ? 'Approve in the Approvals tab, then press "Create branch & commit" in the Agent 2 console. It adds ONE commit to the existing branch ' + branch + ' (no new branch).' : 'Approve in the Approvals tab, then press "Create branch & commit" in the Agent 2 console.') + (sensitive.length ? ' Sensitive files need the extra confirmation tick.' : '') } }
  })
}

async function aiFix(ctx: Ctx, p: any): Promise<any> {
  const gh = new GitHub(ctx.cfg, ctx.calls)
  const repo = gh.repo(validRepo(p.repo))
  const problem = String(p.problem || '').trim().slice(0, 2000)
  const paths: string[] = (Array.isArray(p.paths) ? p.paths : []).slice(0, devLimits().maxContextFiles).map(validatePath)
  if (!problem || !paths.length) throw new AgentError('problem and paths[] (max ' + devLimits().maxContextFiles + ') are required', 400)
  const sc = scopeOf(p, 'base')
  const info = await gh.info(repo)
  const base = sc.branch || info.default_branch
  const sha = await gh.branchSha(repo, base)
  if (!sha) throw new AgentError('Base branch not found: ' + base, 404, sc.strict ? 'branch_not_found' : 'not_found')
  assertPins(sha, sc.pins, 'Selected base branch')
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
  return proposeChange(ctx, { repo, base, expected_base_sha: sha, ...(sc.strict ? { branch_context_required: true, selected_branch: base, selected_branch_sha: sha } : {}), title: String(p.title || 'Fix: ' + problem).slice(0, 100), description: problem, files: out.map((f: any) => ({ path: f.path, op: 'update', content: f.content })) }, { explanation: String(parsed.explanation || '') })
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
  assertSelectionMatches(p, d.base_branch, 'This approval')
  return withTask(ctx, 'apply_change', 'Apply: ' + ap.title, { approval_id: ap.id, branch: d.branch }, async () => {
    const gh = new GitHub(ctx.cfg, ctx.calls)
    // Approval is bound to repo + base branch + base SHA. If the base moved or vanished, nothing is claimed or written.
    // Append mode (continue on an existing agent2/* branch): the pinned thing is that branch's tip, and it must still be exactly what was analysed.
    const append = d.mode === 'append'
    const parentSha: string = append ? String(d.parent_sha || '') : String(d.base_sha)
    if (append) {
      const tip = await gh.branchSha(d.repo, d.branch)
      if (!parentSha || !tip || tip.toLowerCase() !== parentSha.toLowerCase()) throw new AgentError(`Branch ${d.branch} changed or was deleted after approval. Nothing was written. Request a fresh analysis and approval.`, 409, 'base_changed')
    } else {
      const currentBaseSha = await gh.branchSha(d.repo, d.base_branch)
      if (!currentBaseSha || currentBaseSha.toLowerCase() !== String(d.base_sha).toLowerCase()) throw new AgentError('Base branch changed or was deleted after approval. Request a fresh analysis and approval.', 409, 'base_changed')
    }
    await claim(ctx, ap, d)
    let created = false
    try {
      if (!append) { await gh.createBranch(d.repo, d.branch, d.base_sha); created = true } // append never creates or deletes a branch: commit() is a fast-forward only
      const commitSha = await gh.commit(d.repo, d.branch, parentSha, `${d.title}\n\nAgent 2 change ${ap.id}`, files)
      await ctx.store.patchApproval(ap.id, { details: { ...d, executed_at: now(), executed_by: ctx.actor.id, commit_sha: commitSha } })
      if (ap.task_id) await ctx.store.updateTask(ap.task_id, { status: 'succeeded', finished_at: now(), result: { applied: true, branch: d.branch, commit_sha: commitSha } })
      await ctx.store.log('success', 'agent2_branch_pushed', `${d.repo} ${d.branch}`, { approval_id: ap.id, commit: commitSha }, null, ctx.actor.id)
      const mon = await monitor(ctx, d.repo, d.branch).catch(() => null)
      return { result: { applied: true, repo: d.repo, branch: d.branch, working_branch: d.branch, ci_target_branch: d.branch, commit_destination: d.branch, base_branch: d.base_branch, base_sha: d.base_sha, mode: append ? 'append' : 'new_branch', parent_sha: parentSha, commit_sha: commitSha, base: append ? `${d.branch}@${parentSha.slice(0, 7)} (existing branch continued)` : `${d.base_branch}@${String(d.base_sha).slice(0, 7)}`, changed_files: d.files.map((e: any) => ({ path: e.path, op: e.op, added: e.added, removed: e.removed })), compare_url: `https://github.com/${d.repo}/compare/${d.base_branch}...${d.branch}`, ci_runs: mon ? mon.runs : [], deployments: mon ? mon.deployments : [], deployment_trigger: mon && (mon.runs.length || mon.deployments.length) ? 'triggered (see ci_runs / deployments)' : 'not seen yet; open Monitor in about a minute', production_touched: false, rollback: append ? 'This commit was added to an existing branch. Request rollback would delete the WHOLE branch (including earlier commits); to undo only this commit use GitHub revert. ' + d.base_branch + ' was never touched.' : 'Request rollback deletes this branch; ' + d.base_branch + ' was never touched.' } }
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
  const sc = isStrict(p) ? scopeOf(p, 'base') : null // dashboard: the owner's selected base must exist; nothing defaults to main
  return withTask(ctx, 'request_promote', `Promote ${branch} to production`, { repo, branch }, async taskId => {
    const info = await gh.info(repo)
    const headSha = await gh.branchSha(repo, branch)
    if (!headSha) throw new AgentError('Branch not found: ' + branch, 404, 'not_found')
    const mon = await monitor(ctx, repo, branch)
    // Merge target = the base branch this working branch was created from (recorded in its approved change),
    // else the owner's explicitly selected base. The repo default is used only when nothing else is known.
    const recorded = (await ctx.store.findApprovals('code_change', branch)).find(a => a.details && a.details.executed_at && a.details.repo === repo)
    if (sc && recorded) assertSelectionMatches(p, recorded.details.base_branch, 'This working branch')
    const baseBranch = String((recorded && recorded.details.base_branch) || (sc && sc.branch) || p.base || info.default_branch) // default: legacy callers only
    const baseNow = await gh.branchSha(repo, baseBranch)
    if (!baseNow) throw new AgentError('Merge target branch not found: ' + baseBranch, 404, 'branch_not_found')
    if (sc && baseBranch === sc.branch) assertPins(baseNow, sc.pins, 'Merge target branch')
    const production = baseBranch === info.default_branch || isProtected(baseBranch, ctx.cfg.protectedBranches)
    const title = `Promote ${branch} -> ${baseBranch}${production ? ' - PRODUCTION' : ''}`
    const ap = await ctx.store.createApproval({ task_id: taskId, title, details: { kind: 'promote', repo, branch, base_branch: baseBranch, base_sha: baseNow, head_sha: headSha, production, ci: mon.overall, ci_runs: mon.runs.slice(0, 3), note: 'Opens a pull request and squash-merges it. Merge is pinned to head_sha: if the branch changes after approval, nothing is merged.' } })
    await ctx.store.log('warn', 'agent2_approval_requested', title, { approval_id: ap.id }, taskId, ctx.actor.id)
    return { status: 'awaiting_approval', result: { approval_id: ap.id, repo, branch, working_branch: branch, base_branch: baseBranch, base_sha: baseNow, ci_target_branch: branch, production, ci: mon.overall, next: 'Approve in the Approvals tab, then press Merge in the Agent 2 console' + (production ? ' (needs the PRODUCTION tick).' : '.') } }
  })
}

async function applyPromote(ctx: Ctx, p: any): Promise<any> {
  const { ap, d } = await loadApproved(ctx, p.approval_id, 'promote')
  if (d.production && p.production_ack !== 'APPROVE-PRODUCTION') throw new AgentError('Production merge needs explicit confirmation (production_ack)', 403, 'production_ack')
  assertAgentBranch(d.branch, ctx.cfg.protectedBranches)
  assertSelectionMatches(p, d.base_branch, 'This approval')
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
      return { result: { merged: true, repo: d.repo, branch: d.branch, working_branch: d.branch, base_branch: d.base_branch, pr_url: pr.url, merge_sha: mergeSha, base_before_sha: baseBefore, production: d.production, deployment_trigger: 'Merging to ' + d.base_branch + ' triggers your Vercel production deploy. Check Agent 1 > Vercel status.', rollback: 'Request rollback creates a revert pull request.' } }
    } catch (e) { await release(ctx, ap, d, e); throw e }
  })
}

// ---------------------------------------------------------------- rollback
async function requestRollback(ctx: Ctx, p: any): Promise<any> {
  const gh = new GitHub(ctx.cfg, ctx.calls)
  const repo = gh.repo(validRepo(p.repo))
  const branch = String(p.branch || '')
  assertAgentBranch(branch, ctx.cfg.protectedBranches)
  if (isStrict(p)) scopeOf(p, 'base') // dashboard request needs the owner's selection (the delete itself only ever targets this agent2/* branch)
  return withTask(ctx, 'request_rollback', `Rollback ${branch}`, { repo, branch }, async taskId => {
    const changes = (await ctx.store.findApprovals('code_change', branch)).filter(a => a.details && a.details.executed_at && a.details.repo === repo)
    const promotes = (await ctx.store.findApprovals('promote', branch)).filter(a => a.details && a.details.merge_sha && a.details.repo === repo)
    const change = changes[0]
    let details: any
    if (promotes.length) {
      if (!change) throw new AgentError('This branch was merged but was not created by an Agent 2 API change. Use `git revert` in Termux (needs approval).', 409, 'no_record')
      const c = change.details
      assertSelectionMatches(p, c.base_branch, 'This rollback')
      details = { kind: 'rollback', mode: 'revert_pr', repo, branch, merge_sha: promotes[0].details.merge_sha, base_branch: c.base_branch, files: c.files.map((f: any) => ({ path: f.path, op: f.op, mode: f.mode, old_sha: f.old_sha, new_sha: f.new_sha })), production: true, note: 'Creates a revert branch and opens a pull request restoring ONLY the files this change touched. Nothing is merged automatically.' }
    } else {
      const head = await gh.branchSha(repo, branch)
      if (!head) throw new AgentError('Branch not found (already removed?): ' + branch, 404, 'not_found')
      details = { kind: 'rollback', mode: 'delete_branch', repo, branch, expected_head: head, production: false, note: 'Deletes the unmerged branch. Its commits stay recoverable on GitHub for a while via the SHA ' + head.slice(0, 7) + '.' }
    }
    const title = `Rollback ${branch} (${details.mode})`
    const ap = await ctx.store.createApproval({ task_id: taskId, title, details })
    await ctx.store.log('warn', 'agent2_approval_requested', title, { approval_id: ap.id }, taskId, ctx.actor.id)
    return { status: 'awaiting_approval', result: { approval_id: ap.id, repo, branch, working_branch: branch, base_branch: details.base_branch || null, mode: details.mode, next: 'Approve in the Approvals tab, then press Rollback in the Agent 2 console.' } }
  })
}

async function applyRollback(ctx: Ctx, p: any): Promise<any> {
  const { ap, d } = await loadApproved(ctx, p.approval_id, 'rollback')
  if (d.production && p.production_ack !== 'APPROVE-PRODUCTION') throw new AgentError('Rollback of merged code needs explicit confirmation (production_ack)', 403, 'production_ack')
  assertAgentBranch(d.branch, ctx.cfg.protectedBranches)
  assertSelectionMatches(p, d.base_branch, 'This approval') // delete_branch mode records no base: only the agent2/* branch is touched
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
  const sc = scopeOf(p, 'ref', { allowWorking: true }) // selected base, or an explicitly named agent2/* working branch
  return withTask(ctx, 'request_workflow', 'Run workflow ' + wanted, { repo, workflow: wanted }, async taskId => {
    const info = await gh.info(repo)
    const ref = sc.branch || info.default_branch // default only for legacy callers
    if (!/^[\w./-]{1,100}$/.test(ref) || ref.includes('..')) throw new AgentError('Bad branch name', 400)
    const head = await gh.branchSha(repo, ref)
    if (!head) throw new AgentError('Branch not found: ' + ref, 404, sc.strict ? 'branch_not_found' : 'not_found')
    assertPins(head, sc.pins, 'Selected branch')
    const all = await gh.workflows(repo)
    const file = (w: { path: string }) => w.path.split('/').pop()!.toLowerCase()
    let hits = all.filter(w => file(w) === wanted || w.name.toLowerCase() === wanted || String(w.id) === wanted)
    if (!hits.length) hits = all.filter(w => file(w).includes(wanted) || w.name.toLowerCase().includes(wanted))
    if (hits.length !== 1) throw new AgentError((hits.length ? 'More than one workflow matches: ' : 'Workflow not found. Available: ') + (hits.length ? hits : all).map(w => file(w)).join(', '), 404, 'not_found')
    const wf = hits[0]
    if (wf.state !== 'active') throw new AgentError('Workflow is not active: ' + file(wf), 409, 'workflow_inactive')
    const production = isProtected(ref, ctx.cfg.protectedBranches)
    const details = { kind: 'workflow_run', repo, workflow_id: wf.id, workflow_path: wf.path, workflow_name: wf.name, ref, base_branch: sc.working ? null : ref, working_branch: sc.working ? ref : null, expected_head: head, production, note: 'Starts this workflow by hand on ' + ref + '. It runs the code already in that branch. Nothing is changed in GitHub except the new run.' }
    const title = `Run workflow ${file(wf)} on ${ref}`
    const ap = await ctx.store.createApproval({ task_id: taskId, title, details })
    await ctx.store.log('warn', 'agent2_approval_requested', title, { approval_id: ap.id }, taskId, ctx.actor.id)
    return { status: 'awaiting_approval', result: { approval_id: ap.id, repo, workflow: wf.path, ref, base_branch: sc.working ? null : ref, base_sha: sc.working ? null : head, working_branch: sc.working ? ref : null, ci_target_branch: ref, production, next: 'Approve in the Approvals tab, then press Run workflow in the Agent 2 console.' } }
  })
}

async function applyWorkflow(ctx: Ctx, p: any): Promise<any> {
  const { ap, d } = await loadApproved(ctx, p.approval_id, 'workflow_run')
  if (d.production && p.production_ack !== 'APPROVE-PRODUCTION') throw new AgentError('Running a workflow on a protected branch needs explicit confirmation (production_ack)', 403, 'production_ack')
  assertSelectionMatches(p, isWorkingBranch(d.ref) ? null : d.ref, 'This approval') // workflow on an agent2/* branch is bound to that branch by expected_head
  return withTask(ctx, 'apply_workflow', 'Apply: ' + ap.title, { approval_id: ap.id }, async () => {
    const gh = new GitHub(ctx.cfg, ctx.calls)
    await claim(ctx, ap, d)
    try {
      const head = await gh.branchSha(d.repo, d.ref)
      if (!head) throw new AgentError('Branch not found: ' + d.ref, 404, 'not_found')
      if (head !== d.expected_head) throw new AgentError('Branch has new commits since the request; request again', 409, 'head_moved')
      await gh.dispatchWorkflow(d.repo, d.workflow_id, d.ref)
      await ctx.store.log('success', 'agent2_workflow_started', `${d.repo} ${d.workflow_path} on ${d.ref}`, { approval_id: ap.id }, null, ctx.actor.id)
      return { result: { started: true, repo: d.repo, workflow: d.workflow_path, branch: d.ref, ci_target_branch: d.ref, next: 'Press GitHub Actions (Inspect & monitor) in a minute to see the result.' } }
    } catch (e) { await release(ctx, ap, d, e); throw e }
  })
}

// ---------------------------------------------------------------- free-text command (AI picks ONE allowed action; code validates everything)
async function aiCommand(ctx: Ctx, p: any): Promise<any> {
  const gh = new GitHub(ctx.cfg, ctx.calls)
  const repo = gh.repo(validRepo(p.repo))
  const text = String(p.text || '').trim().slice(0, 1000)
  if (!text) throw new AgentError('Write what you want Agent 2 to do', 400)
  // BRANCH RULE for the Quick command: the owner's dropdown selection (selected base + SHA) is injected into EVERY GitHub sub-call below.
  // The model may only choose WHAT to do. It can never choose WHICH base: a branch it names is honoured solely when it is an existing
  // agent2/* working branch that the owner's own text also names (CI check / delete / workflow on that working branch).
  const sel = scopeOf(p, 'base') // dashboard: selected base is mandatory (400 branch_required) - nothing defaults to main/master
  const selBase = sel.branch || undefined
  const selCtx = sel.strict ? { branch_context_required: true, selected_branch: selBase, selected_branch_sha: p.selected_branch_sha, ref: selBase, base: selBase, branch: selBase, branch_sha: p.selected_branch_sha, expected_base_sha: p.selected_branch_sha } : {}
  const branches = await gh.agentBranches(repo)
  const r = await planCommand(ctx.cfg, { request: text, agent_branches: branches.slice(0, 50) })
  await recordAi(ctx, 'ai_command', r)
  if (!r.text) throw new AgentError('Gemini could not read the request: ' + (r.error || 'no answer'), 502, 'ai_unavailable')
  let plan: any
  try { const a = r.text.indexOf('{'), b = r.text.lastIndexOf('}'); plan = JSON.parse(r.text.slice(a, b + 1)) } catch { throw new AgentError('Gemini answer was not valid JSON. Try again in simpler words.', 502, 'ai_bad_output') }
  const INTENTS = ['check_ci', 'list_branches', 'inspect', 'delete_branch', 'run_workflow', 'fix_code']
  const intent = INTENTS.includes(String(plan && plan.intent)) ? String(plan.intent) : 'unsupported'
  const understood = { intent, explanation: String((plan && plan.explanation) || '').slice(0, 300) }
  const safeRef = (v: unknown) => (typeof v === 'string' && /^[\w./-]{1,100}$/.test(v) && !v.includes('..') ? v : undefined)
  // Working branch the owner explicitly named (must exist under agent2/* AND appear in the owner's text); otherwise undefined.
  const ownerNamed = (v: unknown) => { const b = safeRef(v); return b && isWorkingBranch(b) && branches.includes(b) && text.includes(b) ? b : undefined }
  let out: any
  switch (intent) {
    case 'check_ci': {
      const working = ownerNamed(plan.branch)
      const params = working ? { ...selCtx, repo, branch: working, branch_sha: undefined } : { ...selCtx, repo, branch: selBase ?? safeRef(plan.branch) } // legacy (no selection) keeps the model's optional branch
      out = await withTask(ctx, 'actions_status', 'GitHub Actions status ' + repo, { repo, branch: params.branch || null }, () => actionsStatus(ctx, params)); break
    }
    case 'list_branches': out = await withTask(ctx, 'list_branches', 'List agent2 branches ' + repo, { repo }, async () => ({ result: { repo, branches, count: branches.length } })); break
    case 'inspect': out = await withTask(ctx, 'repo_inspect', 'Inspect repo ' + repo, { repo }, () => repoInspect(ctx, { ...selCtx, repo, path: typeof plan.path === 'string' ? plan.path : undefined, ref: selBase ?? safeRef(plan.ref) })); break
    case 'delete_branch': {
      const branch = String(plan.branch || '')
      if (!branches.includes(branch)) throw new AgentError('That branch is not one of the agent2/* branches: ' + (branches.join(', ') || 'none exist'), 404, 'not_found')
      out = await requestRollback(ctx, { ...selCtx, repo, branch, branch_sha: undefined }); break
    }
    case 'run_workflow': { const working = ownerNamed(plan.ref); out = await requestWorkflow(ctx, working ? { ...selCtx, repo, workflow: plan.workflow, ref: working, branch_sha: undefined } : { ...selCtx, repo, workflow: plan.workflow, ref: selBase ?? safeRef(plan.ref) }); break }
    case 'fix_code': out = await aiFix(ctx, { ...selCtx, repo, paths: Array.isArray(plan.paths) ? plan.paths.map(String) : [], problem: String(plan.problem || text) }); break
    default:
      await ctx.store.log('warn', 'agent2_command_unsupported', understood.explanation || 'unsupported request', {}, null, ctx.actor.id)
      return { status: 'succeeded', result: { unsupported: true, message: understood.explanation || 'This request is not something Agent 2 can do safely.' }, understood }
  }
  return { ...out, understood }
}

export async function runAction(ctx: Ctx, action: string, params: any = {}): Promise<any> {
  if (!(ACTIONS as readonly string[]).includes(action)) throw new AgentError('Unknown action', 400, 'unknown_action')
  // Every dashboard-triggered action that reads or writes GitHub must carry the owner's branch selection.
  if (params.branch_context_required && GITHUB_SCOPED.includes(action) && !params.selected_branch && !params.branch && !params.ref && !params.base) throw new AgentError('Select a GitHub branch; default fallback is disabled.', 400, 'branch_required')
  const out = await dispatch(ctx, action, params)
  // Dashboard calls also get a visible Base vs Working summary so it never looks like the agent picked another branch.
  if (params.branch_context_required && GITHUB_SCOPED.includes(action) && out && out.result && typeof out.result === 'object' && !Array.isArray(out.result)) out.result.scope = scopeSummary(params, out.result)
  return out
}

export const GITHUB_SCOPED = ['repo_inspect', 'actions_status', 'propose_change', 'ai_fix', 'request_workflow', 'dev_chat', 'dev_assist', 'dev_proposal', 'dev_diagnose', 'ai_command', 'request_promote', 'request_rollback', 'apply_change', 'apply_promote', 'apply_rollback', 'apply_workflow']

async function dispatch(ctx: Ctx, action: string, params: any): Promise<any> {
  switch (action as Action) {
    case 'heartbeat': {
      const agent = await ctx.store.heartbeat()
      return { agent: { id: agent.id, name: agent.name, status: agent.status, last_heartbeat_at: agent.last_heartbeat_at }, ready: readiness(ctx.cfg), repos: ctx.cfg.githubRepos, protected_branches: ctx.cfg.protectedBranches, model: ctx.cfg.geminiModel }
    }
    case 'github_branches': { const gh = new GitHub(ctx.cfg, ctx.calls); const repo = gh.repo(validRepo(params.repo)); return { result: { repo, branches: await gh.branches(repo) } } }
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
    case 'dev_chat': case 'dev_assist': case 'dev_proposal': case 'dev_diagnose': return runDev(ctx, action, params)
  }
}

export { loadConfig }
