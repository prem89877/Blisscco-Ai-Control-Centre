import { isSensitivePath } from '../agent2/guard.js'

type Row = Record<string, any>

// ---------------------------------------------------------------- routing: which agent handles which stage, and who may move it on
// auto = the Orchestrator moves on by itself once the prerequisite is met (no owner action).
// gate = what must exist first. The Orchestrator never creates, edits or decides an approval itself.
export const ROUTES = {
  proposing:         { agent: 'agent2', action: 'propose_change / ai_fix', auto: true,  gate: null },
  awaiting_approval: { agent: 'agent2', action: 'apply_change',            auto: true,  gate: 'owner approval of the code change (mandatory); sensitive files also need an explicit confirmation' },
  applying:          { agent: 'agent2', action: 'apply_change',            auto: true,  gate: null },
  ci_waiting:        { agent: 'agent2', action: 'actions_status',          auto: true,  gate: null },
  awaiting_sql:      { agent: 'agent1', action: 'apply_db_change',         auto: true,  gate: 'owner approval of every SQL file; destructive SQL needs an explicit destructive confirmation' },
  applying_sql:      { agent: 'agent1', action: 'apply_db_change',         auto: true,  gate: null },
  ci_passed:         { agent: 'agent1', action: 'health_report',           auto: true,  gate: 'CI passed and all SQL applied' },
  verifying:         { agent: 'agent1', action: 'health_report',           auto: true,  gate: null }
} as const

// What always needs the authorized owner. Anything not matching is routine and proceeds automatically.
export const SENSITIVE_OPERATIONS = [
  'secrets or credentials (access or change)',
  'security policy or authentication changes',
  'owner permissions or privileged access',
  'destructive database operations (DELETE / UPDATE / ALTER ... DROP / ALTER COLUMN TYPE)',
  'production environment changes',
  'billing, payout, ledger or financial data',
  'protected-branch merge or production promotion',
  'irreversible operations or operations with significant security impact'
] as const

// Orchestrator-level additions on top of Agent 2's own sensitive-path list (never replaces it).
const EXTRA_SENSITIVE = [/^api\//, /^orchestrator\//, /(^|\/)supabaseClient\.[jt]sx?$/, /(^|\/)(auth|login|security|permissions?|owners?|rls|polic(y|ies)|billing|payouts?|ledger|secrets?|credentials?)([./_-]|$)/i]
export const isSensitiveCodePath = (p: string): boolean => isSensitivePath(p) || EXTRA_SENSITIVE.some(r => r.test(p))
export const sensitivePathsOf = (paths: string[]): string[] => [...new Set(paths.filter(isSensitiveCodePath))]

// Paths an uploaded ZIP may NEVER create, update or delete: they hold the deployment workflow's own security rules
// (Orchestrator, Agent 1/2 guards and allow-lists, API entry points that enforce owner auth, CI/CD workflows, RLS/SQL).
// These are refused outright (not merely "sensitive + confirmation"). Change them through a normal reviewed commit instead.
export const ZIP_PROTECTED_PATHS: RegExp[] = [/^orchestrator\//i, /^agent1\//i, /^agent2\//i, /^api\//i, /^\.github\//i, /^supabase\//i, /^\.blisscco\//i]
export const protectedZipPaths = (paths: string[], extra: string[] = []): string[] => {
  const ex = extra.map(x => x.trim().toLowerCase().replace(/^\/+/, '')).filter(Boolean)
  return [...new Set(paths.filter(p => ZIP_PROTECTED_PATHS.some(r => r.test(p)) || ex.some(e => p.toLowerCase() === e || p.toLowerCase().startsWith(e.endsWith('/') ? e : e + '/'))))]
}

// SQL outcome classification. Only a failure that PROVES nothing ran (a refusal before execution, or a SQL error inside the
// single rolled-back transaction) may release the durable lock. Anything else (timeout, 5xx, network, already claimed) is UNCERTAIN:
// the lock stays claimed, nothing is repeated automatically, and the owner must verify the database state first.
export function sqlOutcomeIsDefinitive(e: { status?: number; code?: string; message?: string }): boolean {
  const c = String(e.code || '')
  if (c === 'already_executed') return false
  // Supabase answered 4xx (except 408) = it rejected/errored the statement; BEGIN...COMMIT is one transaction, so it rolled back.
  // 5xx, status 0 (timeout / network) or an unparseable answer = the outcome is unknown.
  if (c === 'sql_failed') { const m = /Supabase (\d{3})\b/.exec(String(e.message || '')); const s = m ? Number(m[1]) : 0; return s >= 400 && s < 500 && s !== 408 }
  if (['db_ack', 'not_approved', 'expired', 'db_change_blocked', 'not_configured', 'supa_auth', 'action_not_allowed'].includes(c)) return true // refused before anything ran
  return false
}

// ---------------------------------------------------------------- transient vs permanent errors (only READ-ONLY stages are ever retried automatically)
export function isTransient(e: { status?: number; code?: string; message?: string }): boolean {
  const s = Number(e.status) || 0, c = String(e.code || ''), m = String(e.message || '')
  if (c === 'not_configured' || c === 'github_auth' || c === 'github_denied') return false // permanent: fix configuration / token
  if (s === 429 || s === 503 || s === 504) return true
  if (['github_read', 'timeout', 'fetch_failed', 'network'].includes(c)) return true
  return /GitHub API (5\d\d|429)\b|timed? ?out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|temporarily unavailable/i.test(m)
}
export const MAX_AUTO_RETRIES = 3

// Controlled retry for READ-ONLY calls only: configurable attempts, exponential backoff, a hard maximum total duration.
// env: ORCH_RETRY_MAX_ATTEMPTS (1-6, default 3), ORCH_RETRY_BASE_MS (0-10000, default 250), ORCH_RETRY_MAX_TOTAL_MS (0-60000, default 15000)
export function retryPolicy(env: Record<string, string | undefined> = process.env) {
  const num = (raw: string | undefined, def: number, lo: number, hi: number) => { const n = Math.floor(Number(raw)); return raw !== undefined && raw !== '' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def }
  return { maxAttempts: num(env.ORCH_RETRY_MAX_ATTEMPTS, 3, 1, 6), baseMs: num(env.ORCH_RETRY_BASE_MS, 250, 0, 10000), maxTotalMs: num(env.ORCH_RETRY_MAX_TOTAL_MS, 15000, 0, 60000) }
}
export const backoffMs = (attempt: number, baseMs: number): number => Math.min(10000, baseMs * 2 ** attempt)

// Stages whose repeat is harmless (they only READ). commit / SQL stages are never retried automatically.
export const RETRYABLE_STAGES = ['ci_waiting', 'verifying'] as const
export const NEVER_RETRY_CODES = ['ci_failed', 'already_executed', 'sql_duplicate', 'sql_checksum', 'approval_mismatch', 'approval_rejected', 'approval_expired', 'sql_approval_rejected', 'sql_approval_expired', 'expired', 'cancelled', 'approval_not_owner', 'sql_uncertain', 'protected_path', 'commit_duplicate']

// ---------------------------------------------------------------- recovery guidance (shown only for failures)
export function recoveryFor(f: { stage?: string; agent?: string; code?: string } | null): string {
  if (!f) return ''
  const c = String(f.code || ''), st = String(f.stage || '')
  if (c === 'ci_failed') return 'Fix the failing GitHub Actions job on the agent2/* branch (see the error above), then upload a corrected change as a new workflow. The failed commit is never promoted.'
  if (/^(sql_)?approval_rejected$|^sql_approval_rejected$/.test(c)) return 'The owner rejected this. Nothing was applied. Change the request and start a new workflow if you still want it.'
  if (/approval_expired|^expired$|sql_approval_expired/.test(c)) return 'The approval expired or is older than 24 hours. Nothing was applied. Start the workflow again and approve it promptly.'
  if (c === 'interrupted') return RETRYABLE_STAGES.includes(st as any)
    ? 'The step was interrupted. It only reads, so it is safe to press Retry.'
    : 'The step was interrupted and may have partly run. Check the agent task, the agent2/* branch or Supabase first. It is NOT retried automatically; start a new workflow if nothing was applied.'
  if (c === 'duplicate_zip' || c === 'sql_duplicate' || c === 'already_executed') return 'This exact change was already submitted or executed, so it was blocked to avoid running twice. Open the earlier workflow instead.'
  if (c === 'sql_uncertain') return 'The result of this SQL run is UNCERTAIN (timeout / network / server error). It was NOT repeated and its lock stays in place. In Supabase check whether the migration was applied (look for the objects it creates). If it was applied, continue manually; if it was not, upload a corrected migration as a new ZIP (new checksum) after confirming nothing ran.'
  if (c === 'commit_duplicate') return 'An identical change set was already committed by another workflow, so it was blocked to avoid a duplicate commit. Open the earlier workflow and its agent2/* branch instead.'
  if (c === 'sql_checksum') return 'The approved SQL no longer matches the uploaded file. Nothing ran. Upload the ZIP again and approve the new SQL.'
  if (c === 'approval_not_owner') return 'The approval was not decided by an authorized owner, so it was not accepted. An owner must decide it in the Approvals tab.'
  if (c === 'base_changed') return 'The base branch moved after you uploaded. Upload again so the change is built on the latest commit.'
  if (st === 'applying_sql' || st === 'awaiting_sql') return 'Earlier migrations in this run are not rolled back automatically. Check Supabase, then fix the SQL and upload it as a new workflow (a failed, rolled-back migration is released for retry). Later files were not run.'
  if (st === 'applying' || st === 'proposing') return 'Agent 2 stopped before finishing. No production change was made. Check the agent2/* branch on GitHub, then start a new workflow.'
  if (st === 'ci_waiting') return 'Could not read CI status. Press Retry (read-only) once GitHub is reachable.'
  if (st === 'verifying') return 'Agent 1 could not finish verifying. Press Retry (read-only) or check Vercel / Supabase / GitHub access in Settings.'
  return 'Read the error above, fix the cause, then start a new workflow. Nothing was promoted to production.'
}

// ---------------------------------------------------------------- task pipeline (dependencies) derived from stored state; nothing extra is stored
export interface TaskView { key: string; name: string; agent: 'agent1' | 'agent2' | 'owner'; status: 'Successful' | 'Running' | 'Waiting for owner' | 'Failed' | 'Blocked' | 'Not started' | 'Cancelled'; depends_on: string[]; blocked_by?: string }

export function pipeline(p: Row): TaskView[] {
  const s: Row = p.steps || {}, stage = String(p.stage || '')
  const hasSql = (((p.zip && p.zip.sql) || []) as Row[]).some(x => x.status === 'reviewed')
  const failedStage = p.failure ? stepOf(String(p.failure.stage || '')) : ''
  const def: { key: string; name: string; agent: TaskView['agent']; deps: string[]; done: boolean; running: boolean; waiting: boolean }[] = [
    { key: 'agent2_propose', name: 'Agent 2: prepare proposal', agent: 'agent2', deps: [], done: s.agent2_propose && s.agent2_propose.status === 'done', running: stage === 'proposing', waiting: false },
    { key: 'approval', name: 'Owner: approve code change', agent: 'owner', deps: ['agent2_propose'], done: !!(s.approval && s.approval.status === 'approved' && s.agent2_apply), running: false, waiting: stage === 'awaiting_approval' },
    { key: 'agent2_apply', name: 'Agent 2: commit to agent2/* branch', agent: 'agent2', deps: ['approval'], done: s.agent2_apply && s.agent2_apply.status === 'done', running: stage === 'applying', waiting: false },
    { key: 'ci', name: 'GitHub CI', agent: 'agent2', deps: ['agent2_apply'], done: !!(s.ci && s.ci.state === 'passing'), running: stage === 'ci_waiting', waiting: false },
    ...(hasSql ? [
      { key: 'sql_approval', name: 'Owner: approve SQL', agent: 'owner' as const, deps: ['ci'], done: !!(s.sql && ['done'].includes(s.sql.status)) || ['applying_sql'].includes(stage) || (s.sql && s.sql.status === 'running'), running: false, waiting: stage === 'awaiting_sql' },
      { key: 'sql', name: 'Agent 1: run approved SQL', agent: 'agent1' as const, deps: ['sql_approval'], done: !!(s.sql && s.sql.status === 'done'), running: stage === 'applying_sql', waiting: false }
    ] : []),
    { key: 'agent1_verify', name: 'Agent 1: verify', agent: 'agent1', deps: hasSql ? ['sql'] : ['ci'], done: s.agent1_verify && s.agent1_verify.status === 'done', running: stage === 'verifying', waiting: false }
  ]
  const byKey = new Map<string, TaskView>()
  const out: TaskView[] = []
  for (const d of def) {
    let status: TaskView['status'] = 'Not started'
    let blocked: string | undefined
    const failedHere = (p.stage === 'failed' || p.stage === 'cancelled') && (failedStage === d.key || (d.key === 'sql' && failedStage === 'sql') || (d.key === 'sql_approval' && failedStage === 'sql' && s.sql && s.sql.status !== 'failed' && !(s.sql.items || []).some((i: Row) => i.status === 'failed')))
    if (d.done) status = 'Successful'
    else if (failedHere) status = p.stage === 'cancelled' ? 'Cancelled' : 'Failed'
    else if (d.running) status = 'Running'
    else if (d.waiting) status = 'Waiting for owner'
    else {
      const bad = d.deps.map(k => byKey.get(k)).find(t => t && (t.status === 'Failed' || t.status === 'Blocked' || t.status === 'Cancelled'))
      if (bad) { status = 'Blocked'; blocked = bad.key }
    }
    const t: TaskView = { key: d.key, name: d.name, agent: d.agent, status, depends_on: d.deps, ...(blocked ? { blocked_by: blocked } : {}) }
    byKey.set(d.key, t); out.push(t)
  }
  return out
}

export function stepOf(stage: string): string {
  return ({ proposing: 'agent2_propose', awaiting_approval: 'approval', applying: 'agent2_apply', ci_waiting: 'ci', awaiting_sql: 'sql', applying_sql: 'sql', ci_passed: 'ci', verifying: 'agent1_verify' } as Record<string, string>)[stage] || 'none'
}
