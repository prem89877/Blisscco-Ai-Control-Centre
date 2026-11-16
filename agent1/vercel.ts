import type { Config } from './config.js'
import { AgentError, jfetch } from './util.js'
import type { DeployItem, EnvItem } from './checks.js'

export interface VProject { id: string; name: string; framework: string | null; repo: string | null }

const BASE = 'https://api.vercel.com'

export class Vercel {
  constructor(private cfg: Config, private calls: Record<string, number>) {}

  private async call(method: string, path: string, q: Record<string, string | number> = {}, body?: unknown) {
    if (!this.cfg.vercelToken) throw new AgentError('AGENT1_VERCEL_TOKEN is not set', 503, 'not_configured')
    const u = new URL(BASE + path)
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, String(v))
    if (this.cfg.vercelTeamId) u.searchParams.set('teamId', this.cfg.vercelTeamId)
    this.calls.vercel = (this.calls.vercel || 0) + 1
    const init = {
      method,
      headers: { Authorization: 'Bearer ' + this.cfg.vercelToken, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }
    let r
    try { r = await jfetch(u.toString(), init, 30000) } // slow mobile networks: 30s
    catch (e) { if (method !== 'GET') throw e; r = await jfetch(u.toString(), init, 30000) } // one retry, reads only
    if (r.status === 401 || r.status === 403) throw new AgentError('Vercel token invalid or lacks access (' + r.status + ')', 502, 'vercel_auth')
    if (!r.ok) throw new AgentError('Vercel API ' + r.status + ': ' + String(r.body && r.body.error && r.body.error.message || 'request failed'), 502, 'vercel')
    return r.body
  }

  async listProjects(): Promise<VProject[]> {
    const b = await this.call('GET', '/v9/projects', { limit: 100 })
    const all: VProject[] = (b.projects || []).map((p: any) => ({
      id: p.id, name: p.name, framework: p.framework || null,
      repo: p.link && p.link.repo ? (p.link.org ? p.link.org + '/' : '') + p.link.repo : null
    }))
    const want = this.cfg.vercelProjects
    return want.length ? all.filter(p => want.includes(p.name) || want.includes(p.id)) : all
  }

  async listDeployments(projectId: string, limit = 8): Promise<DeployItem[]> {
    const b = await this.call('GET', '/v6/deployments', { projectId, limit })
    const items: DeployItem[] = (b.deployments || []).map((d: any) => ({
      id: d.uid, state: d.readyState || d.state || 'UNKNOWN', target: d.target || 'preview',
      createdAt: d.created || d.createdAt || 0, error: null,
      branch: d.meta && d.meta.githubCommitRef || null
    }))
    for (const d of items.filter(x => x.state === 'ERROR').slice(0, 2)) {
      try {
        const one = await this.call('GET', '/v13/deployments/' + d.id)
        d.error = one.errorMessage || one.errorCode || null
      } catch { /* detail is optional */ }
    }
    return items
  }

  // Returns metadata only. Values are never read into the result.
  async listEnv(projectId: string): Promise<EnvItem[]> {
    const b = await this.call('GET', '/v9/projects/' + encodeURIComponent(projectId) + '/env')
    return (b.envs || []).map((e: any) => ({
      id: e.id, key: e.key, type: e.type || 'plain',
      targets: Array.isArray(e.target) ? e.target : e.target ? [e.target] : []
    }))
  }

  // WRITE operations: only ever called from apply_env_change after approval.
  async upsertEnv(projectId: string, key: string, value: string, type: string, targets: string[]) {
    await this.call('POST', '/v10/projects/' + encodeURIComponent(projectId) + '/env', { upsert: 'true' }, { key, value, type, target: targets })
  }

  async deleteEnv(projectId: string, envId: string) {
    await this.call('DELETE', '/v9/projects/' + encodeURIComponent(projectId) + '/env/' + encodeURIComponent(envId))
  }
}
