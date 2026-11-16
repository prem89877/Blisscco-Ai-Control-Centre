import type { Config } from './config.js'
import { repoAllowed } from './config.js'
import { AgentError, b64, jfetch, unb64 } from './util.js'
import { assertAgentBranch, validRepo } from './guard.js'

export interface TreeEntry { path: string; mode: string; type: string; sha: string }
export interface CommitFile { path: string; mode?: string; content?: string; sha?: string | null; delete?: boolean }

// GitHub REST client. Every write method re-checks the branch rule, so even a bug elsewhere cannot write to production branches.
export class GitHub {
  constructor(private cfg: Config, private calls: Record<string, number>) {}

  private async call(method: string, path: string, body?: unknown, ok404 = false) {
    if (!this.cfg.githubToken) throw new AgentError('AGENT2_GITHUB_TOKEN is not set', 503, 'not_configured')
    this.calls.github = (this.calls.github || 0) + 1
    const init = {
      method,
      headers: { Authorization: 'Bearer ' + this.cfg.githubToken, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'blisscco-agent2', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }
    let r
    try { r = await jfetch('https://api.github.com' + path, init, 30000) }
    catch (e) { if (method !== 'GET') throw e; r = await jfetch('https://api.github.com' + path, init, 30000) } // one retry, reads only
    if (r.status === 404 && ok404) return null
    if (r.status === 401) throw new AgentError('GitHub token invalid (401)', 502, 'github_auth')
    if (r.status === 403 || r.status === 404) throw new AgentError(`GitHub denied or not found (${r.status}): ${String(r.body && r.body.message || '').slice(0, 160)}. Check token permissions for this repo.`, 502, 'github_denied')
    if (!r.ok) throw new AgentError(`GitHub API ${r.status}: ${String(r.body && r.body.message || 'request failed').slice(0, 200)}`, 502, 'github')
    return r.body
  }

  repo(repo: string): string {
    validRepo(repo)
    if (!repoAllowed(this.cfg, repo)) throw new AgentError('Repo is not in AGENT2_GITHUB_REPOS: ' + repo, 403, 'repo_not_allowed')
    return repo
  }

  async info(repo: string) { const b = await this.call('GET', '/repos/' + this.repo(repo)); return { default_branch: String(b.default_branch), pushed_at: b.pushed_at as string, private: Boolean(b.private) } }

  async branchSha(repo: string, branch: string): Promise<string | null> {
    const b = await this.call('GET', `/repos/${this.repo(repo)}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, undefined, true)
    return b ? String(b.object.sha) : null
  }

  async commitTreeSha(repo: string, commitSha: string): Promise<string> {
    const c = await this.call('GET', `/repos/${this.repo(repo)}/git/commits/${commitSha}`)
    return String(c.tree.sha)
  }

  async tree(repo: string, treeSha: string): Promise<TreeEntry[]> {
    const t = await this.call('GET', `/repos/${this.repo(repo)}/git/trees/${treeSha}?recursive=1`)
    if (t.truncated) throw new AgentError('Repository tree too large to inspect through the API; use the Termux flow', 413, 'too_large')
    return (t.tree || []).filter((e: any) => e.type === 'blob').map((e: any) => ({ path: e.path, mode: e.mode, type: e.type, sha: e.sha }))
  }

  async blobText(repo: string, sha: string, maxBytes = 200_000): Promise<string> {
    const b = await this.call('GET', `/repos/${this.repo(repo)}/git/blobs/${sha}`)
    if (Number(b.size) > maxBytes) throw new AgentError('File too large to read through the API', 413, 'too_large')
    return b.encoding === 'base64' ? unb64(String(b.content)) : String(b.content)
  }

  async recentCommits(repo: string, branch: string, n = 5) {
    const c = await this.call('GET', `/repos/${this.repo(repo)}/commits?sha=${encodeURIComponent(branch)}&per_page=${n}`)
    return (c as any[]).map(x => ({ sha: String(x.sha).slice(0, 7), message: String(x.commit.message).split('\n')[0].slice(0, 100), date: x.commit.author && x.commit.author.date }))
  }

  // ---- writes (agent branches only) ----
  async createBranch(repo: string, branch: string, fromSha: string) {
    assertAgentBranch(branch, this.cfg.protectedBranches)
    if (await this.branchSha(repo, branch)) throw new AgentError('Branch already exists: ' + branch, 409, 'branch_exists')
    await this.call('POST', `/repos/${this.repo(repo)}/git/refs`, { ref: 'refs/heads/' + branch, sha: fromSha })
  }

  async commit(repo: string, branch: string, parentSha: string, message: string, files: CommitFile[]): Promise<string> {
    assertAgentBranch(branch, this.cfg.protectedBranches)
    const r = this.repo(repo)
    const baseTree = await this.commitTreeSha(repo, parentSha)
    const entries: any[] = []
    for (const f of files) {
      if (f.delete) { entries.push({ path: f.path, mode: '100644', type: 'blob', sha: null }); continue }
      if (f.sha !== undefined && f.content === undefined) { entries.push({ path: f.path, mode: f.mode || '100644', type: 'blob', sha: f.sha }); continue }
      const blob = await this.call('POST', `/repos/${r}/git/blobs`, { content: b64(f.content || ''), encoding: 'base64' })
      entries.push({ path: f.path, mode: f.mode || '100644', type: 'blob', sha: blob.sha })
    }
    const tree = await this.call('POST', `/repos/${r}/git/trees`, { base_tree: baseTree, tree: entries })
    const commit = await this.call('POST', `/repos/${r}/git/commits`, { message, tree: tree.sha, parents: [parentSha] })
    // force:false => fast-forward only; never rewrites history
    await this.call('PATCH', `/repos/${r}/git/refs/heads/${branch}`, { sha: commit.sha, force: false })
    return String(commit.sha)
  }

  async deleteBranch(repo: string, branch: string) {
    assertAgentBranch(branch, this.cfg.protectedBranches)
    await this.call('DELETE', `/repos/${this.repo(repo)}/git/refs/heads/${branch}`)
  }

  // ---- monitoring (read) ----
  async runs(repo: string, branch?: string, n = 5) {
    const q = `per_page=${n}` + (branch ? '&branch=' + encodeURIComponent(branch) : '')
    const b = await this.call('GET', `/repos/${this.repo(repo)}/actions/runs?${q}`)
    return ((b.workflow_runs || []) as any[]).map(r => ({ id: r.id, name: String(r.name), status: String(r.status), conclusion: (r.conclusion as string) || null, branch: String(r.head_branch), sha: String(r.head_sha).slice(0, 7), url: String(r.html_url || '') }))
  }
  async failedJobs(repo: string, runId: number) {
    const b = await this.call('GET', `/repos/${this.repo(repo)}/actions/runs/${runId}/jobs`)
    return ((b.jobs || []) as any[]).filter(j => j.conclusion === 'failure').map(j => ({ job: String(j.name), failed_steps: ((j.steps || []) as any[]).filter(s => s.conclusion === 'failure').map(s => String(s.name)) }))
  }
  async deployments(repo: string, ref: string) {
    const b = await this.call('GET', `/repos/${this.repo(repo)}/deployments?ref=${encodeURIComponent(ref)}&per_page=5`)
    return ((b || []) as any[]).map(d => ({ id: d.id, environment: String(d.environment), created_at: String(d.created_at) }))
  }

  // ---- promotion (pull request + merge) ----
  async findPr(repo: string, head: string, base: string) {
    const owner = repo.split('/')[0]
    const b = await this.call('GET', `/repos/${this.repo(repo)}/pulls?state=open&head=${encodeURIComponent(owner + ':' + head)}&base=${encodeURIComponent(base)}`)
    return (b as any[])[0] ? { number: Number(b[0].number), url: String(b[0].html_url) } : null
  }
  async createPr(repo: string, head: string, base: string, title: string, body: string) {
    assertAgentBranch(head, this.cfg.protectedBranches)
    const b = await this.call('POST', `/repos/${this.repo(repo)}/pulls`, { head, base, title, body })
    return { number: Number(b.number), url: String(b.html_url) }
  }
  async mergePr(repo: string, number: number, expectedHeadSha: string): Promise<string> {
    // sha pin: GitHub refuses the merge if the branch moved after approval
    const b = await this.call('PUT', `/repos/${this.repo(repo)}/pulls/${number}/merge`, { merge_method: 'squash', sha: expectedHeadSha })
    return String(b.sha)
  }
}
