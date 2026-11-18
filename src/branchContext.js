// Shared branch-context logic for Agent 1 / 2 / 3 (pure functions: no React, storage is injectable for tests).
// The browser only REMEMBERS the owner's choice; every server action re-validates repo, branch and SHA.

// GitHub-related actions per agent. Only these carry the selected repo/branch/SHA.
// Every dashboard action that reads or writes GitHub MUST be listed here (strict: no saved selection -> Error, nothing is sent).
export const GITHUB_ACTIONS = {
  agent1: ['health_report', 'github_status'],
  agent2: ['repo_inspect', 'actions_status', 'propose_change', 'ai_fix', 'ai_command', 'request_workflow', 'dev_chat', 'dev_assist', 'dev_proposal', 'dev_diagnose',
    'request_promote', 'request_rollback', 'apply_change', 'apply_promote', 'apply_rollback', 'apply_workflow'],
  agent3: ['security_scan', 'full_report']
}
// Actions that only SOMETIMES touch GitHub (the AI picks the intent on the server): the selection is attached when one exists and the
// server refuses the GitHub-touching intents without it. They never block purely non-GitHub requests (Vercel / Supabase / live site).
export const SOFT_ACTIONS = { agent1: ['ai_command'], agent3: ['ai_command'] }
// agent3 queue_task only touches GitHub for the repo-scanning tests.
export const GITHUB_TASKS = { agent3: ['security_scan', 'full_report'] }
// Actions whose `branch` param is an explicit agent2/<name> working branch (never defaulted to the selected base).
const EXPLICIT_BRANCH = ['request_promote', 'request_rollback']
// Actions that operate on a recorded approval: no branch of their own; the server re-validates the approval's recorded base + SHA
// and refuses (409 base_mismatch) when the dropdown selection is a different base.
const APPROVAL_ACTIONS = ['apply_change', 'apply_promote', 'apply_rollback', 'apply_workflow']
// Params a caller must never use to point a GitHub action at another base than the dropdown (only agent2/* working branches are allowed).
const isWorking = b => typeof b === 'string' && b.startsWith('agent2/')

export const touchesGithub = (agent, action, params = {}) =>
  (GITHUB_ACTIONS[agent] || []).includes(action) || (action === 'queue_task' && (GITHUB_TASKS[agent] || []).includes(params.task))

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
//
// The dropdown selection is the ONLY source of base/ref/branch for GitHub actions. A caller-supplied branch/ref/base/SHA that differs from the
// selection is never forwarded (it would override the dropdown); the only exception is an explicit agent2/* working branch for the actions
// that operate on one (CI check, diagnose, workflow, promote, delete). The server enforces the same rule (409 branch_override).
export function scopeParams(agent, action, params = {}, storage = defaultStorage()) {
  if (action === 'github_branches') return { ...params, repo: params.repo || getActiveRepo(agent, storage) || params.repo }
  const hard = touchesGithub(agent, action, params)
  const soft = !hard && (SOFT_ACTIONS[agent] || []).includes(action)
  if (!hard && !soft) return params
  const repo = params.repo || getActiveRepo(agent, storage)
  const saved = repo ? loadSelection(agent, repo, storage) : {}
  if (soft && (!repo || !saved.branch || !saved.sha)) return params // non-GitHub request: the server refuses GitHub intents without a selection
  if (!repo && agent === 'agent2' && ['dev_chat', 'dev_assist'].includes(action)) return params // general question, no repository involved
  if (!repo) throw new Error('Select a GitHub repository and branch first.')
  if (!saved.branch || !saved.sha) throw new Error('Select a valid GitHub branch for ' + repo + ' first.')
  const scoped = { ...params, repo, branch_context_required: true }
  if (agent === 'agent2') {
    const sel = { selected_branch: saved.branch, selected_branch_sha: saved.sha }
    if (APPROVAL_ACTIONS.includes(action)) return { ...scoped, ...sel } // base comes from the approval record, validated server-side
    // working branch typed by the owner / taken from an approval (agent2/*): allowed only for the actions that operate on one
    const workingOk = ['actions_status', 'dev_diagnose', 'request_workflow', ...EXPLICIT_BRANCH].includes(action)
    const working = workingOk && isWorking(params.branch) && params.branch !== saved.branch ? params.branch : null
    const wRef = action === 'request_workflow' && isWorking(params.ref) && params.ref !== saved.branch ? params.ref : null
    const explicit = EXPLICIT_BRANCH.includes(action)
    const branch = explicit ? params.branch : (working || saved.branch)
    return {
      ...scoped, ...sel, branch,
      branch_sha: explicit ? params.branch_sha : (working ? params.branch_sha : saved.sha),
      ref: wRef || saved.branch, base: saved.branch, expected_base_sha: saved.sha
    }
  }
  return { ...scoped, branch: saved.branch, branch_sha: saved.sha, ref: saved.branch, base: saved.branch, expected_base_sha: saved.sha }
}

// Short "repo @ branch @ sha7" label of what a dashboard action will use (null when nothing is selected).
export function selectionLabel(agent, repo, storage = defaultStorage()) {
  const r = repo || getActiveRepo(agent, storage)
  const s = r ? loadSelection(agent, r, storage) : {}
  return s.branch && s.sha ? { repo: r, branch: s.branch, sha: s.sha, short: String(s.sha).slice(0, 7), text: r + ' @ ' + s.branch + ' @ ' + String(s.sha).slice(0, 7) } : null
}
