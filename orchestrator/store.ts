import { createHash } from 'node:crypto'
import type { OrchConfig } from './config.js'
import { AgentError, jfetch, redact, redactString } from '../agent2/util.js'

type Row = Record<string, any>
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Deterministic UUID from a lock key: the SAME key always maps to the SAME tasks.id (primary key) -> DB-level uniqueness.
export function lockId(key: string): string {
  const h = createHash('sha256').update('blisscco-lock:' + key).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID.test(s)

// The Orchestrator keeps its workflows in the EXISTING ai_control.tasks table
// (payload.kind = 'orchestration'). No new tables, no new approval system.
export class OStore {
  constructor(private cfg: OrchConfig) {}

  private clean<T>(x: T): T { return redact(x, this.cfg.secrets) }

  private async rest(method: string, path: string, body?: unknown): Promise<Row[]> {
    const k = this.cfg.serviceKey
    const r = await jfetch(`${this.cfg.supabaseUrl}/rest/v1/${path}`, {
      method,
      headers: { apikey: k, Authorization: 'Bearer ' + k, 'Accept-Profile': 'ai_control', 'Content-Profile': 'ai_control', 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: body === undefined ? undefined : JSON.stringify(this.clean(body))
    })
    if (!r.ok) {
      const msg = redactString(String((r.body && r.body.message) || 'request failed'), this.cfg.secrets)
      throw new AgentError(`Database error ${r.status}: ${msg}`, r.status === 409 ? 409 : 502, r.status === 409 ? 'db_conflict' : 'db')
    }
    return Array.isArray(r.body) ? r.body : r.body ? [r.body] : []
  }

  // Same owner check as Agent 1 / Agent 2: valid session AND listed in ai_control.owners (owner/admin).
  async verifyOwner(token: string): Promise<string> {
    const k = this.cfg.serviceKey
    const u = await jfetch(`${this.cfg.supabaseUrl}/auth/v1/user`, { headers: { apikey: k, Authorization: 'Bearer ' + token } })
    if (!u.ok || !u.body || !u.body.id) throw new AgentError('Unauthorized', 401, 'unauthorized')
    const own = await this.rest('GET', `owners?select=role&user_id=eq.${encodeURIComponent(u.body.id)}&role=in.(owner,admin)`)
    if (!own.length) throw new AgentError('Forbidden', 403, 'forbidden')
    return u.body.id
  }

  // True only for a user listed in ai_control.owners with role owner/admin (used to accept an approval decision).
  async isOwner(userId: string): Promise<boolean> {
    if (!userId) return false
    return (await this.rest('GET', `owners?select=role&user_id=eq.${encodeURIComponent(userId)}&role=in.(owner,admin)`)).length > 0
  }

  async getWorkflow(id: string): Promise<Row | null> {
    if (!isUuid(id)) throw new AgentError('Bad workflow id', 400, 'bad_id')
    return (await this.rest('GET', `tasks?select=*&id=eq.${id}&payload->>kind=eq.orchestration&payload->>deleted=is.null`))[0] || null // a deleted workflow behaves as not found
  }

  listWorkflows(n = 30): Promise<Row[]> {
    return this.rest('GET', `tasks?select=*&payload->>kind=eq.orchestration&payload->>deleted=is.null&order=created_at.desc&limit=${Math.min(100, Math.max(1, n))}`)
  }

  // Workflows that are not finished yet, whatever their age (so a long-running or forgotten one is never missed by a "latest N" list).
  listActiveWorkflows(): Promise<Row[]> {
    return this.rest('GET', 'tasks?select=*&payload->>kind=eq.orchestration&payload->>deleted=is.null&status=in.(running,awaiting_approval)&order=created_at.desc&limit=100')
  }
  // Persisted approval state (the ONLY source of the pending indicator): every approval whose status is still 'pending'.
  async listPendingApprovals(): Promise<Row[]> {
    return this.rest('GET', 'approvals?select=id,title,task_id,agent_id,requested_at,details&status=eq.pending&order=requested_at.desc&limit=100')
  }
  async getTaskRow(id: string): Promise<Row | null> {
    if (!isUuid(id)) return null
    return (await this.rest('GET', `tasks?select=id,status,result,finished_at&id=eq.${id}`))[0] || null
  }

  // The primary key is the client's request_id, so a double tap / retry can never create a second workflow.
  async createWorkflow(row: Row): Promise<Row> {
    try { return (await this.rest('POST', 'tasks', row))[0] }
    catch (e) { if (e instanceof AgentError && e.code === 'db_conflict') throw new AgentError('This request was already submitted (duplicate request_id)', 409, 'duplicate'); throw e }
  }

  // ---- Durable locks (existing ai_control.tasks table, payload.kind = 'orchestration_lock'; never listed as a workflow).
  // The row id is derived from the key, so the primary key makes the claim atomic and permanent (no 100-row window, no race).
  async claimLock(key: string, lock: string, data: Row): Promise<boolean> {
    try {
      await this.rest('POST', 'tasks', { id: lockId(key), title: 'Lock: ' + lock, description: 'Orchestrator durable duplicate protection', status: 'succeeded', priority: 5, payload: { kind: 'orchestration_lock', lock, key, ...data } })
      return true
    } catch (e) { if (e instanceof AgentError && e.code === 'db_conflict') return false; throw e }
  }
  async getLock(key: string): Promise<Row | null> {
    return (await this.rest('GET', `tasks?select=*&id=eq.${lockId(key)}&payload->>kind=eq.orchestration_lock`))[0] || null
  }
  // Takeover/update only while payload.holder is still what the caller saw (atomic compare-and-set).
  async casLock(key: string, holder: string, patch: Row): Promise<boolean> {
    const cur = await this.getLock(key)
    if (!cur) return false
    const rows = await this.rest('PATCH', `tasks?id=eq.${lockId(key)}&payload->>kind=eq.orchestration_lock&payload->>holder=eq.${encodeURIComponent(holder)}`, { payload: { ...cur.payload, ...patch } })
    return rows.length > 0
  }

  // Locks (zip / commit / sql) currently held by one workflow.
  listLocksByHolder(holder: string): Promise<Row[]> {
    if (!isUuid(holder)) return Promise.resolve([])
    return this.rest('GET', `tasks?select=id,payload&payload->>kind=eq.orchestration_lock&payload->>holder=eq.${holder}&limit=200`)
  }
  // Removes a lock only while this holder still owns it (so another workflow's lock can never be deleted by mistake).
  async deleteLock(id: string, holder: string): Promise<boolean> {
    if (!isUuid(id) || !isUuid(holder)) return false
    return (await this.rest('DELETE', `tasks?id=eq.${id}&payload->>kind=eq.orchestration_lock&payload->>holder=eq.${holder}`)).length > 0
  }
  // NOTE: a workflow row is never hard-deleted: activity_logs is append-only (its task_id foreign key cannot be nulled), so "delete" marks
  // payload.deleted and every list / get above hides it. Only the lock rows (no log references) are really removed.

  // Optimistic lock: applies only while payload.rev is unchanged. Returns null if somebody else moved the workflow.
  async casUpdate(id: string, rev: number, patch: Row): Promise<Row | null> {
    const rows = await this.rest('PATCH', `tasks?id=eq.${id}&payload->>kind=eq.orchestration&payload->>rev=eq.${rev}`, patch)
    return rows[0] || null
  }

  async getApproval(id: string): Promise<Row | null> {
    if (!isUuid(id)) throw new AgentError('Bad approval id', 400, 'bad_id')
    return (await this.rest('GET', `approvals?select=*&id=eq.${id}`))[0] || null
  }

  async log(level: 'info' | 'success' | 'warn' | 'error', action: string, message: string, metadata: Row = {}, taskId: string | null = null, userId: string | null = null) {
    try { await this.rest('POST', 'activity_logs', { agent_id: null, task_id: taskId, actor_type: 'system', actor_id: null, level, action, message, metadata: { ...metadata, user_id: userId } }) }
    catch (e) { console.error('orchestrator log failed:', (e as Error).message) }
  }
}
