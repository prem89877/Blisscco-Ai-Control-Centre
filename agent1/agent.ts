import { loadConfig, readiness, secretValues, projectList, resolveProject as resolveSupaProject, type Config } from './config.js'
import { AgentError, clip, errMsg, fingerprint, redact } from './util.js'
import { Store } from './store.js'
import { Vercel, type VProject } from './vercel.js'
import { GitHub, type RepoReport } from './github.js'
import { Q, SCHEMA_ALLOW, SupaMgmt, probeAnon } from './supa.js'
import { summarize, planCommand } from './gemini.js'
import { analyzeProject, analyzeRls, classifyDbChange, classifyExecutableSql, countIssues, overall, sortIssues, PUBLIC_PREFIX, type DeployItem, type EnvItem, type Issue } from './checks.js'

export interface Actor { type: 'user' | 'system'; id: string | null }
export interface Ctx { cfg: Config; store: Store; actor: Actor; calls: Record<string, number> }
export const ACTIONS = ['heartbeat', 'health_report', 'vercel_status', 'env_audit', 'supabase_schema', 'rls_check', 'request_env_change', 'apply_env_change', 'propose_db_change', 'apply_db_change', 'github_status', 'github_branches', 'deploy_logs', 'request_redeploy', 'apply_redeploy', 'vercel_options', 'project_options', 'ai_command'] as const
export type Action = typeof ACTIONS[number]

export function makeCtx(cfg: Config, actor: Actor): Ctx { return { cfg, store: new Store(cfg), actor, calls: {} } }

const now = () => new Date().toISOString()
const AI_TABLES = ['agents', 'tasks', 'approvals', 'activity_logs', 'api_usage', 'system_health', 'settings', 'owners']
const TARGETS = ['production', 'preview', 'development']
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

interface Out { result: any; status?: 'succeeded' | 'awaiting_approval' }

async function withTask(ctx: Ctx, action: string, title: string, payload: Record<string, unknown>, fn: (taskId: string) => Promise<Out>) {
  const secrets = secretValues(ctx.cfg)
  await ctx.store.ensureAgent()
  await ctx.store.setStatus('running')
  const task = await ctx.store.createTask({ title, description: 'Agent 1 - ' + action, status: 'running', payload: { action, ...payload }, created_by: ctx.actor.id, started_at: now() })
  await ctx.store.log('info', `agent1_${action}_start`, title, {}, task.id, ctx.actor.id)
  try {
    const out = await fn(task.id)
    const status = out.status || 'succeeded'
    const result = clip(redact(out.result, secrets))
    await ctx.store.updateTask(task.id, { status, result, finished_at: status === 'succeeded' ? now() : null })
    for (const [provider, n] of Object.entries(ctx.calls)) if (n > 0) await ctx.store.usage({ provider, endpoint: action, request_count: n })
    await ctx.store.log(status === 'succeeded' ? 'success' : 'info', `agent1_${action}_${status}`, title, {}, task.id, ctx.actor.id)
    await ctx.store.setStatus('idle')
    return { task_id: task.id, status, result }
  } catch (e) {
    const msg = redact(errMsg(e), secrets) as string
    await ctx.store.updateTask(task.id, { status: 'failed', error_message: msg, finished_at: now() }).catch(() => {})
    await ctx.store.log('error', `agent1_${action}_failed`, msg, {}, task.id, ctx.actor.id)
    await ctx.store.setStatus('error').catch(() => {})
    const err = e instanceof AgentError ? e : new AgentError(msg, 500, 'internal')
    err.message = msg
    err.taskId = task.id
    throw err
  }
}

// ---------- collectors (read-only) ----------
interface Part<T> { available: boolean; reason?: string; data?: T; issues: Issue[] }

async function collectVercel(ctx: Ctx, o: { deployments: boolean; env: boolean }, only?: string): Promise<Part<any>> {
  if (!ctx.cfg.vercelToken) return { available: false, reason: 'AGENT1_VERCEL_TOKEN not set', issues: [{ severity: 'warn', area: 'config', message: 'Vercel monitoring not configured (AGENT1_VERCEL_TOKEN)' }] }
  const v = new Vercel(ctx.cfg, ctx.calls)
  const projects = (await v.listProjects()).filter(p => !only || p.name === only)
  const issues: Issue[] = []
  const per = await Promise.all(projects.map(async p => {
    try {
      const deployments = o.deployments ? await v.listDeployments(p.id) : null
      const env = o.env ? await v.listEnv(p.id) : null
      return {
        issues: analyzeProject(p.name, deployments, env, ctx.cfg.requiredEnv[p.name] || []),
        entry: {
          id: p.id, name: p.name, framework: p.framework, repo: p.repo,
          deployments: deployments ? deployments.slice(0, 5).map(d => ({ state: d.state, target: d.target, branch: d.branch, error: d.error || undefined, at: new Date(d.createdAt).toISOString() })) : undefined,
          env: env ? env.map(e => ({ key: e.key, type: e.type, targets: e.targets })) : undefined
        } as any
      }
    } catch (e) {
      // one slow/failed project must not hide the others
      return { issues: [{ severity: 'warn', area: 'vercel', message: 'Could not read project: ' + errMsg(e), target: p.name } as Issue], entry: { id: p.id, name: p.name, error: errMsg(e) } as any }
    }
  }))
  const data = per.map(x => x.entry)
  for (const x of per) issues.push(...x.issues)
  if (!projects.length) issues.push({ severity: 'warn', area: 'vercel', message: 'No Vercel projects visible to this token' + (ctx.cfg.vercelProjects.length ? ' (check AGENT1_VERCEL_PROJECTS)' : '') })
  return { available: true, data: { projects: data }, issues }
}

async function collectRls(ctx: Ctx, ref?: string): Promise<Part<any>> {
  if (!ctx.cfg.supaToken) return { available: false, reason: 'AGENT1_SUPABASE_ACCESS_TOKEN not set', issues: [{ severity: 'warn', area: 'config', message: 'Supabase inspection not configured (AGENT1_SUPABASE_ACCESS_TOKEN)' }] }
  const s = new SupaMgmt(ctx.cfg, ctx.calls, ref)
  const [tables, policies] = await Promise.all([s.tables(), s.policies()])
  const issues = analyzeRls(tables, policies)
  const other = Boolean(ref && ref !== ctx.cfg.supabaseRef) // the anon probe only knows the default project's URL
  const probe = other ? [] : await probeAnon(ctx.cfg, ctx.calls, AI_TABLES)
  if (other) issues.push({ severity: 'info', area: 'config', message: 'Anon probe skipped (only runs for the default Supabase project)' })
  for (const p of probe) if (p.verdict === 'LEAK') issues.push({ severity: 'critical', area: 'supabase', message: 'anon key can read rows', target: 'ai_control.' + p.table })
  if (!other && !ctx.cfg.anonKey) issues.push({ severity: 'info', area: 'config', message: 'Anon probe skipped (VITE_SUPABASE_ANON_KEY not visible to server)' })
  const by: Record<string, { tables: number; rls_on: number; policies: number }> = {}
  for (const t of tables) { const b = (by[t.schema] ||= { tables: 0, rls_on: 0, policies: 0 }); b.tables++; if (t.rls) b.rls_on++ }
  for (const p of policies) { const b = (by[p.schema] ||= { tables: 0, rls_on: 0, policies: 0 }); b.policies++ }
  return { available: true, data: { by_schema: by, anon_probe: probe }, issues }
}

async function collectGithub(ctx: Ctx, selectedRepo?: string, selectedBranch?: string, expectedSha?: string, strict = false): Promise<Part<RepoReport[]>> {
  if (!ctx.cfg.githubToken || !ctx.cfg.githubRepos.length) return { available: false, reason: 'AGENT1_GITHUB_TOKEN / AGENT1_GITHUB_REPOS not set', issues: [{ severity: 'info', area: 'config', message: 'GitHub checks not configured' }] }
  const g = new GitHub(ctx.cfg, ctx.calls)
  const issues: Issue[] = []
  const repos: RepoReport[] = []
  for (const r of (selectedRepo ? [selectedRepo] : ctx.cfg.githubRepos)) {
    if (!ctx.cfg.githubRepos.some(x => x.toLowerCase() === r.toLowerCase())) throw new AgentError('Repo not allowed', 403, 'repo_not_allowed')
    const rep = await g.inspect(r, selectedBranch, expectedSha, strict)
    repos.push(rep)
    if (!rep.found) { issues.push({ severity: 'error', area: 'github', message: 'Repo not found or no access', target: r }); continue }
    for (const f of rep.committedEnvFiles || []) issues.push({ severity: 'critical', area: 'github', message: 'Env file committed to repo: ' + f, target: r })
    const last = (rep.runs || [])[0]
    if (last && last.conclusion === 'failure') issues.push({ severity: 'warn', area: 'github', message: 'Latest workflow run failed: ' + last.name, target: r })
  }
  return { available: true, data: repos, issues }
}

async function safe<T>(label: string, area: Issue['area'], p: Promise<Part<T>>): Promise<Part<T>> {
  try { return await p } catch (e) { return { available: false, reason: errMsg(e), issues: [{ severity: 'error', area, message: label + ' check failed: ' + errMsg(e) }] } }
}

// ---------- actions ----------
async function healthReport(ctx: Ctx, params: any = {}): Promise<Out> {
  const [vercel, rls, gh] = await Promise.all([
    safe('Vercel', 'vercel', collectVercel(ctx, { deployments: true, env: true })),
    safe('Supabase', 'supabase', collectRls(ctx)),
    safe('GitHub', 'github', collectGithub(ctx, params.repo ? String(params.repo) : undefined, params.branch ? String(params.branch) : undefined, params.branch_sha ? String(params.branch_sha) : undefined, Boolean(params.branch_context_required)))
  ])
  const issues = sortIssues([...vercel.issues, ...rls.issues, ...gh.issues])
  const comp = (name: string, p: Part<unknown>) => ({ component: 'agent1_' + name, status: (!p.available ? 'degraded' : p.issues.some(i => i.severity === 'critical' || i.severity === 'error') ? 'degraded' : 'ok') as 'ok' | 'degraded', details: { reason: p.reason || null } })
  await ctx.store.health([comp('vercel', vercel), comp('supabase', rls), comp('github', gh)])
  const counts = countIssues(issues)
  const digest = { overall: overall(issues), counts, issues: issues.slice(0, 40), // already sorted: critical first
    vercel_projects: (vercel.data?.projects || []).map((p: any) => ({ name: p.name, latest: p.deployments?.[0]?.state })) }
  const ai = await summarize(ctx.cfg, digest)
  if (ai.status || ai.error) await ctx.store.usage({ provider: 'gemini', model: ai.model, endpoint: 'generateContent', tokens_in: ai.tokensIn, tokens_out: ai.tokensOut, status_code: ai.status || null, cost_estimate: (ai.tokensIn * ctx.cfg.priceIn + ai.tokensOut * ctx.cfg.priceOut) / 1e6 })
  return { result: { generated_at: now(), overall: overall(issues), counts, issues, vercel, supabase: rls, github: gh, ai_summary: ai.text, ai_note: ai.text ? undefined : ai.error } }
}

async function partReport(ctx: Ctx, p: Part<any>): Promise<Out> {
  if (!p.available && p.reason) throw new AgentError(p.reason, 503, 'not_configured')
  return { result: { generated_at: now(), overall: overall(p.issues), counts: countIssues(p.issues), issues: sortIssues(p.issues), ...p.data } }
}

async function schemaReport(ctx: Ctx, params: any): Promise<Out> {
  const schema = String(params.schema || 'ai_control')
  if (!SCHEMA_ALLOW.includes(schema)) throw new AgentError('schema must be one of ' + SCHEMA_ALLOW.join(', '), 400)
  const s = new SupaMgmt(ctx.cfg, ctx.calls, params.project_ref ? resolveSupaProject(ctx.cfg, String(params.project_ref)).ref : undefined) // allow-list only; empty = default project
  const [counts, functions, tables, columns] = await Promise.all([s.roQuery(Q.counts), s.roQuery(Q.functions), s.tables(), s.roQuery(Q.columns(schema))])
  const cols: Record<string, string[]> = {}
  for (const c of columns) (cols[c.table_name] ||= []).push(`${c.column_name} ${c.data_type}${c.is_nullable === 'NO' ? ' not null' : ''}`)
  return { result: { generated_at: now(), schema, by_schema: counts, functions, tables: tables.filter(t => t.schema === schema).map(t => ({ name: t.tbl, rls: t.rls })), columns: cols } }
}

async function resolveProject(ctx: Ctx, name: string): Promise<VProject> {
  const p = (await new Vercel(ctx.cfg, ctx.calls).listProjects()).find(x => x.name === name || x.id === name)
  if (!p) throw new AgentError('Vercel project not found (or not in AGENT1_VERCEL_PROJECTS): ' + name, 404)
  return p
}

async function requestEnvChange(ctx: Ctx, p: any): Promise<Out> {
  const op = String(p.op || 'upsert')
  const key = String(p.key || '')
  const type = String(p.type || 'encrypted')
  const targets: string[] = Array.isArray(p.targets) ? p.targets.map(String) : []
  if (!['upsert', 'delete'].includes(op)) throw new AgentError('op must be upsert or delete')
  if (!KEY_RE.test(key)) throw new AgentError('Invalid env var name')
  if (!targets.length || targets.some(t => !TARGETS.includes(t))) throw new AgentError('targets must be a subset of ' + TARGETS.join(', '))
  if (!['encrypted', 'sensitive', 'plain'].includes(type)) throw new AgentError('type must be encrypted, sensitive or plain')
  if (type === 'sensitive' && targets.includes('development')) throw new AgentError('Sensitive variables cannot target development')
  if (PUBLIC_PREFIX.test(key) && /(SERVICE_ROLE|SECRET|PRIVATE|PASSWORD|TOKEN|GEMINI)/i.test(key)) throw new AgentError('Refused: secret-looking name with a browser-public prefix')
  let valueFp: string | null = null
  if (op === 'upsert') {
    const value = typeof p.value === 'string' ? p.value : ''
    if (!value || value.length > 8192) throw new AgentError('value required (1-8192 chars) for upsert')
    valueFp = fingerprint(ctx.cfg.serviceKey, value)
  }
  const project = await resolveProject(ctx, String(p.project || ''))
  const production = targets.includes('production')
  const title = `Env ${op} ${key} on ${project.name} [${targets.join(',')}]${production ? ' - PRODUCTION' : ''}`
  return withTask(ctx, 'request_env_change', title, { project: project.name, op, key, targets, type }, async taskId => {
    const ap = await ctx.store.createApproval({ task_id: taskId, title, details: { kind: 'env_change', project: project.name, project_id: project.id, op, key, targets, type, production, value_fp: valueFp, note: 'Value is NOT stored. Re-enter it when applying.' } })
    await ctx.store.log('warn', 'agent1_approval_requested', title, { approval_id: ap.id }, taskId, ctx.actor.id)
    return { status: 'awaiting_approval', result: { approval_id: ap.id, production, next: 'Approve in the Approvals tab, then apply from the Agent 1 panel.' } }
  })
}

async function applyEnvChange(ctx: Ctx, p: any): Promise<Out> {
  const ap = await ctx.store.getApproval(String(p.approval_id || ''))
  const d = ap && ap.details
  if (!ap || !d || d.kind !== 'env_change') throw new AgentError('Approval not found', 404)
  if (ap.status !== 'approved') throw new AgentError('Not approved yet (status: ' + ap.status + ')', 409, 'not_approved')
  if (d.executed_at) throw new AgentError('Already executed', 409, 'already_executed')
  if (!ap.decided_at || Date.now() - new Date(ap.decided_at).getTime() > 24 * 3600 * 1000) throw new AgentError('Approval older than 24h; request again', 409, 'expired')
  if (d.production && p.production_ack !== 'APPROVE-PRODUCTION') throw new AgentError('Production change needs explicit confirmation (production_ack)', 403, 'production_ack')
  const value = typeof p.value === 'string' ? p.value : ''
  if (d.op === 'upsert' && fingerprint(ctx.cfg.serviceKey, value) !== d.value_fp) throw new AgentError('Value does not match the approved request', 409, 'value_mismatch')
  return withTask(ctx, 'apply_env_change', 'Apply: ' + ap.title, { approval_id: ap.id, key: d.key, project: d.project }, async () => {
    const claimed = await ctx.store.claimApproval(ap.id, { ...d, executed_at: now(), executed_by: ctx.actor.id })
    if (!claimed) throw new AgentError('Already executed', 409, 'already_executed')
    try {
      const v = new Vercel(ctx.cfg, ctx.calls)
      let changed = 0
      if (d.op === 'upsert') { await v.upsertEnv(d.project_id, d.key, value, d.type, d.targets); changed = 1 }
      else {
        const envs = (await v.listEnv(d.project_id)).filter(e => e.key === d.key && e.targets.some(t => d.targets.includes(t)))
        if (envs.some(e => e.targets.some(t => !d.targets.includes(t)))) throw new AgentError('Variable also targets other environments; delete refused (do it manually)', 409, 'partial_target')
        for (const e of envs) { await v.deleteEnv(d.project_id, String(e.id)); changed++ }
      }
      if (ap.task_id) await ctx.store.updateTask(ap.task_id, { status: 'succeeded', finished_at: now(), result: { applied: true, changed } })
      await ctx.store.log('success', 'agent1_env_applied', `${d.op} ${d.key} on ${d.project} [${d.targets.join(',')}]`, { approval_id: ap.id, production: d.production }, null, ctx.actor.id)
      return { result: { applied: true, op: d.op, key: d.key, project: d.project, targets: d.targets, changed } }
    } catch (e) {
      await ctx.store.patchApproval(ap.id, { details: { ...d, executed_at: null, last_error: errMsg(e).slice(0, 300) } }).catch(() => {})
      throw e
    }
  })
}

async function proposeDbChange(ctx: Ctx, p: any): Promise<Out> {
  const title = String(p.title || '').trim().slice(0, 120)
  const sql = String(p.sql || '')
  if (!title) throw new AgentError('title required')
  const c = classifyExecutableSql(sql)
  if (!c.ok) throw new AgentError('DB change blocked: ' + c.reason, 403, 'db_change_blocked')
  const proj = resolveSupaProject(ctx.cfg, p.project_ref ? String(p.project_ref) : undefined) // allow-list only; empty = default project
  return withTask(ctx, 'propose_db_change', 'DB change proposal: ' + title, { title }, async taskId => {
    const ap = await ctx.store.createApproval({ task_id: taskId, title: 'DB change: ' + title, details: { kind: 'db_change', sql, project_ref: proj.ref, project_label: proj.label, executed_by_agent: false, note: 'Runs on Supabase project "' + proj.label + '". After approval, press Run SQL in the Agent 1 console (ai_control only, one transaction), or run it manually in the Supabase SQL Editor.' } })
    await ctx.store.log('warn', 'agent1_approval_requested', 'DB change: ' + title, { approval_id: ap.id }, taskId, ctx.actor.id)
    return { status: 'awaiting_approval', result: { approval_id: ap.id, next: 'Approve in the Approvals tab, then press Run SQL in the Agent 1 console.' } }
  })
}

async function applyDbChange(ctx: Ctx, p: any): Promise<Out> {
  const ap = await ctx.store.getApproval(String(p.approval_id || ''))
  const d = ap && ap.details
  if (!ap || !d || d.kind !== 'db_change') throw new AgentError('Approval not found', 404)
  if (ap.status !== 'approved') throw new AgentError('Not approved yet (status: ' + ap.status + ')', 409, 'not_approved')
  if (d.executed_at) throw new AgentError('Already executed', 409, 'already_executed')
  if (!ap.decided_at || Date.now() - new Date(ap.decided_at).getTime() > 24 * 3600 * 1000) throw new AgentError('Approval older than 24h; request again', 409, 'expired')
  if (p.db_ack !== 'RUN-SQL') throw new AgentError('Explicit confirmation needed (db_ack)', 403, 'db_ack')
  const c = classifyExecutableSql(String(d.sql || ''))
  if (!c.ok) throw new AgentError('DB change blocked: ' + c.reason, 403, 'db_change_blocked')
  const proj = resolveSupaProject(ctx.cfg, d.project_ref ? String(d.project_ref) : undefined) // re-checked at execution; older approvals use the default project
  return withTask(ctx, 'apply_db_change', 'Run SQL: ' + ap.title, { approval_id: ap.id }, async () => {
    const claimed = await ctx.store.claimApproval(ap.id, { ...d, executed_at: now(), executed_by: ctx.actor.id, executed_by_agent: true })
    if (!claimed) throw new AgentError('Already executed', 409, 'already_executed')
    try {
      const rows = await new SupaMgmt(ctx.cfg, ctx.calls, proj.ref).rwExec(String(d.sql))
      if (ap.task_id) await ctx.store.updateTask(ap.task_id, { status: 'succeeded', finished_at: now(), result: { applied: true, rows: rows.length } })
      await ctx.store.log('success', 'agent1_db_applied', ap.title, { approval_id: ap.id }, null, ctx.actor.id)
      return { result: { applied: true, rows: rows.length, preview: rows.slice(0, 5) } }
    } catch (e) {
      await ctx.store.patchApproval(ap.id, { details: { ...d, executed_at: null, last_error: errMsg(e).slice(0, 300) } }).catch(() => {})
      throw e
    }
  })
}

async function githubStatus(ctx: Ctx, p: any = {}): Promise<Out> {
  const g = await collectGithub(ctx, p.repo ? String(p.repo) : undefined, p.branch ? String(p.branch) : undefined, p.branch_sha ? String(p.branch_sha) : undefined, Boolean(p.branch_context_required))
  if (!g.available && g.reason) throw new AgentError(g.reason, 503, 'not_configured')
  return { result: { generated_at: now(), overall: overall(g.issues), counts: countIssues(g.issues), issues: sortIssues(g.issues), repos: g.data } }
}

async function deployLogs(ctx: Ctx, p: any): Promise<Out> {
  const v = new Vercel(ctx.cfg, ctx.calls)
  const name = String(p.project || '')
  const projects = name ? [await resolveProject(ctx, name)] : await v.listProjects()
  const wanted = p.deployment ? String(p.deployment) : ''
  const issues: Issue[] = []
  const deployments: any[] = []
  for (const pr of projects) {
    if (deployments.length >= 3) break
    const deps = await v.listDeployments(pr.id)
    const d = wanted ? deps.find(x => x.id === wanted) : deps.find(x => x.state === 'ERROR')
    if (wanted && !d) throw new AgentError('Deployment not found in recent history of ' + pr.name, 404)
    if (!d) { if (name) issues.push({ severity: 'info', area: 'vercel', message: 'No failed deployment in recent history', target: pr.name }); continue }
    let log_tail: string[] = []
    try { log_tail = await v.buildLogs(d.id) } catch (e) { issues.push({ severity: 'warn', area: 'vercel', message: 'Could not read build logs: ' + errMsg(e), target: pr.name }) }
    if (d.state === 'ERROR') issues.push({ severity: 'error', area: 'vercel', message: 'Failed deployment ' + d.id + (d.error ? ': ' + d.error : ''), target: pr.name })
    deployments.push({ project: pr.name, deployment_id: d.id, state: d.state, target: d.target, branch: d.branch, error: d.error || undefined, at: new Date(d.createdAt).toISOString(), log_tail })
  }
  if (!deployments.length && !issues.length) issues.push({ severity: 'info', area: 'vercel', message: 'No failed deployments in recent history' })
  return { result: { generated_at: now(), overall: overall(issues), counts: countIssues(issues), issues: sortIssues(issues), deployments } }
}

// READ-ONLY lookup for the dashboard dropdowns (projects -> recent deployments). Not logged as a task: it runs on every page open.
async function vercelOptions(ctx: Ctx): Promise<Out> {
  const v = new Vercel(ctx.cfg, ctx.calls)
  const projects: any[] = []
  for (const pr of await v.listProjects()) {
    let deployments: any[] = []
    try { deployments = (await v.listDeployments(pr.id, 15)).map(d => ({ id: d.id, state: d.state, target: d.target, branch: d.branch, at: new Date(d.createdAt).toISOString() })) } catch { /* project shown without deployments */ }
    projects.push({ name: pr.name, deployments })
  }
  return { result: { projects } }
}

async function requestRedeploy(ctx: Ctx, p: any): Promise<Out> {
  const project = await resolveProject(ctx, String(p.project || ''))
  const deps = await new Vercel(ctx.cfg, ctx.calls).listDeployments(project.id)
  const want = p.target ? String(p.target) : ''
  if (want && !['preview', 'production'].includes(want)) throw new AgentError('target must be preview or production', 400, 'bad_target')
  const pool = want ? deps.filter(d => d.target === want) : deps
  const src = p.deployment ? deps.find(d => d.id === String(p.deployment)) : pool[0]
  if (!src) throw new AgentError('No matching deployment found in recent history', 404)
  if (want && src.target !== want) throw new AgentError('Deployment is ' + src.target + ', not ' + want, 400, 'target_mismatch')
  const production = src.target === 'production'
  const title = `Redeploy ${project.name} (${src.id.slice(0, 14)}) [${src.target}]${production ? ' - PRODUCTION' : ''}`
  return withTask(ctx, 'request_redeploy', title, { project: project.name, deployment_id: src.id, target: src.target }, async taskId => {
    const ap = await ctx.store.createApproval({ task_id: taskId, title, details: { kind: 'redeploy', project: project.name, project_id: project.id, deployment_id: src.id, source_target: src.target, production, note: 'Re-runs the same source. Press Redeploy in the Agent 1 console after approval.' } })
    await ctx.store.log('warn', 'agent1_approval_requested', title, { approval_id: ap.id }, taskId, ctx.actor.id)
    return { status: 'awaiting_approval', result: { approval_id: ap.id, production, next: 'Approve in the Approvals tab, then press Redeploy in the Agent 1 console.' } }
  })
}

async function applyRedeploy(ctx: Ctx, p: any): Promise<Out> {
  const ap = await ctx.store.getApproval(String(p.approval_id || ''))
  const d = ap && ap.details
  if (!ap || !d || d.kind !== 'redeploy') throw new AgentError('Approval not found', 404)
  if (ap.status !== 'approved') throw new AgentError('Not approved yet (status: ' + ap.status + ')', 409, 'not_approved')
  if (d.executed_at) throw new AgentError('Already executed', 409, 'already_executed')
  if (!ap.decided_at || Date.now() - new Date(ap.decided_at).getTime() > 24 * 3600 * 1000) throw new AgentError('Approval older than 24h; request again', 409, 'expired')
  if (d.production && p.production_ack !== 'APPROVE-PRODUCTION') throw new AgentError('Production redeploy needs explicit confirmation (production_ack)', 403, 'production_ack')
  return withTask(ctx, 'apply_redeploy', 'Apply: ' + ap.title, { approval_id: ap.id, project: d.project }, async () => {
    const claimed = await ctx.store.claimApproval(ap.id, { ...d, executed_at: now(), executed_by: ctx.actor.id })
    if (!claimed) throw new AgentError('Already executed', 409, 'already_executed')
    try {
      const out = await new Vercel(ctx.cfg, ctx.calls).redeploy(d.project, d.deployment_id, Boolean(d.production))
      if (ap.task_id) await ctx.store.updateTask(ap.task_id, { status: 'succeeded', finished_at: now(), result: { applied: true, new_deployment: out.id } })
      await ctx.store.log('success', 'agent1_redeploy_started', `${d.project} <- ${d.deployment_id}`, { approval_id: ap.id, production: d.production }, null, ctx.actor.id)
      return { result: { applied: true, project: d.project, new_deployment: out.id, url: out.url } }
    } catch (e) {
      await ctx.store.patchApproval(ap.id, { details: { ...d, executed_at: null, last_error: errMsg(e).slice(0, 300) } }).catch(() => {})
      throw e
    }
  })
}

// READ-ONLY lookup for the Ask box dropdowns (Vercel project names + allow-listed Supabase projects). Not logged as a task.
async function projectOptions(ctx: Ctx): Promise<Out> {
  let vercel: string[] = []
  if (ctx.cfg.vercelToken) { try { vercel = (await new Vercel(ctx.cfg, ctx.calls).listProjects()).map(x => x.name) } catch { /* dropdown stays empty; the error shows when a Vercel action runs */ } }
  return { result: { vercel, supabase: projectList(ctx.cfg).map(x => ({ ref: x.ref, label: x.label })) } }
}

// ---------- free-text command (AI picks ONE allowed action; code validates everything) ----------
// Only read-only checks and a redeploy REQUEST (which still needs approval) can be picked. Env values and SQL are never reachable from here.
async function aiCommand(ctx: Ctx, p: any): Promise<any> {
  const text = String(p.text || '').trim().slice(0, 1000)
  if (!text) throw new AgentError('Write what you want Agent 1 to do', 400)
  const vNames: string[] = ctx.cfg.vercelToken ? (await new Vercel(ctx.cfg, ctx.calls).listProjects()).map(x => x.name) : []
  const sList = projectList(ctx.cfg)
  const pickedV = p.vercel_project ? String(p.vercel_project) : ''
  if (pickedV && !vNames.includes(pickedV)) throw new AgentError('Vercel project not found (or not in AGENT1_VERCEL_PROJECTS): ' + pickedV, 404)
  const pickedS = p.supabase_ref ? resolveSupaProject(ctx.cfg, String(p.supabase_ref)) : null // allow-list only
  const r = await planCommand(ctx.cfg, { request: text, selected_vercel_project: pickedV || null, selected_supabase_project: pickedS ? pickedS.label : null, vercel_projects: vNames.slice(0, 50), supabase_projects: sList.map(x => x.label) })
  await ctx.store.usage({ provider: 'gemini', model: r.model, endpoint: 'ai_command', tokens_in: r.tokensIn, tokens_out: r.tokensOut, status_code: r.status || null, cost_estimate: (r.tokensIn * ctx.cfg.priceIn + r.tokensOut * ctx.cfg.priceOut) / 1e6 })
  if (!r.text) throw new AgentError('Gemini could not read the request: ' + (r.error || 'no answer'), 502, 'ai_unavailable')
  let plan: any
  try { const a = r.text.indexOf('{'), b = r.text.lastIndexOf('}'); plan = JSON.parse(r.text.slice(a, b + 1)) } catch { throw new AgentError('Gemini answer was not valid JSON. Try again in simpler words.', 502, 'ai_bad_output') }
  const INTENTS = ['health_report', 'vercel_status', 'env_audit', 'deploy_logs', 'request_redeploy', 'supabase_schema', 'rls_check', 'github_status']
  const intent = INTENTS.includes(String(plan && plan.intent)) ? String(plan.intent) : 'unsupported'
  const understood = { intent, explanation: String((plan && plan.explanation) || '').slice(0, 300) }
  // A dropdown choice always wins; otherwise the AI's pick is used only if it is exactly a known project.
  const vp = pickedV || (typeof plan.vercel_project === 'string' && vNames.includes(plan.vercel_project) ? plan.vercel_project : '')
  const sp = pickedS || sList.find(x => typeof plan.supabase_project === 'string' && x.label.toLowerCase() === plan.supabase_project.toLowerCase()) || null
  const spLabel = sp ? ' [' + sp.label + ']' : ''
  const asked = { via: 'ask_agent' }
  // GitHub-touching intents run ONLY on the owner's selected repo + branch + SHA (sent by the dashboard); never on a default branch.
  const ghScope = () => {
    if (!p.repo || !p.branch) throw new AgentError('Select a GitHub repository and branch in the selector first; default fallback is disabled.', 400, 'branch_required')
    return { repo: String(p.repo), branch: String(p.branch), branch_sha: p.branch_sha ? String(p.branch_sha) : undefined, branch_context_required: true }
  }
  let out: any
  switch (intent) {
    case 'health_report': { const sc = ghScope(); out = await withTask(ctx, 'health_report', 'Infrastructure health report', { ...asked, repo: sc.repo, branch: sc.branch }, () => healthReport(ctx, sc)); break }
    case 'vercel_status': out = await withTask(ctx, 'vercel_status', 'Vercel status' + (vp ? ': ' + vp : ''), { ...asked, project: vp || null }, async () => partReport(ctx, await collectVercel(ctx, { deployments: true, env: false }, vp || undefined))); break
    case 'env_audit': out = await withTask(ctx, 'env_audit', 'Environment variable audit' + (vp ? ': ' + vp : ''), { ...asked, project: vp || null }, async () => partReport(ctx, await collectVercel(ctx, { deployments: false, env: true }, vp || undefined))); break
    case 'deploy_logs': out = await withTask(ctx, 'deploy_logs', 'Vercel deployment error logs' + (vp ? ': ' + vp : ''), { ...asked, project: vp || null }, () => deployLogs(ctx, { project: vp })); break
    case 'request_redeploy': {
      if (!vp) throw new AgentError('Pick the Vercel project to redeploy from the dropdown, then ask again', 400, 'project_required')
      const target = plan.target === 'preview' || plan.target === 'production' ? plan.target : undefined
      out = await requestRedeploy(ctx, { project: vp, target }); break
    }
    case 'supabase_schema': {
      const schema = SCHEMA_ALLOW.includes(String(plan.schema)) ? String(plan.schema) : 'ai_control'
      out = await withTask(ctx, 'supabase_schema', 'Supabase schema inspection' + spLabel, { ...asked, schema, project_ref: sp ? sp.ref : null }, () => schemaReport(ctx, { schema, project_ref: sp ? sp.ref : undefined })); break
    }
    case 'rls_check': out = await withTask(ctx, 'rls_check', 'RLS & permissions verification' + spLabel, { ...asked, project_ref: sp ? sp.ref : null }, async () => partReport(ctx, await collectRls(ctx, sp ? sp.ref : undefined))); break
    case 'github_status': { const sc = ghScope(); out = await withTask(ctx, 'github_status', 'GitHub repository status (read-only)', { ...asked, repo: sc.repo, branch: sc.branch }, () => githubStatus(ctx, sc)); break }
    default:
      await ctx.store.log('warn', 'agent1_command_unsupported', understood.explanation || 'unsupported request', {}, null, ctx.actor.id)
      return { status: 'succeeded', result: { unsupported: true, message: understood.explanation || 'This request is not something Agent 1 can do safely from the Ask box. Use the forms below for env or database changes.' }, understood }
  }
  return { ...out, understood }
}

// Strict GitHub scope for dashboard calls (branch_context_required) AND for any caller that names a branch.
//  - dashboard call without a branch      -> 400 branch_required (never the repo default branch)
//  - a branch without a repo              -> 400 repo_required (one branch name must never be applied blindly to unrelated repos)
//  - dashboard call without any repo      -> 400 repo_required (no "inspect every repo on its default branch")
export function assertGithubScope(action: string, params: any) {
  if (!['health_report', 'github_status'].includes(action)) return
  const needs = Boolean(params.branch_context_required)
  if (needs && !params.branch) throw new AgentError('Select a GitHub branch; default fallback is disabled.', 400, 'branch_required')
  if ((needs || params.branch) && !params.repo) throw new AgentError('Select a GitHub repository together with its branch.', 400, 'repo_required')
}

export async function runAction(ctx: Ctx, action: string, params: any = {}): Promise<any> {
  if (!(ACTIONS as readonly string[]).includes(action)) throw new AgentError('Unknown action', 400, 'unknown_action')
  assertGithubScope(action, params)
  switch (action as Action) {
    case 'heartbeat': {
      const agent = await ctx.store.heartbeat()
      return { agent: { id: agent.id, name: agent.name, status: agent.status, last_heartbeat_at: agent.last_heartbeat_at }, ready: readiness(ctx.cfg), repos: ctx.cfg.githubRepos, model: ctx.cfg.geminiModel }
    }
    case 'health_report': return withTask(ctx, action, 'Infrastructure health report', { repo: params.repo || null, branch: params.branch || null }, () => healthReport(ctx, params))
    case 'vercel_status': return withTask(ctx, action, 'Vercel project & deployment status', {}, async () => partReport(ctx, await collectVercel(ctx, { deployments: true, env: false })))
    case 'env_audit': return withTask(ctx, action, 'Environment variable audit', {}, async () => partReport(ctx, await collectVercel(ctx, { deployments: false, env: true })))
    case 'supabase_schema': return withTask(ctx, action, 'Supabase schema inspection', { schema: params.schema || 'ai_control' }, () => schemaReport(ctx, params))
    case 'rls_check': return withTask(ctx, action, 'RLS & permissions verification', {}, async () => partReport(ctx, await collectRls(ctx)))
    case 'request_env_change': return requestEnvChange(ctx, params)
    case 'apply_env_change': return applyEnvChange(ctx, params)
    case 'propose_db_change': return proposeDbChange(ctx, params)
    case 'apply_db_change': return applyDbChange(ctx, params)
    case 'github_branches': { const repo = String(params.repo || ctx.cfg.githubRepos[0] || ''); if (!ctx.cfg.githubRepos.includes(repo)) throw new AgentError('Repo not allowed', 403, 'repo_not_allowed'); return { result: { repo, branches: await new GitHub(ctx.cfg, ctx.calls).branches(repo) } } }
    case 'github_status': return withTask(ctx, action, 'GitHub repository status (read-only)', { repo: params.repo || null, branch: params.branch || null }, () => githubStatus(ctx, params))
    case 'deploy_logs': return withTask(ctx, action, 'Vercel deployment error logs', { project: params.project || null }, () => deployLogs(ctx, params))
    case 'vercel_options': return vercelOptions(ctx)
    case 'request_redeploy': return requestRedeploy(ctx, params)
    case 'project_options': return projectOptions(ctx)
    case 'ai_command': return aiCommand(ctx, params)
    case 'apply_redeploy': return applyRedeploy(ctx, params)
  }
}

export { loadConfig }
