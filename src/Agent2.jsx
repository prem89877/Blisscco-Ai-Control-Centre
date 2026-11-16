import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { Badge, Err, CodeBlock, usePoll, q } from './ui.jsx'

export async function callAgent2(action, params = {}) {
  const { data } = await supabase.auth.getSession()
  const token = data.session && data.session.access_token
  const r = await fetch('/api/agent2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ action, params })
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error || 'Request failed (' + r.status + ')')
  return body
}

export function useAgent2Heartbeat(enabled) {
  useEffect(() => {
    if (!enabled) return
    const ping = () => callAgent2('heartbeat').catch(() => {})
    ping()
    const t = setInterval(ping, 60000)
    return () => clearInterval(t)
  }, [enabled])
}

const SETUP = [['github', 'GitHub'], ['gemini', 'Gemini']]
const CHANGE_EXAMPLE = '{\n  "files": [\n    { "path": "src/example.js", "op": "update", "content": "...full new file..." }\n  ]\n}'

function Report({ res }) {
  const r = res.result || {}
  const waiting = res.status === 'awaiting_approval'
  const lines = []
  if (r.branch) lines.push('branch: ' + r.branch)
  if (r.commit_sha) lines.push('commit: ' + String(r.commit_sha).slice(0, 7))
  if (r.merge_sha) lines.push('merge: ' + String(r.merge_sha).slice(0, 7))
  if (r.base) lines.push('base: ' + r.base)
  if (r.overall) lines.push('CI: ' + r.overall)
  if (r.deployment_trigger) lines.push('deployment: ' + r.deployment_trigger)
  if (r.pr_url) lines.push('PR: ' + r.pr_url)
  if (r.compare_url) lines.push('compare: ' + r.compare_url)
  if (r.rollback) lines.push('rollback: ' + r.rollback)
  const files = (r.changed_files || []).map(f => f.op + ' ' + f.path + (f.added != null ? '  +' + f.added + ' -' + f.removed : '') + (f.sensitive ? '  [SENSITIVE]' : '')).join('\n')
  const runs = (r.runs || r.ci_runs || []).map(x => x.name + ' ' + x.status + '/' + (x.conclusion || '-') + ' ' + x.branch + '@' + x.sha).join('\n')
  return (
    <div className="card">
      <div className="row"><b>Result</b><Badge s={waiting ? 'awaiting_approval' : 'ok'} /></div>
      {r.ai_review && <CodeBlock label="ai review" tone="info" text={r.ai_review} />}
      {r.ai_note && <CodeBlock label="ai note" tone="warn" text={'AI review unavailable: ' + r.ai_note} />}
      {(r.warnings || []).length > 0 && <CodeBlock label="warnings" tone="warn" text={r.warnings.join('\n')} />}
      {files && <CodeBlock label={'changed files (' + r.changed_files.length + ')'} text={files} wrap={false} />}
      {lines.length > 0 && <CodeBlock label="summary" tone="good" text={lines.join('\n')} wrap={false} />}
      {runs && <CodeBlock label="github actions" text={runs} wrap={false} />}
      {(r.failed_jobs || []).length > 0 && <CodeBlock label="failed jobs" tone="bad" text={r.failed_jobs.map(j => j.job + ': ' + j.failed_steps.join(', ')).join('\n')} />}
      {r.next && <CodeBlock label="next step" tone="info" text={r.next} />}
      {r.content !== undefined && <CodeBlock label={r.path} wrap={false} text={r.content} />}
      {(r.top_level || r.files) && <CodeBlock label="files" wrap={false} text={r.top_level ? r.top_level.map(t => t.name + '  (' + t.files + ')').join('\n') : r.files.join('\n')} />}
      <details style={{ marginTop: 8 }}>
        <summary className="sub" style={{ cursor: 'pointer' }}>Raw data</summary>
        <CodeBlock label="json" wrap={false} text={JSON.stringify(r, null, 2).slice(0, 8000)} />
      </details>
    </div>
  )
}

function RepoPick({ repos, repo, setRepo }) {
  return (
    <select value={repo} onChange={e => setRepo(e.target.value)} disabled={!repos.length}>
      {!repos.length && <option value="">No repos in AGENT2_GITHUB_REPOS</option>}
      {repos.map(r => <option key={r} value={r}>{r}</option>)}
    </select>
  )
}

function Inspect({ repos, onResult, setErr }) {
  const [repo, setRepo] = useState('')
  const [path, setPath] = useState('')
  const [branch, setBranch] = useState('')
  const [busy, setBusy] = useState('')
  const r = repo || repos[0] || ''
  async function go(action, params) {
    setBusy(action); setErr('')
    try { onResult(await callAgent2(action, { repo: r, ...params })) } catch (e) { setErr(e.message) }
    setBusy('')
  }
  return (
    <div className="card">
      <b>Inspect &amp; monitor</b>
      <RepoPick repos={repos} repo={r} setRepo={setRepo} />
      <input placeholder="Branch (optional)" value={branch} onChange={e => setBranch(e.target.value)} autoCapitalize="none" />
      <input placeholder="File or folder path (optional)" value={path} onChange={e => setPath(e.target.value)} autoCapitalize="none" />
      <div className="actions">
        <button className="btn ghost" disabled={!!busy || !r} onClick={() => go('repo_inspect', { path: path || undefined, ref: branch || undefined })}>{busy === 'repo_inspect' ? 'Reading...' : 'Inspect'}</button>
        <button className="btn ghost" disabled={!!busy || !r} onClick={() => go('actions_status', { branch: branch || undefined })}>{busy === 'actions_status' ? 'Checking...' : 'GitHub Actions'}</button>
      </div>
    </div>
  )
}

function Propose({ repos, onResult, setErr }) {
  const [repo, setRepo] = useState('')
  const [title, setTitle] = useState('')
  const [json, setJson] = useState('')
  const [busy, setBusy] = useState(false)
  async function go() {
    setBusy(true); setErr('')
    try {
      const parsed = JSON.parse(json)
      onResult(await callAgent2('propose_change', { repo: repo || repos[0], title, files: Array.isArray(parsed) ? parsed : parsed.files }))
      setJson('')
    } catch (e) { setErr(e instanceof SyntaxError ? 'The change is not valid JSON: ' + e.message : e.message) }
    setBusy(false)
  }
  return (
    <div className="card">
      <b>Submit code</b> <span className="sub">(from you or Claude; nothing is written until you approve)</span>
      <RepoPick repos={repos} repo={repo || repos[0] || ''} setRepo={setRepo} />
      <input placeholder="Title, e.g. Fix login redirect" value={title} onChange={e => setTitle(e.target.value)} />
      <textarea rows={6} placeholder={CHANGE_EXAMPLE} value={json} onChange={e => setJson(e.target.value)} autoCapitalize="none" spellCheck="false" />
      <button className="btn" disabled={busy || !title || !json} onClick={go}>{busy ? 'Checking...' : 'Request approval'}</button>
    </div>
  )
}

function Fix({ repos, onResult, setErr }) {
  const [repo, setRepo] = useState('')
  const [paths, setPaths] = useState('')
  const [problem, setProblem] = useState('')
  const [log, setLog] = useState('')
  const [busy, setBusy] = useState(false)
  async function go() {
    setBusy(true); setErr('')
    try { onResult(await callAgent2('ai_fix', { repo: repo || repos[0], paths: paths.split(',').map(s => s.trim()).filter(Boolean), problem, error_log: log || undefined })); setProblem(''); setLog('') }
    catch (e) { setErr(e.message) }
    setBusy(false)
  }
  return (
    <div className="card">
      <b>Fix a bug with AI</b> <span className="sub">(Gemini drafts it; you still approve)</span>
      <RepoPick repos={repos} repo={repo || repos[0] || ''} setRepo={setRepo} />
      <input placeholder="Files, comma separated (max 5)" value={paths} onChange={e => setPaths(e.target.value)} autoCapitalize="none" />
      <textarea rows={3} placeholder="What is wrong?" value={problem} onChange={e => setProblem(e.target.value)} />
      <textarea rows={3} placeholder="Error log (optional)" value={log} onChange={e => setLog(e.target.value)} spellCheck="false" />
      <button className="btn" disabled={busy || !paths || !problem} onClick={go}>{busy ? 'Working...' : 'Draft fix'}</button>
    </div>
  )
}

function BranchRequest({ title, hint, action, repos, onResult, setErr }) {
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('')
  const [busy, setBusy] = useState(false)
  async function go() {
    setBusy(true); setErr('')
    try { onResult(await callAgent2(action, { repo: repo || repos[0], branch })) } catch (e) { setErr(e.message) }
    setBusy(false)
  }
  return (
    <div className="card">
      <b>{title}</b> <span className="sub">{hint}</span>
      <RepoPick repos={repos} repo={repo || repos[0] || ''} setRepo={setRepo} />
      <input placeholder="agent2/branch-name" value={branch} onChange={e => setBranch(e.target.value)} autoCapitalize="none" />
      <button className="btn" disabled={busy || !branch.startsWith('agent2/')} onClick={go}>Request approval</button>
    </div>
  )
}

const APPLY = {
  code_change: { action: 'apply_change', label: 'Create branch & commit', busy: 'Committing...', ack: 'sensitive_ack', ackValue: 'APPROVE-SENSITIVE', ackText: 'I confirm the SENSITIVE files in this change' },
  promote: { action: 'apply_promote', label: 'Merge now', busy: 'Merging...', ack: 'production_ack', ackValue: 'APPROVE-PRODUCTION', ackText: 'I confirm this PRODUCTION merge' },
  rollback: { action: 'apply_rollback', label: 'Rollback now', busy: 'Rolling back...', ack: 'production_ack', ackValue: 'APPROVE-PRODUCTION', ackText: 'I confirm this PRODUCTION rollback' }
}

function Apply({ a, onDone, onResult, setErr }) {
  const k = APPLY[a.details.kind]
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const d = a.details
  const needAck = d.kind === 'code_change' ? (d.sensitive_paths || []).length > 0 : Boolean(d.production)
  async function go() {
    setBusy(true); setErr('')
    try { onResult(await callAgent2(k.action, { approval_id: a.id, [k.ack]: ack ? k.ackValue : undefined })); onDone() }
    catch (e) { setErr(e.message) }
    setBusy(false)
  }
  return (
    <div className="card">
      <div className="row"><b>{a.title}</b><Badge s="approved" /></div>
      {d.kind === 'code_change' && <div className="sub">{d.files.length} file(s) to {d.branch}</div>}
      {needAck && <label className="sub" style={{ display: 'block', margin: '8px 0' }}><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} style={{ width: 'auto' }} /> {k.ackText}</label>}
      <button className="btn ok" disabled={busy || (needAck && !ack)} onClick={go}>{busy ? k.busy : k.label}</button>
    </div>
  )
}

export default function Agent2Panel() {
  const [hb, setHb] = useState(null)
  const [res, setRes] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => { callAgent2('heartbeat').then(setHb).catch(e => setErr(e.message)) }, [])

  const { data: ready, reload } = usePoll(() =>
    q(supabase.from('approvals').select('*').eq('status', 'approved').order('decided_at', { ascending: false }).limit(30)), [], 15000)
  const rows = (ready || []).filter(a => a.details && !a.details.executed_at)
  const remote = rows.filter(a => APPLY[a.details.kind])
  const termux = rows.filter(a => ['git_push', 'command'].includes(a.details.kind))
  const repos = (hb && hb.repos) || []

  return (
    <>
      <Err msg={err} />
      {hb && (
        <div className="card">
          <div className="row"><b>Setup</b><span className="sub">{hb.model}</span></div>
          <div className="filters" style={{ marginTop: 6 }}>{SETUP.map(([k, l]) => <span key={k} className={'badge ' + (hb.ready[k] ? 'good' : 'mute')}>{l}{hb.ready[k] ? ' ✓' : ' ✗'}</span>)}</div>
          <div className="sub" style={{ marginTop: 6 }}>Never writes to: {(hb.protected_branches || []).join(', ')}. Works only on agent2/* branches.</div>
        </div>
      )}
      {res && <Report res={res} />}
      {remote.length > 0 && <><div className="sec-title">Approved - ready to apply</div>{remote.map(a => <Apply key={a.id} a={a} onDone={reload} onResult={setRes} setErr={setErr} />)}</>}
      {termux.length > 0 && (
        <>
          <div className="sec-title">Approved - apply in Termux</div>
          {termux.map(a => (
            <div className="card" key={a.id}>
              <div className="row"><b>{a.title}</b><Badge s="approved" /></div>
              <CodeBlock label="termux" text={'npm run agent2 -- ' + (a.details.kind === 'git_push' ? 'apply-push' : 'apply-command') + ' --approval=' + a.id} />
            </div>
          ))}
        </>
      )}
      <Inspect repos={repos} onResult={setRes} setErr={setErr} />
      <Propose repos={repos} onResult={setRes} setErr={setErr} />
      <Fix repos={repos} onResult={setRes} setErr={setErr} />
      <BranchRequest title="Promote to production" hint="(PR + merge; needs approval and a PRODUCTION tick)" action="request_promote" repos={repos} onResult={setRes} setErr={setErr} />
      <BranchRequest title="Rollback a change" hint="(deletes the branch, or opens a revert PR if merged)" action="request_rollback" repos={repos} onResult={setRes} setErr={setErr} />
      <div className="sub">Local lint, type check, tests and shell commands run only in Termux: <code>npm run agent2 -- checks</code></div>
    </>
  )
}
