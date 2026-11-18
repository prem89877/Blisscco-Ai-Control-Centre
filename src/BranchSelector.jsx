import { useEffect, useState } from 'react'
import { getActiveRepo, setActiveRepo, loadSelection, saveSelection, clearSelection, reconcileSelection, selectionLabel } from './branchContext.js'

// Any component can follow the dropdown without owning a copy of it (the dropdown + localStorage stay the single source of truth).
const EVT = 'blisscco-branch-change'
const announce = () => { try { if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVT)) } catch { /* no window */ } }
export function useSelection(agent) {
  const read = () => selectionLabel(agent)
  const [sel, setSel] = useState(read)
  useEffect(() => { const f = () => setSel(read()); window.addEventListener(EVT, f); return () => window.removeEventListener(EVT, f) }, [agent])
  return sel
}
// Repo that every GitHub action of this agent uses = the repo chosen in the BranchSelector (never a per-card picker).
export const selectedRepo = (agent, repos = []) => { const a = getActiveRepo(agent); return (a && (!repos.length || repos.includes(a)) && a) || repos[0] || '' }
// Read-only "what will be used" line for cards and report headers.
export function SelectedLine({ agent, label = 'Using' }) {
  const sel = useSelection(agent)
  return sel
    ? <div className="sub">{label}: <b>{sel.repo}</b> @ <b>{sel.branch}</b> @ {sel.short}</div>
    : <div className="sub" style={{ color: 'var(--bad,#b42318)' }}>No branch selected: choose a repository and branch in the selector above.</div>
}

// Repository + branch picker shared by Agent 1, 2 and 3.
// Branches always come from the GitHub API through the agent server (github_branches), never from a hard-coded list.
export function BranchSelector({ agent, repos = [], initialRepo = '', call }) {
  const pickRepo = () => { const a = getActiveRepo(agent); return (a && repos.includes(a) && a) || initialRepo || repos[0] || '' }
  const [repo, setRepo] = useState(pickRepo)
  const [branches, setBranches] = useState([])
  const [branch, setBranch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  async function refresh(forRepo = repo) {
    if (!forRepo) return
    setBusy(true); setError(''); setNote('')
    try {
      const r = await call('github_branches', { repo: forRepo })
      const list = (r.result && r.result.branches) || []
      setBranches(list)
      const sel = reconcileSelection(list, loadSelection(agent, forRepo))
      if (sel.branch) saveSelection(agent, forRepo, sel.branch, sel.sha) // also stores the refreshed SHA when the same branch moved
      else if (sel.clear) clearSelection(agent, forRepo) // deleted branch: forget it, never swap in another one
      announce()
      setBranch(sel.branch)
      setError(sel.error)
      if (sel.changed) setNote('Branch moved since last selection; now pinned to ' + sel.sha.slice(0, 7) + '.')
    } catch (e) { setBranches([]); setBranch(''); clearSelection(agent, forRepo); announce(); setError(e.message || 'Unable to load branches') }
    setBusy(false)
  }

  // repo list arrives asynchronously (e.g. from the agent heartbeat)
  useEffect(() => { const next = pickRepo(); if (next && next !== repo) setRepo(next) }, [repos.join('|'), initialRepo])
  useEffect(() => { if (repo) { setActiveRepo(agent, repo); refresh(repo) } }, [repo])

  function chooseRepo(r) { setBranch(''); setBranches([]); setRepo(r); setActiveRepo(agent, r); announce() }
  function choose(name) {
    const b = branches.find(x => x.name === name)
    setBranch(name); setError(''); setNote('')
    if (b) { saveSelection(agent, repo, b.name, b.sha); setActiveRepo(agent, repo) }
    announce()
  }
  const cur = branches.find(b => b.name === branch)
  return <div className="card" style={{ marginBottom: 10 }}>
    <b>GitHub repository &amp; branch</b><div className="sub">This selection controls every GitHub read, check and test of this agent.</div>
    <div className="sub">Repository</div>
    <select value={repo} onChange={e => chooseRepo(e.target.value)} disabled={!repos.length}>
      {!repos.length && <option value="">No configured repositories</option>}
      {repos.map(r => <option key={r} value={r}>{r}</option>)}
    </select>
    <div className="row" style={{ gap: 8, marginTop: 6 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="sub">Branch {cur && cur.default ? '(default)' : ''}</div>
        <select value={branch} onChange={e => choose(e.target.value)} disabled={busy || !branches.length}>
          {!branch && <option value="">{busy ? 'Loading branches...' : branches.length ? 'Select a branch' : 'No branches available'}</option>}
          {branches.map(b => <option key={b.name} value={b.name}>{b.name}{b.default ? ' (default)' : ''}</option>)}
        </select>
      </div>
      <button className="btn ghost" disabled={busy || !repo} onClick={() => refresh()}>{busy ? 'Loading...' : 'Refresh'}</button>
    </div>
    {error && <div className="sub" style={{ color: 'var(--bad,#b42318)' }}>{error}</div>}
    {note && <div className="sub">{note}</div>}
    {cur && <div className="sub">Selected: {repo} @ {cur.name} · {String(cur.sha).slice(0, 7)}</div>}
  </div>
}
