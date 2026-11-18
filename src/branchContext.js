// Shared branch-context logic for Agent 1 / 2 / 3 (pure functions: no React, storage is injectable for tests).
// The browser only REMEMBERS the owner's choice; every server action re-validates repo, branch and SHA.

// GitHub-related actions per agent. Only these carry the selected repo/branch/SHA.
export const GITHUB_ACTIONS = {
  agent1: ['health_report', 'github_status'],
  agent2: ['repo_inspect', 'actions_status', 'propose_change', 'ai_fix', 'request_workflow', 'dev_chat', 'dev_assist', 'dev_proposal', 'dev_diagnose', 'request_promote'],
  agent3: ['security_scan', 'full_report']
}
// Actions whose `branch` param is an explicit agent2/<name> working branch typed by the owner (never defaulted to the selected base).
const EXPLICIT_BRANCH = ['request_promote']

const defaultStorage = () => (typeof localStorage !== 'undefined' ? localStorage : null)
export const branchKey = (agent, repo) => 'blisscco.branch.' + agent + ':' + repo
export const repoKey = agent => 'blisscco.activeRepo.' + agent

export function getActiveRepo(agent, storage = defaultStorage()) { try { return (storage && storage.getItem(repoKey(agent))) || '' } catch { return '' } }
export function setActiveRepo(agent, repo, storage = defaultStorage()) { try { if (storage && repo) storage.setItem(repoKey(agent), repo) } catch { /* storage unavailable */ } }
export function loadSelection(agent, repo, storage = defaultStorage()) {
  try { return JSON.parse((storage && storage.getItem(branchKey(agent, repo))) || '{}') || {} } catch { return {} }
}
export function saveSelection(agent, repo, branch, sha, storage = defaultStorage()) {
  try { if (storage) storage.setItem(branchKey(agent, repo), JSON.stringify({ branch, sha })) } catch { /* storage unavailable */ }
}
export function clearSelection(agent, repo, storage = defaultStorage()) { try { if (storage) storage.removeItem(branchKey(agent, repo)) } catch { /* storage unavailable */ } }

// Decide the selected branch after a (re)load of the real GitHub branch list.
//  - remembered branch still exists  -> keep it (SHA refreshed to the branch's current head)
//  - remembered branch is gone       -> select NOTHING and report it (never fall back silently)
//  - nothing remembered yet          -> pre-select the repository default branch (visible, owner can change it)
export function reconcileSelection(list, saved) {
  const rows = Array.isArray(list) ? list : []
  if (saved && saved.branch) {
    const hit = rows.find(b => b.name === saved.branch)
    if (hit) return { branch: hit.name, sha: hit.sha, changed: Boolean(saved.sha && saved.sha !== hit.sha), error: '', clear: false }
    return { branch: '', sha: '', changed: false, error: 'Selected branch "' + saved.branch + '" no longer exists or is not accessible. Select another branch manually.', clear: true }
  }
  const def = rows.find(b => b.default)
  if (def) return { branch: def.name, sha: def.sha, changed: false, error: '', clear: false }
  return { branch: '', sha: '', changed: false, error: rows.length ? '' : 'No branches available', clear: false }
}

// Attach repo + branch + SHA to GitHub-related actions. Non-GitHub actions pass through untouched.
export function scopeParams(agent, action, params = {}, storage = defaultStorage()) {
  if (action === 'github_branches') return { ...params, repo: params.repo || getActiveRepo(agent, storage) || params.repo }
  if (!(GITHUB_ACTIONS[agent] || []).includes(action)) return params
  const repo = params.repo || getActiveRepo(agent, storage)
  if (!repo) return params // no GitHub repository involved
  const saved = loadSelection(agent, repo, storage)
  if (!saved.branch || !saved.sha) throw new Error('Select a valid GitHub branch for ' + repo + ' first.')
  const scoped = { ...params, repo, branch_context_required: true }
  if (agent === 'agent2') {
    const explicit = EXPLICIT_BRANCH.includes(action)
    const branch = explicit ? params.branch : (params.branch || saved.branch)
    const base = params.base || saved.branch
    return {
      ...scoped, selected_branch: saved.branch, selected_branch_sha: saved.sha, branch,
      branch_sha: explicit ? params.branch_sha : (params.branch_sha || (branch === saved.branch ? saved.sha : undefined)),
      ref: params.ref || saved.branch, base,
      expected_base_sha: params.expected_base_sha || (base === saved.branch ? saved.sha : undefined)
    }
  }
  return { ...scoped, branch: saved.branch, branch_sha: saved.sha, ref: saved.branch, base: saved.branch, expected_base_sha: saved.sha }
}
