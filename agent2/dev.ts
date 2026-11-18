import { devLimits, secretValues, type DevLimits } from './config.js'
import { AgentError, redactString } from './util.js'
import { GitHub } from './github.js'
import { assist, chatAi, codegen, devReview, planDev, type AiResult } from './gemini.js'
import { LIMITS, scanSecrets, validateFiles, validatePath, validRepo, type FileIn } from './guard.js'
import { proposeChange, recordAi, monitor, withTask, scopeOf, assertPins, isStrict, type Ctx, type Out } from './agent.js'

// Professional developer layer. Everything here only READS GitHub and ASKS the model; the only write path is the existing
// propose_change -> Approvals -> apply_change pipeline, so every security guard (protected branches, secret scan, content hash,
// sensitive-file ack, agent2/* only) applies unchanged.
export const DEV_ACTIONS = ['dev_chat', 'dev_assist', 'dev_proposal', 'dev_diagnose'] as const

const parse = (t: string | null): any => { if (!t) return null; try { const a = t.indexOf('{'), b = t.lastIndexOf('}'); return JSON.parse(t.slice(a, b + 1)) } catch { return null } }
const str = (v: unknown, n: number) => String(v ?? '').slice(0, n)
const strs = (v: unknown, n = 12, len = 300) => (Array.isArray(v) ? v : []).map(x => str(x, len)).filter(Boolean).slice(0, n)

// ---------------------------------------------------------------- repository context (read only, bounded)
export interface RepoCtx { repo: string; ref: string; sha: string; tree: { path: string; sha: string }[]; files: { path: string; content: string; redacted?: boolean; truncated?: boolean }[]; omitted: string[] }

// `strict` (dashboard request): the branch is mandatory and the repository default is NEVER used. Only legacy callers may omit it.
async function treeFor(ctx: Ctx, repo: string, ref?: string, expectedSha?: string, strict = false) {
  const gh = new GitHub(ctx.cfg, ctx.calls)
  if (strict && !ref) throw new AgentError('Select a GitHub branch; default fallback is disabled.', 400, 'branch_required')
  const r = ref || (await gh.info(repo)).default_branch // legacy only
  const sha = await gh.branchSha(repo, r)
  if (!sha) throw new AgentError('Branch not found: ' + r, 404, strict ? 'branch_not_found' : 'not_found')
  if (expectedSha && expectedSha.toLowerCase() !== sha.toLowerCase()) throw new AgentError('Selected branch moved. Refresh and re-run analysis.', 409, 'base_changed')
  return { gh, ref: r, tree: await gh.tree(repo, await gh.commitTreeSha(repo, sha)), sha }
}

async function readFiles(gh: GitHub, repo: string, tree: { path: string; sha: string }[], paths: string[], lim: DevLimits, secrets: string[]) {
  const files: RepoCtx['files'] = []
  const omitted: string[] = []
  let bytes = 0
  const want = [...new Set(paths)].slice(0, lim.maxContextFiles)
  for (const p of paths.slice(lim.maxContextFiles)) omitted.push(p + ' (file limit)')
  for (const p of want) {
    let path: string
    try { path = validatePath(p) } catch { omitted.push(p + ' (blocked path)'); continue }
    const e = tree.find(x => x.path === path)
    if (!e) { omitted.push(path + ' (not found)'); continue }
    if (bytes >= lim.maxContextBytes) { omitted.push(path + ' (size budget)'); continue }
    try {
      const raw = await gh.blobText(repo, e.sha, 400_000)
      const text = redactString(raw, secrets)
      const piece = text.slice(0, Math.min(60_000, lim.maxContextBytes - bytes))
      bytes += piece.length
      files.push({ path, content: piece, redacted: text !== raw, truncated: piece.length < text.length })
      if (piece.length < text.length) omitted.push(path + ' (truncated)')
    } catch (er) { omitted.push(path + ' (' + (er as Error).message.slice(0, 60) + ')') }
  }
  return { files, omitted }
}

// Paths the owner mentioned in free text, matched against the real tree (never invented).
export const mentionedPaths = (text: string, tree: { path: string }[]): string[] => {
  const set = new Set(tree.map(t => t.path))
  const hits = (text.match(/[\w@.\-/]+\.[A-Za-z0-9]{1,6}/g) || []).map(s => s.replace(/^\.\//, ''))
  return [...new Set(hits.filter(h => set.has(h)))]
}

// Carries the owner's selection from a dashboard request into a sub-call (chat -> proposal).
const scopeFields = (p: any) => (isStrict(p) ? { branch_context_required: true, selected_branch: p.selected_branch, selected_branch_sha: p.selected_branch_sha, expected_base_sha: p.expected_base_sha } : {})

const KEY = ['package.json', 'README.md', '00-README.md', '01-ARCHITECTURE.md']

async function gather(ctx: Ctx, repo: string, ref: string | undefined, text: string, explicit: string[], expectedSha?: string, strict = false): Promise<RepoCtx & { gh: GitHub }> {
  const lim = devLimits()
  const { gh, ref: r, tree, sha } = await treeFor(ctx, repo, ref, expectedSha, strict)
  const mention = mentionedPaths(text, tree)
  const paths = [...explicit, ...mention, ...(explicit.length || mention.length ? [] : KEY.filter(k => tree.some(t => t.path === k)).slice(0, 2))]
  const { files, omitted } = await readFiles(gh, repo, tree, paths, lim, secretValues(ctx.cfg))
  return { repo, ref: r, sha, tree, files, omitted, gh }
}

const compact = (r: RepoCtx) => ({ ref: r.ref, branch_sha: r.sha, file_count: r.tree.length, file_list: r.tree.map(t => t.path).slice(0, 600), files: r.files, omitted: r.omitted })
const hist = (h: unknown, n: number) => (Array.isArray(h) ? h : []).slice(-n).map((m: any) => ({ role: m && m.role === 'assistant' ? 'assistant' : 'user', text: str(m && m.text, 2000) }))

const needAi = (r: AiResult, what: string) => { if (!r.text) throw new AgentError(`Gemini could not ${what}: ${r.error || 'no answer'}`, 502, 'gemini') }

// ---------------------------------------------------------------- Ask Agent 2 (conversation)
async function devChat(ctx: Ctx, p: any): Promise<any> {
  const message = str(p.message, 4000).trim()
  if (!message) throw new AgentError('Write a message for Agent 2', 400)
  const lim = devLimits()
  let rc: (RepoCtx & { gh: GitHub }) | null = null
  const repo = p.repo ? validRepo(p.repo) : ''
  let context_note: string | undefined
  if (repo) {
    const sc = isStrict(p) ? scopeOf(p, 'ref') : null // dashboard: selected branch is mandatory, overrides are refused
    try { rc = await gather(ctx, repo, sc ? sc.branch : (p.ref ? String(p.ref) : undefined), message, (Array.isArray(p.paths) ? p.paths : []).map(String), sc ? sc.pins[0] : (p.branch_sha ? String(p.branch_sha) : undefined), Boolean(sc)) }
    catch (e) {
      // A selected branch that moved or vanished is a hard error: never answer as if it were analysed, never fall back to another branch.
      if ((sc || p.ref || p.branch_sha) && ['base_changed', 'branch_not_found', 'not_found', 'branch_required'].includes(String((e as any).code))) throw e
      context_note = 'Repository context unavailable: ' + (e as Error).message.slice(0, 160) // general questions still get answered
    }
  }
  const ai = await chatAi(ctx.cfg, { message, history: hist(p.history, lim.historyTurns), repo: rc ? compact(rc) : null, repo_context_note: context_note || null })
  await recordAi(ctx, 'dev_chat', ai)
  needAi(ai, 'answer')
  const j = parse(ai.text)
  // Plain-text model output is still a valid answer; the owner is never blocked by a formatting slip.
  if (!j || typeof j !== 'object') return { status: 'succeeded', mode: 'answer', answer: redactString(String(ai.text), secretValues(ctx.cfg)), context_files: rc ? rc.files.map(f => f.path) : [], context_note }
  const mode = ['answer', 'proposal', 'unsupported'].includes(j.mode) ? j.mode : 'answer'
  const answer = redactString(str(j.answer, 12000), secretValues(ctx.cfg))
  if (mode === 'unsupported') {
    const agent = ['agent1', 'agent3', 'orchestrator'].includes(j.responsible_agent) ? j.responsible_agent : null
    await ctx.store.log('info', 'agent2_chat_unsupported', answer.slice(0, 200), { responsible_agent: agent }, null, ctx.actor.id)
    return { status: 'succeeded', mode, answer, responsible_agent: agent }
  }
  if (mode === 'proposal') {
    if (!repo) return { status: 'succeeded', mode: 'answer', answer: answer + '\n\n(Select a repository to let me prepare a proposal.)', context_note }
    const out = await devProposal(ctx, { ...scopeFields(p), repo, request: str(j.proposal_request || message, 4000), ref: p.ref, base: p.base, branch_sha: p.branch_sha, history: p.history })
    return { ...out, mode: 'proposal', answer }
  }
  return { status: 'succeeded', mode, answer, context_files: rc ? rc.files.map(f => f.path) : [], context_note }
}

// ---------------------------------------------------------------- Explain / Debug / Review / Plan / Docs
async function devAssist(ctx: Ctx, p: any): Promise<any> {
  const kind = ['explain', 'debug', 'review', 'plan', 'docs'].includes(p.kind) ? String(p.kind) : 'explain'
  const text = str(p.text, 6000)
  const paths: string[] = (Array.isArray(p.paths) ? p.paths : []).map(String)
  if (!text.trim() && !paths.length && !p.error_log) throw new AgentError('Give a question, file paths or an error log', 400)
  let rc: (RepoCtx & { gh: GitHub }) | null = null
  if (p.repo) { const sc = isStrict(p) ? scopeOf(p, 'ref') : null; rc = await gather(ctx, validRepo(p.repo), sc ? sc.branch : (p.ref ? String(p.ref) : undefined), text + ' ' + str(p.error_log, 3000), paths, sc ? sc.pins[0] : (p.branch_sha ? String(p.branch_sha) : undefined), Boolean(sc)) }
  const ai = await assist(ctx.cfg, kind, { task: kind, text, error_log: str(p.error_log, 8000), code: str(p.code, 20000), repo: rc ? compact(rc) : null })
  await recordAi(ctx, 'dev_assist_' + kind, ai)
  needAi(ai, kind)
  return { status: 'succeeded', kind, answer: redactString(String(ai.text), secretValues(ctx.cfg)), context_files: rc ? rc.files.map(f => f.path) : [], omitted: rc ? rc.omitted : [] }
}

// ---------------------------------------------------------------- static checks (the ONLY checks that run in API mode)
export interface StaticCheck { name: string; ok: boolean; detail?: string }
export function staticChecks(files: FileIn[]): StaticCheck[] {
  const out: StaticCheck[] = []
  for (const f of files) {
    if (f.op === 'delete') continue
    const c = f.content || ''
    const hits = scanSecrets(c)
    out.push({ name: 'secret-scan:' + f.path, ok: hits.length === 0, detail: hits.slice(0, 3).map(h => `${h.rule} line ${h.line}`).join(', ') || undefined })
    if (/\.json$/i.test(f.path)) { let ok = true, d: string | undefined; try { JSON.parse(c) } catch (e) { ok = false; d = (e as Error).message.slice(0, 120) } out.push({ name: 'json-valid:' + f.path, ok, detail: d }) }
    if (!c.trim()) out.push({ name: 'non-empty:' + f.path, ok: false, detail: 'file is empty' })
  }
  return out
}
// What API mode can NOT verify. Reported verbatim so nobody mistakes "not run" for "passed".
export const NOT_RUN = ['lint', 'type-check', 'unit/integration tests', 'build']
const NOT_RUN_WHY = 'Agent 2 on Vercel has no shell. Run `npm run agent2 -- local-apply` then `checks` / `iterate` in Termux, or read the GitHub Actions result after the branch is committed.'

// ---------------------------------------------------------------- full proposal pipeline
async function devProposal(ctx: Ctx, p: any): Promise<any> {
  const lim = devLimits()
  const repo = validRepo(p.repo)
  const request = str(p.request, 4000).trim()
  if (!request) throw new AgentError('Describe the feature, bug or change you want', 400)
  const kind = ['feature', 'bugfix', 'improvement', 'refactor', 'architecture', 'tests', 'docs'].includes(p.kind) ? String(p.kind) : 'change'
  return withTask(ctx, 'dev_proposal', `Dev proposal (${kind}): ${request.slice(0, 80)}`, { repo, kind, request: request.slice(0, 500) }, async taskId => {
    const stages: { stage: string; at: string; note?: string }[] = []
    const progress = async (stage: string, note?: string) => {
      stages.push({ stage, at: new Date().toISOString(), note })
      await ctx.store.updateTask(taskId, { payload: { action: 'dev_proposal', repo, kind, request: request.slice(0, 500), progress: stages } }).catch(() => {})
    }
    const secrets = secretValues(ctx.cfg)
    // 1-2. understand + inspect
    await progress('inspect', 'reading repository')
    // Strict (dashboard): base = ref = the owner's selected branch pinned by SHA. Legacy callers keep their explicit ref/base.
    const sc = isStrict(p) ? scopeOf(p, 'base') : null
    const rc = await gather(ctx, repo, sc ? sc.branch : (p.ref ? String(p.ref) : undefined), request, (Array.isArray(p.paths) ? p.paths : []).map(String), sc ? undefined : (p.branch_sha ? String(p.branch_sha) : undefined), Boolean(sc))
    if (sc) assertPins(rc.sha, sc.pins, 'Selected base branch')
    else if (p.branch_sha && String(p.branch_sha).toLowerCase() !== rc.sha.toLowerCase()) throw new AgentError('Selected base branch moved since selection. Refresh the branch and run a fresh analysis.', 409, 'base_changed')
    const base = sc ? sc.branch : (String(p.base || p.ref || '') || undefined)
    // 3-4. analyse + plan (pass 1 may ask to read more files, pass 2 sees them)
    await progress('plan', 'analysing existing code and planning')
    let plan = await planOnce(ctx, request, kind, rc, hist(p.history, lim.historyTurns))
    const more = strs(plan.files_to_read, lim.maxContextFiles, 200).filter(x => !rc.files.some(f => f.path === x))
    if (more.length) {
      const extra = await readFiles(rc.gh, repo, rc.tree, more, { ...lim, maxContextFiles: lim.maxContextFiles }, secrets)
      rc.files.push(...extra.files); rc.omitted.push(...extra.omitted)
      plan = await planOnce(ctx, request, kind, rc, hist(p.history, lim.historyTurns))
    }
    const planned = normalisePlan(plan, rc.tree)
    if (!planned.length) throw new AgentError('The plan contains no usable file changes. Describe the task with more detail or name the files.', 422, 'empty_plan')
    if (planned.length > lim.maxChangeFiles) {
      // Never silently drop files: hand the plan back so the owner can split it or raise AGENT2_DEV_MAX_FILES.
      await progress('needs_split', `${planned.length} files > limit ${lim.maxChangeFiles}`)
      return { result: { needs_split: true, message: `The plan needs ${planned.length} files but one proposal is limited to ${lim.maxChangeFiles}. Split the request into phases (or raise AGENT2_DEV_MAX_FILES, max 120).`, plan: planSummary(plan, planned) } }
    }
    // 5-7. generate code in batches, validate, and fix iteratively within the configured number of rounds
    const generated = new Map<string, FileIn>()
    const rounds: { batch: number; round: number; problems: string[] }[] = []
    for (let i = 0; i < planned.length; i += lim.batchSize) {
      const batch = planned.slice(i, i + lim.batchSize)
      const n = Math.floor(i / lim.batchSize) + 1
      await progress('generate', `batch ${n}/${Math.ceil(planned.length / lim.batchSize)} (${batch.length} files)`)
      const current = await currentContents(rc, batch, lim, secrets)
      let feedback: string[] = []
      let ok = false
      for (let round = 0; round <= lim.maxFixRounds && !ok; round++) {
        const out = await genBatch(ctx, request, plan, batch, current, [...generated.keys()], feedback)
        const problems = checkBatch(out, batch, rc)
        rounds.push({ batch: n, round, problems })
        if (!problems.length) { for (const f of out) generated.set(f.path, f); ok = true } else feedback = problems
        if (!ok && round === lim.maxFixRounds) throw new AgentError(`Generated code still failed checks after ${lim.maxFixRounds} fix round(s): ${problems.slice(0, 4).join('; ')}. Nothing was proposed.`, 422, 'generation_failed')
      }
    }
    const files = [...generated.values()]
    // static checks over the whole change set (the only checks that actually ran)
    await progress('static_checks')
    const checks = staticChecks(files)
    const failed = checks.filter(c => !c.ok)
    if (failed.length) throw new AgentError('Static checks failed: ' + failed.slice(0, 4).map(c => c.name + (c.detail ? ' (' + c.detail + ')' : '')).join('; ') + '. Nothing was proposed.', 422, 'static_check_failed')
    // 8. code review of the generated change set
    await progress('review')
    const diffs = files.map(f => ({ path: f.path, op: f.op, lines: (f.content || '').split('\n').length, head: redactString((f.content || '').slice(0, 1200), secrets) }))
    const rv = await devReview(ctx.cfg, { request, plan: planSummary(plan, planned), files: diffs, checks_that_ran: checks.map(c => ({ name: c.name, ok: c.ok })), checks_not_run: NOT_RUN })
    await recordAi(ctx, 'dev_review', rv)
    const review = parse(rv.text) || {}
    // 9. final development report (computed from real data; the AI text only fills explanation fields)
    const report = {
      request: request.slice(0, 500), kind, base: rc.ref,
      summary: str(plan.summary, 600), approach: str(plan.approach, 800), pros_cons: str(plan.pros_cons, 800),
      files: planned.map(f => ({ path: f.path, op: f.op, why: f.why })),
      dependencies: strs(plan.dependencies), breaking_changes: strs(plan.breaking_changes), risks: strs(plan.risks), security: strs(plan.security), tests_planned: strs(plan.tests),
      expected_result: str(plan.expected_result, 500),
      generation: { batches: Math.ceil(planned.length / lim.batchSize), fix_rounds_used: rounds.filter(r => r.round > 0).length, rounds },
      checks: { ran: checks.map(c => ({ name: c.name, ok: c.ok })), all_ran_passed: checks.every(c => c.ok), not_run: NOT_RUN, not_run_reason: NOT_RUN_WHY },
      review: { verdict: review.verdict === 'changes_needed' ? 'changes_needed' : review.verdict === 'approve' ? 'approve' : 'unavailable', summary: str(review.summary, 600), findings: (Array.isArray(review.findings) ? review.findings : []).slice(0, 10).map((f: any) => ({ severity: str(f && f.severity, 8), area: str(f && f.area, 20), text: str(f && f.text, 300) })), missing: strs(review.missing), what_changed: str(review.what_changed, 600), why: str(review.why, 600) },
      remaining: ['Lint, type-check, tests and build have NOT been run on this code yet.', 'After you approve and press Create branch & commit, GitHub Actions runs; use Monitor / Diagnose CI to read the result.']
    }
    // 10. submit for owner approval via the existing guarded pipeline (branch name, base pin, content hash, secret scan, sensitive ack)
    await progress('submit', 'creating approval')
    const out = await proposeChange(ctx, { ...(sc ? { branch_context_required: true, selected_branch: sc.branch, selected_branch_sha: rc.sha } : {}), repo, expected_base_sha: rc.sha, title: str(p.title || plan.summary || request, 100), description: str(plan.summary || request, 1000), base, files }, { explanation: str(report.review.what_changed || plan.summary, 500), dev_report: report })
    await progress('awaiting_approval')
    return { status: 'awaiting_approval', result: { ...out.result, dev_report: report, progress: stages } }
  })
}

async function planOnce(ctx: Ctx, request: string, kind: string, rc: RepoCtx, history: unknown) {
  const r = await planDev(ctx.cfg, { request, kind, history, repo: compact(rc) })
  await recordAi(ctx, 'dev_plan', r)
  needAi(r, 'plan the change')
  const j = parse(r.text)
  if (!j || typeof j !== 'object') throw new AgentError('Gemini plan was not valid JSON; nothing was changed. Try again.', 502, 'gemini_format')
  return j
}

interface PlannedFile { path: string; op: 'create' | 'update' | 'delete'; why: string }
function normalisePlan(plan: any, tree: { path: string }[]): PlannedFile[] {
  const exists = new Set(tree.map(t => t.path))
  const seen = new Set<string>()
  const out: PlannedFile[] = []
  for (const f of Array.isArray(plan.files_to_change) ? plan.files_to_change : []) {
    const path = validatePath(f && f.path)
    const op = f.op === 'create' || f.op === 'update' || f.op === 'delete' ? f.op : (exists.has(path) ? 'update' : 'create')
    if (seen.has(path)) continue
    seen.add(path)
    // Trust the real tree, not the model: a "create" of an existing file becomes an update; an update of a missing file becomes a create.
    const real: PlannedFile['op'] = op === 'delete' ? (exists.has(path) ? 'delete' : 'create') : exists.has(path) ? 'update' : 'create'
    out.push({ path, op: real, why: str(f.why, 200) })
  }
  return out
}
const planSummary = (plan: any, planned: PlannedFile[]) => ({ summary: str(plan.summary, 600), approach: str(plan.approach, 800), files: planned, dependencies: strs(plan.dependencies), breaking_changes: strs(plan.breaking_changes), risks: strs(plan.risks), security: strs(plan.security), tests: strs(plan.tests), expected_result: str(plan.expected_result, 400) })

async function currentContents(rc: RepoCtx & { gh: GitHub }, batch: PlannedFile[], lim: DevLimits, secrets: string[]) {
  const need = batch.filter(f => f.op !== 'create').map(f => f.path)
  // A file whose content was redacted or cut for the model cannot be safely rewritten as a whole: refuse instead of corrupting it.
  for (const path of need) { const f = rc.files.find(x => x.path === path); if (f && (f.redacted || f.truncated)) throw new AgentError(`${path} contains secret-like values or is too large to rewrite safely; Agent 2 will not modify it`, 422, 'unsafe_rewrite') }
  const have = new Map(rc.files.map(f => [f.path, f.content]))
  const miss = need.filter(x => !have.has(x))
  if (miss.length) {
    // generated code replaces whole files, so a truncated read would lose code: read in full or refuse
    for (const path of miss) {
      const e = rc.tree.find(t => t.path === path)!
      const t = await rc.gh.blobText(rc.repo, e.sha, 200_000).catch(() => { throw new AgentError(`Cannot read ${path} in full (too large for API mode); not changing it`, 413, 'too_large') })
      if (redactString(t, secrets) !== t) throw new AgentError(`${path} contains secret-like values; Agent 2 will not rewrite it`, 422, 'unsafe_rewrite')
      have.set(path, t)
    }
  }
  void lim
  return need.map(path => ({ path, content: have.get(path) as string }))
}

async function genBatch(ctx: Ctx, request: string, plan: any, batch: PlannedFile[], current: { path: string; content: string }[], done: string[], feedback: string[]): Promise<FileIn[]> {
  const r = await codegen(ctx.cfg, { request, plan: { summary: plan.summary, approach: plan.approach, tests: plan.tests }, batch_files: batch, current_files: current, already_generated_paths: done, check_failures_to_fix: feedback })
  await recordAi(ctx, 'dev_codegen', r)
  needAi(r, 'write the code')
  const j = parse(r.text)
  if (!j || !Array.isArray(j.files)) throw new AgentError('Gemini code output was not valid JSON; nothing was changed. Try again.', 502, 'gemini_format')
  return j.files.filter((f: any) => f && typeof f.path === 'string').map((f: any) => ({ path: f.path, op: f.op, content: typeof f.content === 'string' ? f.content : undefined }))
}

// Problems the model can fix itself in another round. Out-of-scope paths are a hard error, never "fixed".
function checkBatch(out: FileIn[], batch: PlannedFile[], rc: RepoCtx): string[] {
  const problems: string[] = []
  const want = new Map(batch.map(b => [b.path, b]))
  for (const f of out) if (!want.has(f.path)) throw new AgentError('Gemini tried to change a file outside the plan (' + str(f.path, 80) + '); nothing was changed', 422, 'out_of_scope')
  for (const b of batch) {
    const f = out.find(x => x.path === b.path)
    if (!f) { problems.push('missing file ' + b.path); continue }
    if (f.op !== b.op) { problems.push(`${b.path}: op must be ${b.op}`); continue }
    if (b.op !== 'delete' && (typeof f.content !== 'string' || !f.content.trim())) { problems.push(b.path + ': empty content'); continue }
    if (b.op === 'update') { const old = rc.files.find(x => x.path === b.path); if (old && old.content === f.content) problems.push(b.path + ': no change') }
  }
  if (!problems.length) { for (const c of staticChecks(out)) if (!c.ok) problems.push(c.name + (c.detail ? ' ' + c.detail : '')) }
  if (!problems.length) { try { validateFiles(out, { ...LIMITS, maxFiles: 200 }) } catch (e) { if (e instanceof AgentError && e.code === 'secret_detected') problems.push('secrets must not appear in code'); else if (e instanceof AgentError) problems.push(e.message.slice(0, 160)) } }
  return problems
}

// ---------------------------------------------------------------- CI monitoring + failure diagnosis
async function devDiagnose(ctx: Ctx, p: any): Promise<any> {
  const repo = validRepo(p.repo)
  // CI target: the selected branch, or an explicit agent2/* working branch (e.g. "Check CI" on a committed proposal). Never unfiltered when strict.
  const sc = isStrict(p) ? scopeOf(p, 'branch', { allowWorking: true }) : null
  const branch = (sc ? sc.branch : str(p.branch, 100)) || undefined
  return withTask(ctx, 'dev_diagnose', `Diagnose CI ${repo}${branch ? ' ' + branch : ''}`, { repo, branch: branch || null }, async () => {
    const wait = Math.min(Math.max(Number(p.wait_ms) || 0, 0), 25_000)
    if (wait) await new Promise(r => setTimeout(r, wait))
    const mon = await monitor(ctx, repo, branch)
    const pins = sc ? sc.pins : (p.branch_sha ? [String(p.branch_sha).toLowerCase()] : [])
    if (branch && (sc || pins.length)) {
      const current = await new GitHub(ctx.cfg, ctx.calls).branchSha(repo, branch)
      if (!current) throw new AgentError('Selected branch moved or was deleted. Refresh before CI diagnosis.', 409, 'base_changed')
      assertPins(current, pins, 'Selected branch')
    }
    // Never invent a result: only a completed run with a conclusion counts.
    if (mon.overall !== 'failing') return { result: { ci: mon.overall, runs: mon.runs, failed_jobs: [], note: mon.overall === 'passing' ? 'GitHub Actions reports success for the latest run.' : mon.overall === 'running' ? 'CI is still running. Check again shortly.' : 'No GitHub Actions run found for this branch yet.' } }
    const logs = mon.failed_jobs.map((j: any) => ({ job: j.job, steps: j.failed_steps, log: j.log }))
    const ai = await assist(ctx.cfg, 'debug', { task: 'ci_failure', error_log: logs, branch })
    await recordAi(ctx, 'dev_diagnose', ai)
    const result: any = { ci: 'failing', runs: mon.runs, failed_jobs: mon.failed_jobs, analysis: ai.text ? redactString(ai.text, secretValues(ctx.cfg)) : undefined, analysis_note: ai.text ? undefined : ai.error }
    if (p.propose_fix === true && branch && /^agent2\//.test(branch)) {
      const log = redactString(JSON.stringify(logs).slice(0, 3000), secretValues(ctx.cfg))
      const fix = await devProposal(ctx, { repo, request: 'Fix the failing GitHub Actions job. Failure details (data): ' + log, kind: 'bugfix', ref: branch, base: branch, title: 'Fix CI on ' + branch })
      result.fix_proposal = fix.result
      result.next = 'A fix proposal was created on top of ' + branch + '. Approve it in Approvals.'
    }
    return { result }
  })
}

export async function runDev(ctx: Ctx, action: string, params: any = {}): Promise<any> {
  switch (action) {
    case 'dev_chat': return devChat(ctx, params)
    case 'dev_assist': return devAssist(ctx, params)
    case 'dev_proposal': return devProposal(ctx, params)
    case 'dev_diagnose': return devDiagnose(ctx, params)
  }
  throw new AgentError('Unknown action', 400, 'unknown_action')
}
export type { Out }
