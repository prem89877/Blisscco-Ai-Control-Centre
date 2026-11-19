import type { Config } from './config.js'
import { repoAllowed } from './config.js'
import { AgentError, b64, jfetch, unb64 } from './util.js'
import { assertAgentBranch, scanSecrets, validRepo } from './guard.js'

export const GITHUB_RESOURCES: readonly string[] = ['pull_requests', 'issues', 'releases', 'tags', 'commits', 'workflows', 'metadata', 'checks']
export const GITHUB_WRITE_OPS: readonly string[] = ['create_issue', 'comment', 'add_labels', 'close_issue', 'reopen_issue']
export const SAFE_REF = /^[\w./-]{1,100}$/
export interface WriteInput { number?: number; title?: string; body?: string; labels?: string[] }

// Free text from GitHub is shown to the owner and stored in task results: clip it and withhold anything that looks like a secret.
function safeText(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null
  const t = String(v)
  if (scanSecrets(t).length) return '[withheld: possible secret]'
  return t.length > max ? t.slice(0, max) + '...' : t
}

// Validates everything BEFORE a task is created or GitHub is called. Text that looks like a secret is refused, never sent.
export function validateWrite(op: string, p: any): WriteInput {
  if (!GITHUB_WRITE_OPS.includes(op)) throw new AgentError('Supported GitHub writes: ' + GITHUB_WRITE_OPS.join(', '), 400, 'bad_operation')
  const out: WriteInput = {}
  const text = (v: unknown, what: string, max: number, required: boolean) => {
    const t = typeof v === 'string' ? v.trim() : ''
    if (!t) { if (required) throw new AgentError(what + ' is required', 400, 'bad_input'); return undefined }
    if (t.length > max) throw new AgentError(what + ' is too long (max ' + max + ' characters)', 400, 'bad_input')
    if (scanSecrets(t).length) throw new AgentError(what + ' looks like it contains a secret or credential. Nothing was sent.', 403, 'secret_in_text')
    return t
  }
  if (op !== 'create_issue') {
    const n = Number(p.number)
    if (!Number.isInteger(n) || n < 1 || n > 10_000_000) throw new AgentError('A valid issue or PR number is required', 400, 'bad_input')
    out.number = n
  }
  if (op === 'create_issue') out.title = text(p.title, 'Title', 256, true)
  if (op === 'create_issue' || op === 'comment') {
    const b = text(p.body, 'Text', 8000, op === 'comment')
    if (b !== undefined || op === 'comment') out.body = (b || '') + '\n\n_- via Blisscco Agent 2_'
  }
  if (op === 'add_labels' || op === 'create_issue') {
    const raw = Array.isArray(p.labels) ? p.labels : []
    const labels = raw.map((x: unknown) => String(x).trim()).filter(Boolean)
    if (labels.length > 10 || labels.some((x: string) => x.length > 50 || /[\0\n\r]/.test(x))) throw new AgentError('Up to 10 labels, each up to 50 characters', 400, 'bad_input')
    if (op === 'add_labels' && !labels.length) throw new AgentError('At least one label is required', 400, 'bad_input')
    out.labels = labels
  }
  return out
}

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

  async branches(repo: string): Promise<{ name: string; default: boolean; sha: string }[]> {
    const info = await this.call('GET', `/repos/${this.repo(repo)}`)
    const out: any[] = []
    for (let page = 1; page <= 100; page++) {
      const rows = await this.call('GET', `/repos/${this.repo(repo)}/branches?per_page=100&page=${page}`)
      out.push(...rows)
      if (rows.length < 100) break
    }
    return out.map(b => ({ name: String(b.name), default: b.name === info.default_branch, sha: String(b.commit.sha) }))
  }

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

  // Read-only GitHub developer surface. Resource names are an explicit allow-list; the caller cannot supply arbitrary API paths.
  // Every resource is projected to a compact, fixed set of fields (no raw payloads), free text is length-limited and any text that
  // looks like a secret is withheld. `collaborators` / permissions are intentionally NOT exposed (sensitive).
  async developerResource(repo: string, resource: string, ref?: string) {
    if (!GITHUB_RESOURCES.includes(resource)) throw new AgentError('Unsupported GitHub resource: ' + resource + '. Supported: ' + GITHUB_RESOURCES.join(', '), 400, 'bad_resource')
    if (ref !== undefined && (!SAFE_REF.test(ref) || ref.includes('..'))) throw new AgentError('Unsafe ref: ' + ref, 400, 'bad_ref')
    const r = this.repo(repo)
    const user = (u: any) => (u && u.login ? String(u.login) : null)
    const labels = (l: any) => ((l || []) as any[]).map(x => String(x && x.name !== undefined ? x.name : x)).slice(0, 20)
    switch (resource) {
      case 'pull_requests': {
        const rows = (await this.call('GET', `/repos/${r}/pulls?state=all&per_page=30`)) as any[]
        return { count: rows.length, items: rows.map(x => ({ number: x.number, title: safeText(x.title, 200), state: x.merged_at ? 'merged' : x.state, draft: Boolean(x.draft), author: user(x.user), head: x.head && x.head.ref, base: x.base && x.base.ref, labels: labels(x.labels), created_at: x.created_at, updated_at: x.updated_at, url: x.html_url, body: safeText(x.body, 300) })) }
      }
      case 'issues': {
        const rows = ((await this.call('GET', `/repos/${r}/issues?state=all&per_page=50`)) as any[]).filter(x => !x.pull_request) // this endpoint also lists PRs
        return { count: rows.length, items: rows.map(x => ({ number: x.number, title: safeText(x.title, 200), state: x.state, author: user(x.user), labels: labels(x.labels), comments: x.comments, created_at: x.created_at, updated_at: x.updated_at, url: x.html_url, body: safeText(x.body, 300) })) }
      }
      case 'releases': {
        const rows = (await this.call('GET', `/repos/${r}/releases?per_page=30`)) as any[]
        return { count: rows.length, items: rows.map(x => ({ name: safeText(x.name, 200), tag: x.tag_name, draft: Boolean(x.draft), prerelease: Boolean(x.prerelease), author: user(x.author), published_at: x.published_at, url: x.html_url, body: safeText(x.body, 300) })) }
      }
      case 'tags': {
        const rows = (await this.call('GET', `/repos/${r}/tags?per_page=100`)) as any[]
        return { count: rows.length, items: rows.map(x => ({ name: x.name, sha: x.commit && x.commit.sha })) }
      }
      case 'commits': {
        const rows = (await this.call('GET', `/repos/${r}/commits?${ref ? 'sha=' + encodeURIComponent(ref) + '&' : ''}per_page=30`)) as any[]
        return { ref: ref || 'default branch', count: rows.length, items: rows.map(x => ({ sha: x.sha, message: safeText(String(x.commit && x.commit.message || '').split('\n')[0], 200), author: x.commit && x.commit.author && x.commit.author.name, date: x.commit && x.commit.author && x.commit.author.date, url: x.html_url })) }
      }
      case 'workflows': {
        const b = await this.call('GET', `/repos/${r}/actions/workflows?per_page=100`)
        const rows = (b.workflows || []) as any[]
        return { count: rows.length, items: rows.map(x => ({ id: x.id, name: x.name, path: x.path, state: x.state })) }
      }
      case 'metadata': {
        const x = await this.call('GET', `/repos/${r}`)
        return { full_name: x.full_name, description: safeText(x.description, 300), private: Boolean(x.private), visibility: x.visibility || null, default_branch: x.default_branch, language: x.language, archived: Boolean(x.archived), topics: x.topics || [], open_issues: x.open_issues_count, stars: x.stargazers_count, forks: x.forks_count, size_kb: x.size, license: x.license && x.license.spdx_id || null, created_at: x.created_at, pushed_at: x.pushed_at, url: x.html_url }
      }
      case 'checks': {
        // Resolve the branch to a commit SHA first (branch names with "/" are not safe in this endpoint's path).
        let sha = ref && /^[0-9a-f]{40}$/i.test(ref) ? ref : ''
        if (!sha) {
          const branch = ref || (await this.info(repo)).default_branch
          const found = await this.branchSha(repo, branch)
          if (!found) throw new AgentError('Branch not found: ' + branch, 404, 'branch_not_found')
          sha = found
        }
        const b = await this.call('GET', `/repos/${r}/commits/${sha}/check-runs?per_page=100`)
        const rows = (b.check_runs || []) as any[]
        return { ref: ref || 'default branch', sha, total: b.total_count, items: rows.map(x => ({ name: x.name, status: x.status, conclusion: x.conclusion, started_at: x.started_at, completed_at: x.completed_at, url: x.html_url })) }
      }
    }
    throw new AgentError('Unsupported GitHub resource: ' + resource, 400, 'bad_resource')
  }

  // ---- issue / comment writes (low risk, reversible; never touch code, branches, releases, tags, settings or secrets) ----
  async writeIssueOp(repo: string, op: string, i: WriteInput): Promise<any> {
    const r = this.repo(repo)
    switch (op) {
      case 'create_issue': {
        const b = await this.call('POST', `/repos/${r}/issues`, { title: i.title, body: i.body, labels: i.labels })
        return { created: 'issue', number: b.number, url: b.html_url }
      }
      case 'comment': {
        const b = await this.call('POST', `/repos/${r}/issues/${i.number}/comments`, { body: i.body })
        return { created: 'comment', number: i.number, url: b.html_url }
      }
      case 'add_labels': {
        const b = await this.call('POST', `/repos/${r}/issues/${i.number}/labels`, { labels: i.labels })
        return { number: i.number, labels: ((b || []) as any[]).map(x => String(x.name)) }
      }
      case 'close_issue': case 'reopen_issue': {
        const cur = await this.call('GET', `/repos/${r}/issues/${i.number}`)
        // Closing a pull request would break the approval/merge flow: PRs are handled only through Propose / Promote / Rollback.
        if (cur.pull_request) throw new AgentError('#' + i.number + ' is a pull request. Pull requests are closed or merged only through the approval flow.', 409, 'is_pull_request')
        const b = await this.call('PATCH', `/repos/${r}/issues/${i.number}`, { state: op === 'close_issue' ? 'closed' : 'open' })
        return { number: i.number, state: b.state, url: b.html_url }
      }
    }
    throw new AgentError('Unsupported GitHub write: ' + op, 400, 'bad_operation')
  }

  // ---- monitoring (read) ----
  async runs(repo: string, branch?: string, n = 5) {
    const q = `per_page=${n}` + (branch ? '&branch=' + encodeURIComponent(branch) : '')
    const b = await this.call('GET', `/repos/${this.repo(repo)}/actions/runs?${q}`)
    return ((b.workflow_runs || []) as any[]).map(r => ({ id: r.id, name: String(r.name), status: String(r.status), conclusion: (r.conclusion as string) || null, branch: String(r.head_branch), sha: String(r.head_sha).slice(0, 7), url: String(r.html_url || '') }))
  }
  async failedJobs(repo: string, runId: number) {
    const b = await this.call('GET', `/repos/${this.repo(repo)}/actions/runs/${runId}/jobs`)
    return ((b.jobs || []) as any[]).filter(j => j.conclusion === 'failure').map(j => ({ job: String(j.name), job_id: Number(j.id), failed_steps: ((j.steps || []) as any[]).filter(s => s.conclusion === 'failure').map(s => String(s.name)) }))
  }
  // Raw text log of one job (GitHub answers with a redirect to a short-lived file). '' when GitHub no longer has it or the token cannot read it.
  async jobLog(repo: string, jobId: number): Promise<string> {
    try { const b = await this.call('GET', `/repos/${this.repo(repo)}/actions/jobs/${Number(jobId)}/logs`); return typeof b === 'string' ? b : '' }
    catch { return '' }
  }
  async deployments(repo: string, ref: string) {
    const b = await this.call('GET', `/repos/${this.repo(repo)}/deployments?ref=${encodeURIComponent(ref)}&per_page=5`)
    return ((b || []) as any[]).map(d => ({ id: d.id, environment: String(d.environment), created_at: String(d.created_at) }))
  }

  // ---- agent branches + workflows ----
  async agentBranches(repo: string): Promise<string[]> {
    const b = await this.call('GET', `/repos/${this.repo(repo)}/git/matching-refs/heads/agent2/`)
    return ((b || []) as any[]).map(r => String(r.ref).replace(/^refs\/heads\//, '')).filter(n => n.startsWith('agent2/')).slice(0, 100)
  }
  async workflows(repo: string) {
    const b = await this.call('GET', `/repos/${this.repo(repo)}/actions/workflows?per_page=50`)
    return ((b.workflows || []) as any[]).map(w => ({ id: Number(w.id), name: String(w.name), path: String(w.path), state: String(w.state) }))
  }
  async dispatchWorkflow(repo: string, workflowId: number, ref: string) {
    try { await this.call('POST', `/repos/${this.repo(repo)}/actions/workflows/${Number(workflowId)}/dispatches`, { ref }) }
    catch (e) {
      const m = e instanceof Error ? e.message : ''
      if (m.includes('422')) throw new AgentError("This workflow cannot be started by hand: its file needs `on: workflow_dispatch:`. Add that line with Submit code (needs approval), then try again.", 409, 'no_dispatch')
      if (e instanceof AgentError && e.code === 'github_denied') throw new AgentError('GitHub refused to start the workflow. The token needs Actions: Read and write permission for this repo.', 502, 'github_denied')
      throw e
    }
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
