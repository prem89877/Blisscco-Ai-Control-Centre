import type { OrchConfig } from './config.js'
import { AgentError, jfetch, redact, redactString } from '../agent2/util.js'

type Row = Record<string, any>
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
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

  async getWorkflow(id: string): Promise<Row | null> {
    if (!isUuid(id)) throw new AgentError('Bad workflow id', 400, 'bad_id')
    return (await this.rest('GET', `tasks?select=*&id=eq.${id}&payload->>kind=eq.orchestration`))[0] || null
  }

  listWorkflows(n = 30): Promise<Row[]> {
    return this.rest('GET', `tasks?select=*&payload->>kind=eq.orchestration&order=created_at.desc&limit=${Math.min(100, Math.max(1, n))}`)
  }

  // The primary key is the client's request_id, so a double tap / retry can never create a second workflow.
  async createWorkflow(row: Row): Promise<Row> {
    try { return (await this.rest('POST', 'tasks', row))[0] }
    catch (e) { if (e instanceof AgentError && e.code === 'db_conflict') throw new AgentError('This request was already submitted (duplicate request_id)', 409, 'duplicate'); throw e }
  }

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
