import type { Config } from './config.js'
import { AgentError, jfetch } from './util.js'

// Read-only GitHub client (tree + file text). No write endpoint exists in this file.
export class GitHub {
  constructor(private cfg: Config, private calls: Record<string, number>) {}
  private async get(path: string) {
    if (!this.cfg.githubToken) throw new AgentError('AGENT3_GITHUB_TOKEN not set', 503, 'not_configured')
    this.calls.github = (this.calls.github || 0) + 1
    const r = await jfetch('https://api.github.com' + path, { headers: { Authorization: 'Bearer ' + this.cfg.githubToken, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'blisscco-agent3' } }, 20000)
    if (r.status === 404) return null
    if (!r.ok) throw new AgentError('GitHub API ' + r.status, 502, 'github')
    return r.body
  }
  repoAllowed(repo: string) { return this.cfg.githubRepos.some(r => r.toLowerCase() === repo.toLowerCase()) }
  async tree(repo: string): Promise<{ path: string; type: string; size?: number; sha: string }[]> {
    const info = await this.get(`/repos/${repo}`)
    if (!info) throw new AgentError('Repo not found', 404, 'not_found')
    const t = await this.get(`/repos/${repo}/git/trees/${encodeURIComponent(info.default_branch)}?recursive=1`)
    return (t && t.tree) || []
  }
  async file(repo: string, path: string, max = 400_000): Promise<string | null> {
    const f = await this.get(`/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`)
    if (!f || Array.isArray(f) || !f.content) return null
    if (f.size > max) return null
    return Buffer.from(String(f.content).replace(/\n/g, ''), 'base64').toString('utf8')
  }
}
