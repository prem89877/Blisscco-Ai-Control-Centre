import type { Config } from './config.js'
import { AgentError, jfetch } from './util.js'

export interface RepoReport {
  repo: string
  found: boolean
  defaultBranch?: string
  branch?: string
  branchSha?: string
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

  async branches(repo: string): Promise<{ name: string; default: boolean; sha: string }[]> {
    const info = await this.get('/repos/' + repo)
    if (!info.ok) throw new AgentError('GitHub API ' + info.status, 502, 'github')
    const out: any[] = []
    for (let page = 1; page <= 100; page++) {
      const r = await this.get(`/repos/${repo}/branches?per_page=100&page=${page}`)
      if (!r.ok) throw new AgentError('GitHub API ' + r.status, 502, 'github')
      out.push(...r.body)
      if (r.body.length < 100) break
    }
    return out.map(b => ({ name: String(b.name), default: b.name === info.body.default_branch, sha: String(b.commit.sha) }))
  }

  async inspect(repo: string, selectedBranch?: string, expectedSha?: string, strict = false): Promise<RepoReport> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new AgentError('Bad repo name: ' + repo, 400)
    const info = await this.get('/repos/' + repo)
    if (info.status === 404) return { repo, found: false }
    if (!info.ok) throw new AgentError('GitHub API ' + info.status, 502, 'github')
    // Legacy callers (CLI / heartbeat with no owner selection and strict=false) keep the original default-branch behaviour.
    // Dashboard callers (strict=true) MUST name a branch: it is SHA-pinned and the repository default is never substituted.
    if (strict && !selectedBranch) throw new AgentError('Select a GitHub branch; default fallback is disabled.', 400, 'branch_required')
    const pinned = Boolean(selectedBranch)
    const branch = selectedBranch || info.body.default_branch
    const refPath = String(branch).split('/').map(encodeURIComponent).join('/')
    let branchSha: string | undefined
    if (pinned) {
      const ref = await this.get('/repos/' + repo + '/git/ref/heads/' + refPath)
      if (!ref.ok) throw new AgentError('Selected branch not found or inaccessible: ' + branch, ref.status === 404 ? 404 : 502, 'branch_not_found')
      branchSha = String(ref.body.object.sha)
      if (expectedSha && expectedSha.toLowerCase() !== branchSha.toLowerCase()) throw new AgentError('Selected branch moved. Refresh before running checks.', 409, 'base_changed')
    }
    const [commits, runs, tree] = await Promise.all([
      this.get('/repos/' + repo + '/commits?' + (pinned ? 'sha=' + encodeURIComponent(branchSha!) + '&' : '') + 'per_page=3'),
      this.get('/repos/' + repo + '/actions/runs?' + (pinned ? 'branch=' + encodeURIComponent(branch) + '&' : '') + 'per_page=5'),
      this.get('/repos/' + repo + '/git/trees/' + encodeURIComponent(pinned ? branchSha! : branch) + '?recursive=1')
    ])
    if (pinned) {
      const latestRef = await this.get('/repos/' + repo + '/git/ref/heads/' + refPath)
      if (!latestRef.ok || String(latestRef.body.object.sha).toLowerCase() !== branchSha!.toLowerCase()) throw new AgentError('Selected branch moved during GitHub checks. Refresh and retry.', 409, 'base_changed')
    }
    return {
      repo, found: true, defaultBranch: info.body.default_branch, branch, branchSha, pushedAt: info.body.pushed_at,
      lastCommits: commits.ok ? commits.body.map((c: any) => ({ sha: String(c.sha).slice(0, 7), message: String(c.commit.message).split('\n')[0].slice(0, 100), date: c.commit.author.date })) : [],
      runs: runs.ok ? (runs.body.workflow_runs || []).map((r: any) => ({ name: r.name, status: r.status, conclusion: r.conclusion, branch: r.head_branch })) : [],
      committedEnvFiles: tree.ok ? (tree.body.tree || []).filter((t: any) => t.type === 'blob' && isEnvFile(t.path)).map((t: any) => t.path) : []
    }
  }
}
