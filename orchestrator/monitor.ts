import type { OrchConfig } from './config.js'
import { redactString } from '../agent2/util.js'

type Row = Record<string, any>

// ================================================================ persistent task visibility
// Display retention is NOT an execution timeout: a running task stays visible for as long as it runs. A finished/failed task stays
// visible for at least RETENTION seconds after ITS OWN server-side end timestamp (stored in the workflow row), so a page refresh,
// an app restart or a new device never restarts the countdown. Nothing is deleted: expired entries are only left out of this view;
// the workflow rows, approvals and activity_logs stay as the permanent audit record.
export const MIN_RETENTION_SECONDS = 300
export function retentionSeconds(env: Record<string, string | undefined> = process.env): number {
  const n = Math.floor(Number(env.ORCH_VISIBILITY_SECONDS))
  return Number.isFinite(n) && n > 0 ? Math.min(3600, Math.max(MIN_RETENTION_SECONDS, n)) : MIN_RETENTION_SECONDS // never below five minutes
}

export interface TaskRow { workflow_id: string; workflow_title: string; key: string; name: string; agent: 'agent1' | 'agent2' | 'owner'; status: 'running' | 'waiting' | 'succeeded' | 'failed'; started_at: string | null; finished_at: string | null; duration_ms: number | null; visible_until: string | null; remaining_s: number | null; error?: string }

const ms = (t: unknown): number | null => { const n = t ? new Date(String(t)).getTime() : NaN; return Number.isFinite(n) ? n : null }

// Builds the task list of one workflow from its persisted state. Pure: all times come from the stored row and the server clock.
export function workflowTasks(wf: Row, nowMs: number, retention: number): TaskRow[] {
  const p: Row = wf.payload || {}, s: Row = p.steps || {}, f: Row | null = p.failure || null
  const title = String(wf.title || '').replace(/^Orchestrated: /, '')
  const fallbackEnd = ms(wf.finished_at) ?? ms(wf.updated_at) ?? nowMs
  const failedKey = f ? ({ proposing: 'agent2_propose', applying: 'agent2_apply', ci_waiting: 'ci', ci_passed: 'ci', awaiting_sql: 'sql', applying_sql: 'sql', verifying: 'agent1_verify', awaiting_approval: 'approval' } as Record<string, string>)[String(f.stage)] : ''
  const out: TaskRow[] = []
  const add = (key: string, name: string, agent: TaskRow['agent'], status: TaskRow['status'], start: unknown, end: unknown, error?: string) => {
    const sMs = ms(start), eMs = status === 'running' || status === 'waiting' ? null : (ms(end) ?? fallbackEnd)
    const visibleUntil = eMs == null ? null : eMs + retention * 1000
    if (visibleUntil != null && nowMs > visibleUntil) return // display retention over: hidden here, still in the audit tables
    out.push({
      workflow_id: wf.id, workflow_title: title, key, name, agent, status,
      started_at: sMs != null ? new Date(sMs).toISOString() : null, finished_at: eMs != null ? new Date(eMs).toISOString() : null,
      duration_ms: sMs != null ? Math.max(0, (eMs ?? nowMs) - sMs) : null,
      visible_until: visibleUntil != null ? new Date(visibleUntil).toISOString() : null,
      remaining_s: visibleUntil != null ? Math.max(0, Math.ceil((visibleUntil - nowMs) / 1000)) : null,
      ...(error ? { error: String(error).slice(0, 300) } : {})
    })
  }
  const stepStatus = (key: string, st: Row | undefined): TaskRow['status'] | null => {
    if (!st) return null
    if (f && failedKey === key && p.stage === 'failed') return 'failed'
    if (st.status === 'done') return 'succeeded'
    if (st.status === 'failed') return 'failed'
    if (st.status === 'running') return 'running'
    return null
  }
  const endOf = (key: string, st: Row, ...alts: unknown[]) => (f && failedKey === key && p.stage === 'failed') ? f.at : (st.finished_at || alts.find(Boolean) || null)
  const errOf = (key: string) => (f && failedKey === key && p.stage === 'failed') ? f.message : undefined

  let st = stepStatus('agent2_propose', s.agent2_propose)
  if (st) add('agent2_propose', 'Agent 2: prepare proposal', 'agent2', st, s.agent2_propose.started_at, endOf('agent2_propose', s.agent2_propose), errOf('agent2_propose'))
  if (p.stage === 'awaiting_approval' && s.approval) add('approval', 'Owner: approve code change', 'owner', 'waiting', s.approval.requested_at, null)
  st = stepStatus('agent2_apply', s.agent2_apply)
  if (st) add('agent2_apply', 'Agent 2: commit to agent2/* branch', 'agent2', st, s.agent2_apply.started_at, endOf('agent2_apply', s.agent2_apply), errOf('agent2_apply'))
  if (s.ci) {
    const startCi = s.agent2_apply && s.agent2_apply.finished_at
    if (p.stage === 'ci_waiting') add('ci', 'GitHub CI', 'agent2', 'running', startCi, null)
    else if (s.ci.state === 'passing') add('ci', 'GitHub CI', 'agent2', 'succeeded', startCi, s.ci.checked_at)
    else if (f && failedKey === 'ci' && p.stage === 'failed') add('ci', 'GitHub CI', 'agent2', 'failed', startCi, f.at, f.message)
  }
  if (s.sql) {
    if (p.stage === 'awaiting_sql') add('sql_approval', 'Owner: approve SQL', 'owner', 'waiting', s.sql.started_at, null)
    else if (p.stage === 'applying_sql') add('sql', 'Agent 1: run approved SQL', 'agent1', 'running', s.sql.started_at, null)
    else if (s.sql.status === 'done') add('sql', 'Agent 1: run approved SQL', 'agent1', 'succeeded', s.sql.started_at, s.sql.finished_at)
    else if (f && failedKey === 'sql' && p.stage === 'failed') add('sql', 'Agent 1: run approved SQL', 'agent1', 'failed', s.sql.started_at, f.at, f.message)
  }
  st = stepStatus('agent1_verify', s.agent1_verify)
  if (st) add('agent1_verify', 'Agent 1: verify Supabase / Vercel / GitHub', 'agent1', st, s.agent1_verify.started_at, endOf('agent1_verify', s.agent1_verify), errOf('agent1_verify'))
  else if (p.stage === 'verifying') add('agent1_verify', 'Agent 1: verify Supabase / Vercel / GitHub', 'agent1', 'running', null, null)
  // A failure at a stage without its own step row (e.g. the very first call) must still be shown.
  if (f && p.stage === 'failed' && !out.some(t => t.status === 'failed')) add('failure', 'Workflow stopped at ' + String(f.stage), (f.agent === 'agent1' ? 'agent1' : 'agent2'), 'failed', wf.started_at || wf.created_at, f.at, f.message)
  return out
}

// ================================================================ interrupted workflows / recovery plan
export type RecoveryPlan = { kind: 'retry_read_only' | 'verify_commit' | 'verify_sql' | 'restart'; uncertain: boolean; summary: string }
export function recoveryPlan(failure: Row | null): RecoveryPlan | null {
  if (!failure) return null
  const st = String(failure.stage), code = String(failure.code)
  if (code === 'sql_uncertain' || st === 'applying_sql') return { kind: 'verify_sql', uncertain: true, summary: 'The SQL result is uncertain. Press Verify: the recorded execution state is checked first; if it cannot be proven you confirm what you saw in Supabase. Nothing is re-run blindly.' }
  if (code !== 'interrupted') return null
  if (st === 'ci_waiting' || st === 'verifying' || st === 'ci_passed') return { kind: 'retry_read_only', uncertain: false, summary: 'Only reads. Safe to resume: completed stages are kept and not repeated.' }
  if (st === 'applying') return { kind: 'verify_commit', uncertain: true, summary: 'Agent 2 may or may not have committed. Press Verify: GitHub is checked for the agent2/* branch and commit before anything else happens.' }
  return { kind: 'restart', uncertain: false, summary: 'Nothing was written to GitHub or the database. Upload / start the change again.' }
}

// ================================================================ agent / integration health (lightweight, cached, bounded)
export type HState = 'healthy' | 'busy' | 'unavailable' | 'failed' | 'unknown'
export interface HItem { state: HState; reason?: string; latency_ms?: number; checked_at: string; cached: boolean }

const cache = new Map<string, { at: number; fails: number; item: Omit<HItem, 'cached'> }>()
export const resetHealthCache = () => cache.clear()
const TTL: Record<string, number> = { orchestrator: 30_000, supabase: 60_000, github: 60_000, vercel: 300_000, gemini: 300_000 }

// Re-check interval: healthy results are reused for the TTL; a failing component backs off exponentially (30s, 60s, ... max 5 min)
// so a dead service is not hammered. Every probe has its own short timeout.
function ttlFor(name: string, e: { fails: number; item: Omit<HItem, 'cached'> }, env: Record<string, string | undefined>): number {
  const scale = Number(env.ORCH_HEALTH_TTL_SCALE); const k = Number.isFinite(scale) && scale >= 0 ? scale : 1
  if (e.item.state === 'healthy' || e.item.state === 'unknown' || e.item.state === 'busy') return (TTL[name] || 60_000) * k
  return Math.min(300_000, 30_000 * 2 ** Math.max(0, e.fails - 1)) * k
}

async function probe(name: string, env: Record<string, string | undefined>, nowMs: number, fn: () => Promise<{ state: HState; reason?: string }>): Promise<HItem> {
  const c = cache.get(name)
  if (c && nowMs - c.at < ttlFor(name, c, env)) return { ...c.item, cached: true }
  const t0 = Date.now()
  let r: { state: HState; reason?: string }
  try { r = await fn() } catch (e) { r = { state: 'unavailable', reason: (e as Error).name === 'TimeoutError' ? 'timeout' : 'network error' } }
  const item = { ...r, latency_ms: Date.now() - t0, checked_at: new Date(nowMs).toISOString() }
  cache.set(name, { at: nowMs, fails: item.state === 'healthy' ? 0 : (c ? c.fails + 1 : 1), item })
  return { ...item, cached: false }
}
const byStatus = (s: number, ok: number[] = [200]): { state: HState; reason?: string } => ok.includes(s) ? { state: 'healthy' } : s === 401 || s === 403 ? { state: 'failed', reason: 'credentials rejected (' + s + ')' } : s === 429 ? { state: 'busy', reason: 'rate limited' } : s >= 500 ? { state: 'unavailable', reason: 'service error (' + s + ')' } : { state: 'failed', reason: 'unexpected status ' + s }
const TIMEOUT = 4000

export async function healthReport(cfg: OrchConfig, running: { agent1: boolean; agent2: boolean }, env: Record<string, string | undefined> = process.env, nowMs = Date.now()) {
  const c1 = cfg.c1, c2 = cfg.c2
  const unknown = (reason: string): HItem => ({ state: 'unknown', reason, checked_at: new Date(nowMs).toISOString(), cached: false })
  const sig = () => AbortSignal.timeout(TIMEOUT)
  const [supabase, github, vercel, gemini] = await Promise.all([
    probe('supabase', env, nowMs, async () => { const r = await fetch(`${cfg.supabaseUrl}/rest/v1/agents?select=id&limit=1`, { headers: { apikey: cfg.serviceKey, Authorization: 'Bearer ' + cfg.serviceKey, 'Accept-Profile': 'ai_control' }, signal: sig() }); return byStatus(r.status) }),
    c2.githubToken ? probe('github', env, nowMs, async () => { const r = await fetch('https://api.github.com/rate_limit', { headers: { Authorization: 'Bearer ' + c2.githubToken, Accept: 'application/vnd.github+json' }, signal: sig() }); if (r.status === 200) { const j: any = await r.json().catch(() => ({})); const rem = j && j.resources && j.resources.core && j.resources.core.remaining; return rem === 0 ? { state: 'busy' as HState, reason: 'API rate limit reached' } : { state: 'healthy' as HState } } return byStatus(r.status) }) : Promise.resolve(unknown('not configured')),
    c1.vercelToken ? probe('vercel', env, nowMs, async () => { const r = await fetch('https://api.vercel.com/v9/projects?limit=1', { headers: { Authorization: 'Bearer ' + c1.vercelToken }, signal: sig() }); return byStatus(r.status) }) : Promise.resolve(unknown('not configured')),
    c2.geminiKey ? probe('gemini', env, nowMs, async () => { const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': c2.geminiKey as string }, signal: sig() }); return r.status === 400 ? { state: 'failed' as HState, reason: 'credentials rejected (400)' } : byStatus(r.status) }) : Promise.resolve(unknown('not configured'))
  ])
  const orchestrator: HItem = supabase.state === 'healthy' ? { ...supabase, reason: undefined } : { ...supabase, state: supabase.state === 'busy' ? 'busy' : supabase.state === 'unavailable' ? 'unavailable' : 'failed', reason: 'workflow database: ' + (supabase.reason || supabase.state) }
  const bad = (x: HItem) => x.state === 'failed' || x.state === 'unavailable'
  const derive = (deps: HItem[], isRunning: boolean, label: string, configured: boolean): HItem => {
    if (!configured) return unknown('not configured')
    const worst = deps.find(d => d.state === 'failed') || deps.find(d => d.state === 'unavailable')
    if (worst) return { state: worst.state, reason: label + ' depends on an unhealthy integration: ' + (worst.reason || worst.state), checked_at: worst.checked_at, cached: worst.cached }
    if (isRunning) return { state: 'busy', reason: 'working on a workflow stage', checked_at: new Date(nowMs).toISOString(), cached: false }
    if (deps.every(d => d.state === 'unknown')) return unknown('integrations not verified')
    return { state: 'healthy', checked_at: new Date(nowMs).toISOString(), cached: false }
  }
  const a2 = derive([github, supabase], running.agent2, 'Agent 2', Boolean(c2.githubToken))
  const a1deps = [supabase, ...(c1.vercelToken ? [vercel] : []), ...(c1.githubToken ? [github] : [])]
  const a1 = derive(a1deps, running.agent1, 'Agent 1', Boolean(c1.vercelToken || c1.supaToken || c1.githubToken))
  void bad
  const clean = (x: HItem): HItem => ({ ...x, reason: x.reason ? redactString(x.reason, cfg.secrets) : undefined })
  return {
    generated_at: new Date(nowMs).toISOString(),
    // Agent 3 is deliberately NOT probed or started here: it is independent and runs only when the owner starts it.
    components: { orchestrator: clean(orchestrator), agent1: clean(a1), agent2: clean(a2), gemini: clean(gemini), github: clean(github), supabase: clean(supabase), vercel: clean(vercel) },
    agent3: { independent: true, note: 'Not monitored or started by the Orchestrator. Start it manually.' },
    polling: { cache_seconds: { healthy: { orchestrator: 30, supabase: 60, github: 60, vercel: 300, gemini: 300 }, failing: 'exponential backoff 30s to 300s' }, probe_timeout_ms: TIMEOUT }
  }
}
