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
  async branches(repo: string): Promise<{ name: string; default: boolean; sha: string }[]> {
    const info = await this.get(`/repos/${repo}`)
    if (!info) throw new AgentError('Repo not found', 404, 'not_found')
    const out: any[] = []
    for (let page = 1; page <= 100; page++) {
      const rows = await this.get(`/repos/${repo}/branches?per_page=100&page=${page}`)
      if (!rows) throw new AgentError('Branch list unavailable', 404, 'not_found')
      out.push(...rows)
      if (rows.length < 100) break
    }
    return out.map(b => ({ name: String(b.name), default: b.name === info.default_branch, sha: String(b.commit.sha) }))
  }
  async branchSha(repo: string, branch: string): Promise<string | null> {
    const b = await this.get(`/repos/${repo}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`)
    return b?.object?.sha ? String(b.object.sha) : null
  }
  // The repository default branch is only ever read through this explicit call, by LEGACY (non-dashboard) callers.
  async defaultBranch(repo: string): Promise<string> {
    const info = await this.get(`/repos/${repo}`)
    if (!info) throw new AgentError('Repo not found', 404, 'not_found')
    return String(info.default_branch)
  }
  // `ref` is mandatory (branch name or commit SHA): tree() / file() never choose a branch themselves.
  async tree(repo: string, ref: string): Promise<{ path: string; type: string; size?: number; sha: string }[]> {
    if (!ref) throw new AgentError('A branch or commit is required; default-branch fallback is disabled.', 400, 'branch_required')
    const t = await this.get(`/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`)
    if (!t) throw new AgentError('Branch or repository not found: ' + ref, 404, 'branch_not_found')
    return t.tree || []
  }
  async file(repo: string, path: string, max = 400_000, ref = ''): Promise<string | null> {
    if (!ref) throw new AgentError('A branch or commit is required; default-branch fallback is disabled.', 400, 'branch_required')
    const f = await this.get(`/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`)
    if (!f || Array.isArray(f) || !f.content) return null
    if (f.size > max) return null
    return Buffer.from(String(f.content).replace(/\n/g, ''), 'base64').toString('utf8')
  }
}
