import type { Config } from './config.js'
import { secretValues } from './config.js'
import { AgentError, jfetch, redact, redactString } from './util.js'

type Row = Record<string, any>
export const AGENT_NAME = 'QA, Testing & Security Agent'
export const AGENT_DESC = 'Read-only QA: website, API, database and security testing with evidence reports. Never bills, never writes to production. Sensitive tests need approval.'

// Talks to ai_control via PostgREST with the service-role key (server side only).
export class Store {
  agent: Row | null = null
  constructor(private cfg: Config) {}

  private clean<T>(x: T): T { return redact(x, secretValues(this.cfg)) }

  private async rest(method: string, path: string, body?: unknown): Promise<Row[]> {
    const k = this.cfg.serviceKey
    const r = await jfetch(`${this.cfg.supabaseUrl}/rest/v1/${path}`, {
      method,
      headers: { apikey: k, Authorization: 'Bearer ' + k, 'Accept-Profile': 'ai_control', 'Content-Profile': 'ai_control', 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: body === undefined ? undefined : JSON.stringify(this.clean(body))
    })
    if (!r.ok) throw new AgentError(`Database error ${r.status}: ${redactString(String((r.body && r.body.message) || 'request failed'), secretValues(this.cfg))}`, 502, 'db')
    return Array.isArray(r.body) ? r.body : r.body ? [r.body] : []
  }

  async verifyOwner(token: string): Promise<string> {
    const k = this.cfg.serviceKey
    const u = await jfetch(`${this.cfg.supabaseUrl}/auth/v1/user`, { headers: { apikey: k, Authorization: 'Bearer ' + token } })
    if (!u.ok || !u.body || !u.body.id) throw new AgentError('Unauthorized', 401, 'unauthorized')
    const own = await this.rest('GET', `owners?select=role&user_id=eq.${encodeURIComponent(u.body.id)}&role=in.(owner,admin)`)
    if (!own.length) throw new AgentError('Forbidden', 403, 'forbidden')
    return u.body.id
  }

  async ensureAgent(): Promise<Row> {
    if (this.agent) return this.agent
    let rows = await this.rest('GET', 'agents?select=*&slot=eq.3')
    if (!rows.length) rows = await this.rest('POST', 'agents', { slot: 3, name: AGENT_NAME, description: AGENT_DESC })
    let a = rows[0]
    if (a.name === 'Agent 3' || String(a.description || '').startsWith('Placeholder')) {
      const up = await this.rest('PATCH', `agents?id=eq.${a.id}`, { name: AGENT_NAME, description: AGENT_DESC, config: { kind: 'qa_security', version: '1.0.0', mode: 'read_only_approval_gated' } })
      a = up[0] || a
    }
    this.agent = a
    return a
  }

  async setStatus(status: 'idle' | 'running' | 'error') {
    const a = await this.ensureAgent()
    await this.rest('PATCH', `agents?id=eq.${a.id}`, { status, last_heartbeat_at: new Date().toISOString() })
  }

  // Heartbeat: keeps the agent "online" in the dashboard without overriding a live run or a real error.
  async heartbeat() {
    const a = await this.ensureAgent()
    const fresh = (await this.rest('GET', `agents?select=*&id=eq.${a.id}`))[0] || a
    const staleRun = fresh.status === 'running' && Date.now() - new Date(fresh.updated_at).getTime() > 120000
    const patch: Row = { last_heartbeat_at: new Date().toISOString() }
    if (fresh.status === 'offline' || staleRun) patch.status = 'idle'
    const up = await this.rest('PATCH', `agents?id=eq.${a.id}`, patch)
    return up[0] || fresh
  }

  async createTask(t: Row): Promise<Row> {
    const a = await this.ensureAgent()
    return (await this.rest('POST', 'tasks', { ...t, agent_id: a.id, priority: 2 }))[0]
  }
  async getTask(id: string): Promise<Row | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AgentError('Bad task id', 400)
    return (await this.rest('GET', `tasks?select=*&id=eq.${id}`))[0] || null
  }
  // Approvals of one kind for one branch (newest first). Used to find the change/promote records for rollback.
  findApprovals(kind: string, branch: string): Promise<Row[]> {
    return this.rest('GET', `approvals?select=*&details->>kind=eq.${encodeURIComponent(kind)}&details->>branch=eq.${encodeURIComponent(branch)}&order=requested_at.desc`)
  }
  updateTask(id: string, patch: Row) { return this.rest('PATCH', `tasks?id=eq.${id}`, patch) }

  async log(level: 'info' | 'success' | 'warn' | 'error', action: string, message: string, metadata: Row = {}, taskId: string | null = null, actorId: string | null = null) {
    const a = await this.ensureAgent()
    try {
      await this.rest('POST', 'activity_logs', { agent_id: a.id, task_id: taskId, actor_type: 'agent', actor_id: actorId, level, action, message, metadata })
    } catch (e) { console.error('agent3 log failed:', (e as Error).message) }
  }

  async usage(u: { provider: string; model?: string | null; endpoint: string; request_count?: number; tokens_in?: number; tokens_out?: number; status_code?: number | null; cost_estimate?: number }) {
    const a = await this.ensureAgent()
    try { await this.rest('POST', 'api_usage', { agent_id: a.id, request_count: 1, ...u }) } catch (e) { console.error('agent3 usage failed:', (e as Error).message) }
  }

  async health(rows: { component: string; status: 'ok' | 'degraded' | 'down'; latency_ms?: number; details?: Row }[]) {
    if (!rows.length) return
    try { await this.rest('POST', 'system_health', rows) } catch (e) { console.error('agent3 health failed:', (e as Error).message) }
  }

  async createApproval(a: { task_id: string; title: string; details: Row }): Promise<Row> {
    const ag = await this.ensureAgent()
    return (await this.rest('POST', 'approvals', { ...a, agent_id: ag.id }))[0]
  }
  async getApproval(id: string): Promise<Row | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AgentError('Bad approval id', 400)
    return (await this.rest('GET', `approvals?select=*&id=eq.${id}`))[0] || null
  }
  // Conditional patch: only applies while details.executed_at is still null (prevents double execution).
  async claimApproval(id: string, details: Row): Promise<boolean> {
    const rows = await this.rest('PATCH', `approvals?id=eq.${id}&details->>executed_at=is.null`, { details })
    return rows.length > 0
  }
  patchApproval(id: string, patch: Row) { return this.rest('PATCH', `approvals?id=eq.${id}`, patch) }
}
