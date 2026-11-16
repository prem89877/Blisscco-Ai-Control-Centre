import type { Config } from './config.js'
import { AgentError, jfetch } from './util.js'

export interface RepoReport {
  repo: string
  found: boolean
  defaultBranch?: string
  pushedAt?: string
  lastCommits?: { sha: string; message: string; date: string }[]
  runs?: { name: string; status: string; conclusion: string | null; branch: string }[]
  committedEnvFiles?: string[]
}

export const isEnvFile = (path: string) => {
  const base = path.split('/').pop() || ''
  return /^\.env(\..+)?$/.test(base) && !/\.(example|sample|template)$/.test(base)
}

export class GitHub {
  constructor(private cfg: Config, private calls: Record<string, number>) {}

  private async get(path: string) {
    if (!this.cfg.githubToken) throw new AgentError('AGENT1_GITHUB_TOKEN is not set', 503, 'not_configured')
    this.calls.github = (this.calls.github || 0) + 1
    return jfetch('https://api.github.com' + path, {
      headers: { Authorization: 'Bearer ' + this.cfg.githubToken, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'blisscco-agent1' }
    })
  }

  async inspect(repo: string): Promise<RepoReport> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new AgentError('Bad repo name: ' + repo, 400)
    const info = await this.get('/repos/' + repo)
    if (info.status === 404) return { repo, found: false }
    if (!info.ok) throw new AgentError('GitHub API ' + info.status, 502, 'github')
    const branch = info.body.default_branch
    const [commits, runs, tree] = await Promise.all([
      this.get('/repos/' + repo + '/commits?per_page=3'),
      this.get('/repos/' + repo + '/actions/runs?per_page=5'),
      this.get('/repos/' + repo + '/git/trees/' + encodeURIComponent(branch) + '?recursive=1')
    ])
    return {
      repo, found: true, defaultBranch: branch, pushedAt: info.body.pushed_at,
      lastCommits: commits.ok ? commits.body.map((c: any) => ({ sha: String(c.sha).slice(0, 7), message: String(c.commit.message).split('\n')[0].slice(0, 100), date: c.commit.author.date })) : [],
      runs: runs.ok ? (runs.body.workflow_runs || []).map((r: any) => ({ name: r.name, status: r.status, conclusion: r.conclusion, branch: r.head_branch })) : [],
      committedEnvFiles: tree.ok ? (tree.body.tree || []).filter((t: any) => t.type === 'blob' && isEnvFile(t.path)).map((t: any) => t.path) : []
    }
  }
}
