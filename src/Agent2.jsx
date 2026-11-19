import { BranchSelector, SelectedLine, selectedRepo, useSelection } from './BranchSelector.jsx'
import { scopeParams } from './branchContext.js'
import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { Badge, Err, CodeBlock, usePoll, q } from './ui.jsx'
import { PendingInline } from './InlineApproval.jsx'

export async function callAgent2(action, params = {}) {
  const { data } = await supabase.auth.getSession()
  const token = data.session && data.session.access_token
  const r = await fetch('/api/agent2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ action, params: scopeParams('agent2', action, params) })
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
  if (r.base_branch) lines.push('base branch: ' + r.base_branch)
  if (r.base_sha) lines.push('base SHA: ' + String(r.base_sha).slice(0, 7))
  if (r.working_branch) lines.push('working branch: ' + r.working_branch)
  if (r.overall) lines.push('CI: ' + r.overall)
  if (r.deployment_trigger) lines.push('deployment: ' + r.deployment_trigger)
  if (r.pr_url) lines.push('PR: ' + r.pr_url)
  if (r.compare_url) lines.push('compare: ' + r.compare_url)
  if (r.rollback) lines.push('rollback: ' + r.rollback)
  if (r.workflow) lines.push('workflow: ' + r.workflow)
  if (r.started) lines.push('started: yes')
  const files = (r.changed_files || []).map(f => f.op + ' ' + f.path + (f.added != null ? '  +' + f.added + ' -' + f.removed : '') + (f.sensitive ? '  [SENSITIVE]' : '')).join('\n')
  const runs = (r.runs || r.ci_runs || []).map(x => x.name + ' ' + x.status + '/' + (x.conclusion || '-') + ' ' + x.branch + '@' + x.sha).join('\n')
  const sc = r.scope || {}
  const baseName = sc.base_branch || r.base_branch || r.ref || null
  const baseSha = sc.base_sha || r.base_sha || r.branch_sha || null
  const working = sc.working_branch || r.working_branch || null
  const commitDest = sc.commit_destination || r.commit_destination || null
  const ciTarget = sc.ci_target_branch || r.ci_target_branch || null
  const showScope = Boolean(baseName || working || ciTarget)
  return (
    <div className="card">
      <div className="row"><b>Result</b><Badge s={waiting ? 'awaiting_approval' : 'ok'} /></div>
      {showScope && <CodeBlock label="Base vs Working branch" tone="info" wrap={false} text={[
        (sc.repo || r.repo) ? 'Repository: ' + (sc.repo || r.repo) : null,
        'Base (selected): ' + (baseName || '-') + (baseSha ? ' @ ' + String(baseSha).slice(0, 7) : ''),
        'Working: ' + (working || 'none (read-only; nothing is written)'),
        'Commit destination: ' + (commitDest || (working ? working : 'none')) + (commitDest ? '  (the base branch is never written)' : ''),
        'CI target: ' + (ciTarget || '-')
      ].filter(Boolean).join('\n')} />}
      {lines.length > 0 && <CodeBlock label="GitHub branch context" tone="info" text={lines.join('\\n')} wrap={false} />}
      {res.understood && <CodeBlock label={'understood: ' + res.understood.intent} tone="info" text={res.understood.explanation || res.understood.intent} />}
      {r.needs_split && <CodeBlock label="too big for one proposal" tone="warn" text={r.message} />}
      {r.dev_report && <DevReport r={r.dev_report} />}
      {r.analysis && <CodeBlock label="CI diagnosis" tone="info" text={r.analysis} />}
      {r.ci && r.ci !== 'failing' && r.note && <CodeBlock label={'CI: ' + r.ci} tone={r.ci === 'passing' ? 'good' : ''} text={r.note} />}
      {r.unsupported && <CodeBlock label="not done" tone="warn" text={r.message} />}
      {r.branches && <CodeBlock label={'agent2 branches (' + r.branches.length + ')'} wrap={false} text={r.branches.join('\n') || 'none'} />}
      {r.ai_review && <CodeBlock label="ai review" tone="info" text={r.ai_review} />}
      {r.ai_note && <CodeBlock label="ai note" tone="warn" text={'AI review unavailable: ' + r.ai_note} />}
      {(r.warnings || []).length > 0 && <CodeBlock label="warnings" tone="warn" text={r.warnings.join('\n')} />}
      {files && <CodeBlock label={'changed files (' + r.changed_files.length + ')'} text={files} wrap={false} />}
      {lines.length > 0 && <CodeBlock label="summary" tone="good" text={lines.join('\n')} wrap={false} />}
      {runs && r.overall !== 'passing' && <CodeBlock label="github actions" text={runs} wrap={false} />}
      {(r.failed_jobs || []).length > 0 && <CodeBlock label="failed jobs" tone="bad" text={r.failed_jobs.map(j => j.job + ': ' + (j.failed_steps || []).join(', ')).join('\n')} />}
      {(r.failed_jobs || []).filter(j => j.log).map((j, i) => <CodeBlock key={i} label={'error log - ' + j.job} tone="bad" text={j.log} />)}
      {r.next && <CodeBlock label="next step" tone="info" text={r.next} />}
      {r.data && <CodeBlock label={'github ' + r.resource + (r.data.count !== undefined ? ' (' + r.data.count + ')' : '')} wrap={false} text={githubLines(r.resource, r.data)} />}
      {r.operation && <CodeBlock label={'github ' + r.operation} tone="good" wrap={false} text={[r.number ? '#' + r.number : null, r.url, r.state ? 'state: ' + r.state : null, r.labels ? 'labels: ' + r.labels.join(', ') : null].filter(Boolean).join('\n') || 'done'} />}
      {r.content !== undefined && <CodeBlock label={r.path} wrap={false} text={r.content} />}
      {(r.top_level || r.files) && <CodeBlock label="files" wrap={false} text={r.top_level ? r.top_level.map(t => t.name + '  (' + t.files + ')').join('\n') : r.files.join('\n')} />}
      <details style={{ marginTop: 8 }}>
        <summary className="sub" style={{ cursor: 'pointer' }}>Raw data</summary>
        <CodeBlock label="json" wrap={false} text={JSON.stringify(r, null, 2).slice(0, 8000)} />
      </details>
    </div>
  )
}

// One short line per item so a phone screen can read it; the full data stays under "Raw data".
function githubLines(resource, d) {
  if (!d) return ''
  if (resource === 'metadata') return [d.full_name, d.description, 'default branch: ' + d.default_branch, (d.private ? 'private' : 'public') + (d.archived ? ', archived' : ''), 'open issues: ' + d.open_issues, 'pushed: ' + d.pushed_at, d.url].filter(Boolean).join('\n')
  const items = d.items || []
  const line = x => {
    if (resource === 'pull_requests') return '#' + x.number + ' [' + x.state + '] ' + x.title + '  (' + x.head + ' -> ' + x.base + ')'
    if (resource === 'issues') return '#' + x.number + ' [' + x.state + '] ' + x.title
    if (resource === 'releases') return x.tag + '  ' + (x.name || '') + (x.prerelease ? '  [pre]' : '')
    if (resource === 'tags') return x.name + '  ' + String(x.sha || '').slice(0, 7)
    if (resource === 'commits') return String(x.sha).slice(0, 7) + ' ' + x.message
    if (resource === 'workflows') return x.name + '  (' + x.path + ')  ' + x.state
    if (resource === 'checks') return x.name + '  ' + x.status + '/' + (x.conclusion || '-')
    return JSON.stringify(x)
  }
  return (d.sha ? 'commit: ' + String(d.sha).slice(0, 7) + '\n' : '') + (items.map(line).join('\n') || 'none')
}

// There is NO per-card repository/branch picker: the BranchSelector above is the only control (repo + branch + SHA).
function RepoPick() {
  return <SelectedLine agent="agent2" label="Uses the selector above" />
}

function AskBox({ repos, onResult, setErr }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  async function go() {
    setBusy(true); setErr('')
    try { onResult(await callAgent2('ai_command', { repo: selectedRepo('agent2', repos), text })); setText('') } catch (e) { setErr(e.message) }
    setBusy(false)
  }
  return (
    <div className="card">
      <b>Quick command</b> <span className="sub">(one GitHub action: inspect files / PRs / issues / releases / tags / commits / CI, comment or open an issue, fix code, run a workflow, delete an agent2 branch)</span>
      <RepoPick />
      <textarea rows={3} placeholder="e.g. open issues dikhao / issue #12 pe comment karo: ... / ci workflow check karo / agent2 test branch delete karo" value={text} onChange={e => setText(e.target.value)} />
      <button className="btn" disabled={busy || !text.trim()} onClick={go}>{busy ? 'Thinking...' : 'Do it'}</button>
    </div>
  )
}

function Inspect({ repos, onResult, setErr }) {
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState('')
  const sel = useSelection('agent2') // follows the dropdown; this panel has NO branch field of its own
  async function go(action, params) {
    setBusy(action); setErr('')
    // only the repo + optional path are sent: branch/ref/base/SHA are attached from the dropdown selection by scopeParams
    try { onResult(await callAgent2(action, { repo: selectedRepo('agent2', repos), ...params })) } catch (e) { setErr(e.message) }
    setBusy('')
  }
  return (
    <div className="card">
      <b>Inspect &amp; monitor</b>
      <RepoPick />
      <div className="sub">Branch: <b>{sel ? sel.branch : '(none selected)'}</b> (change it in the selector above; it cannot be overridden here)</div>
      <input placeholder="File or folder path (optional)" value={path} onChange={e => setPath(e.target.value)} autoCapitalize="none" />
      <div className="actions">
        <button className="btn ghost" disabled={!!busy || !sel} onClick={() => go('repo_inspect', { path: path || undefined })}>{busy === 'repo_inspect' ? 'Reading...' : 'Inspect'}</button>
        <button className="btn ghost" disabled={!!busy || !sel} onClick={() => go('actions_status', {})}>{busy === 'actions_status' ? 'Checking...' : 'GitHub Actions'}</button>
      </div>
    </div>
  )
}

function GithubDesk({ repos, onResult, setErr }) {
  const RES = [['pull_requests', 'Pull requests'], ['issues', 'Issues'], ['releases', 'Releases'], ['tags', 'Tags'], ['commits', 'Commits'], ['workflows', 'Workflows'], ['metadata', 'Repo info'], ['checks', 'Commit checks']]
  const OPS = [['create_issue', 'Open issue'], ['comment', 'Comment on issue / PR'], ['add_labels', 'Add labels'], ['close_issue', 'Close issue'], ['reopen_issue', 'Reopen issue']]
  const [resource, setResource] = useState('pull_requests')
  const [op, setOp] = useState('create_issue')
  const [number, setNumber] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [labels, setLabels] = useState('')
  const [busy, setBusy] = useState('')
  const sel = useSelection('agent2')
  async function run(kind, action, params) {
    setBusy(kind); setErr('')
    try { onResult(await callAgent2(action, { repo: selectedRepo('agent2', repos), ...params })) } catch (e) { setErr(e.message) }
    setBusy('')
  }
  return (
    <div className="card">
      <b>GitHub desk</b> <span className="sub">(read pull requests, issues, releases, tags, commits, checks; open or comment on issues. Works on the repo above; it never changes code, branches, releases, tags or settings)</span>
      <RepoPick />
      <select value={resource} onChange={e => setResource(e.target.value)}>{RES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      {(resource === 'commits' || resource === 'checks') && <div className="sub">Branch: <b>{sel ? sel.branch : 'repository default'}</b></div>}
      <button className="btn ghost" disabled={!!busy} onClick={() => run('read', 'github_resource', { resource, ref: (resource === 'commits' || resource === 'checks') && sel ? sel.branch : undefined })}>{busy === 'read' ? 'Reading...' : 'Show'}</button>
      <div className="sec-title">Issue actions</div>
      <select value={op} onChange={e => setOp(e.target.value)}>{OPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      {op !== 'create_issue' && <input placeholder="Issue / PR number" inputMode="numeric" value={number} onChange={e => setNumber(e.target.value.replace(/\D/g, ''))} />}
      {op === 'create_issue' && <input placeholder="Title" value={title} onChange={e => setTitle(e.target.value)} />}
      {(op === 'create_issue' || op === 'comment') && <textarea rows={3} placeholder="Text" value={body} onChange={e => setBody(e.target.value)} />}
      {(op === 'create_issue' || op === 'add_labels') && <input placeholder="Labels (comma separated)" value={labels} onChange={e => setLabels(e.target.value)} autoCapitalize="none" />}
      <button className="btn" disabled={!!busy} onClick={() => run('write', 'github_write', { operation: op, number: number ? Number(number) : undefined, title, body, labels: labels.split(',').map(x => x.trim()).filter(Boolean) })}>{busy === 'write' ? 'Sending...' : 'Do it'}</button>
    </div>
  )
}

function Propose({ repos, onResult, setErr }) {
  const [title, setTitle] = useState('')
  const [json, setJson] = useState('')
  const [busy, setBusy] = useState(false)
  async function go() {
    setBusy(true); setErr('')
    try {
      const parsed = JSON.parse(json)
      onResult(await callAgent2('propose_change', { repo: selectedRepo('agent2', repos), title, files: Array.isArray(parsed) ? parsed : parsed.files }))
      setJson('')
    } catch (e) { setErr(e instanceof SyntaxError ? 'The change is not valid JSON: ' + e.message : e.message) }
    setBusy(false)
  }
  return (
    <div className="card">
      <b>Submit code</b> <span className="sub">(from you or Claude; nothing is written until you approve)</span>
      <RepoPick />
      <input placeholder="Title, e.g. Fix login redirect" value={title} onChange={e => setTitle(e.target.value)} />
      <textarea rows={6} placeholder={CHANGE_EXAMPLE} value={json} onChange={e => setJson(e.target.value)} autoCapitalize="none" spellCheck="false" />
      <button className="btn" disabled={busy || !title || !json} onClick={go}>{busy ? 'Checking...' : 'Request approval'}</button>
    </div>
  )
}

function Fix({ repos, onResult, setErr }) {
  const [paths, setPaths] = useState('')
  const [problem, setProblem] = useState('')
  const [log, setLog] = useState('')
  const [busy, setBusy] = useState(false)
  async function go() {
    setBusy(true); setErr('')
    try { onResult(await callAgent2('ai_fix', { repo: selectedRepo('agent2', repos), paths: paths.split(',').map(s => s.trim()).filter(Boolean), problem, error_log: log || undefined })); setProblem(''); setLog('') }
    catch (e) { setErr(e.message) }
    setBusy(false)
  }
  return (
    <div className="card">
      <b>Fix a bug with AI</b> <span className="sub">(Gemini drafts it; you still approve)</span>
      <RepoPick />
      <input placeholder="Files, comma separated (max 5)" value={paths} onChange={e => setPaths(e.target.value)} autoCapitalize="none" />
      <textarea rows={3} placeholder="What is wrong?" value={problem} onChange={e => setProblem(e.target.value)} />
      <textarea rows={3} placeholder="Error log (optional)" value={log} onChange={e => setLog(e.target.value)} spellCheck="false" />
      <button className="btn" disabled={busy || !paths || !problem} onClick={go}>{busy ? 'Working...' : 'Draft fix'}</button>
    </div>
  )
}

function BranchRequest({ title, hint, action, repos, onResult, setErr }) {
  const [branch, setBranch] = useState('')
  const [busy, setBusy] = useState(false)
  async function go() {
    setBusy(true); setErr('')
    try { onResult(await callAgent2(action, { repo: selectedRepo('agent2', repos), branch })) } catch (e) { setErr(e.message) }
    setBusy(false)
  }
  return (
    <div className="card">
      <b>{title}</b> <span className="sub">{hint}</span>
      <RepoPick />
      <input placeholder="agent2/branch-name" value={branch} onChange={e => setBranch(e.target.value)} autoCapitalize="none" />
      <button className="btn" disabled={busy || !branch.startsWith('agent2/')} onClick={go}>Request approval</button>
    </div>
  )
}

const APPLY = {
  code_change: { action: 'apply_change', label: 'Create branch & commit', busy: 'Committing...', ack: 'sensitive_ack', ackValue: 'APPROVE-SENSITIVE', ackText: 'I confirm the SENSITIVE files in this change' },
  promote: { action: 'apply_promote', label: 'Merge now', busy: 'Merging...', ack: 'production_ack', ackValue: 'APPROVE-PRODUCTION', ackText: 'I confirm this PRODUCTION merge' },
  workflow_run: { action: 'apply_workflow', label: 'Run workflow', busy: 'Starting...', ack: 'production_ack', ackValue: 'APPROVE-PRODUCTION', ackText: 'I confirm running this workflow on a PROTECTED branch' },
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
    try { onResult(await callAgent2(k.action, { repo: d.repo, approval_id: a.id, [k.ack]: ack ? k.ackValue : undefined })); onDone() } // repo => its saved branch selection is validated against this approval's recorded base
    catch (e) { setErr(e.message) }
    setBusy(false)
  }
  return (
    <div className="card">
      <div className="row"><b>{a.title}</b><Badge s="approved" /></div>
      {d.kind === 'code_change' && <div className="sub">{d.repo} | base: {d.base_branch}@{String(d.base_sha || '').slice(0, 7)} | working: {d.working_branch || d.branch} | commit: {d.commit_destination || d.branch} | CI: {d.ci_target_branch || d.branch} | {d.files.length} file(s)</div>}
      {d.kind === 'code_change' && d.mode === 'append' && <div className="sub">Adds ONE commit to the existing branch {d.branch}@{String(d.parent_sha || '').slice(0, 7)} (no new branch).</div>}
      {d.kind !== 'code_change' && <div className="sub">{d.repo} | base: {d.base_branch || d.ref || '-'}{d.base_sha ? '@' + String(d.base_sha).slice(0, 7) : ''}{d.branch ? ' | working: ' + d.branch : ''}{d.ref && d.ref.startsWith('agent2/') ? ' | working: ' + d.ref : ''}</div>}
      <SelectedLine agent="agent2" label="Selector" />
      {needAck && <label className="sub" style={{ display: 'block', margin: '8px 0' }}><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} style={{ width: 'auto' }} /> {k.ackText}</label>}
      <button className="btn ok" disabled={busy || (needAck && !ack)} onClick={go}>{busy ? k.busy : k.label}</button>
    </div>
  )
}


const KINDS = [['feature', 'Feature'], ['bugfix', 'Bug fix'], ['improvement', 'Improvement'], ['refactor', 'Refactor'], ['architecture', 'Architecture'], ['tests', 'Tests'], ['docs', 'Docs']]
const STAGE = { inspect: 'Reading repository', plan: 'Planning', generate: 'Writing code', static_checks: 'Static checks', review: 'Code review', submit: 'Creating approval', awaiting_approval: 'Waiting for your approval', needs_split: 'Needs splitting' }

function DevReport({ r }) {
  if (!r) return null
  const ran = (r.checks && r.checks.ran) || []
  return (
    <div>
      {r.summary && <CodeBlock label="what & why" tone="info" text={[r.summary, r.review && r.review.what_changed, r.review && r.review.why].filter(Boolean).join('\n\n')} />}
      {r.approach && <CodeBlock label="approach" text={r.approach + (r.pros_cons ? '\n\nPros/cons: ' + r.pros_cons : '')} />}
      <CodeBlock label={'files (' + (r.files || []).length + ')'} wrap={false} text={(r.files || []).map(f => f.op + ' ' + f.path + (f.why ? '  - ' + f.why : '')).join('\n')} />
      {r.checks && <CodeBlock label="checks" tone={r.checks.all_ran_passed ? 'good' : 'bad'} text={'RAN (' + ran.length + '): ' + (ran.every(x => x.ok) ? 'all passed' : 'some failed') + ' - ' + ran.slice(0, 6).map(x => x.name).join(', ') + (ran.length > 6 ? ', ...' : '') + '\n\nNOT RUN: ' + (r.checks.not_run || []).join(', ') + '\n' + (r.checks.not_run_reason || '')} />}
      {r.review && <CodeBlock label={'code review: ' + r.review.verdict} tone={r.review.verdict === 'approve' ? 'good' : 'warn'} text={[r.review.summary, ...(r.review.findings || []).map(f => '[' + f.severity + '/' + f.area + '] ' + f.text), ...(r.review.missing || []).map(m => 'missing: ' + m)].filter(Boolean).join('\n') || 'No review text'} />}
      {((r.risks || []).length > 0 || (r.security || []).length > 0 || (r.breaking_changes || []).length > 0) && <CodeBlock label="risks & security" tone="warn" text={[...(r.risks || []).map(x => 'risk: ' + x), ...(r.security || []).map(x => 'security: ' + x), ...(r.breaking_changes || []).map(x => 'breaking: ' + x), ...(r.dependencies || []).map(x => 'depends: ' + x)].join('\n')} />}
      {(r.tests_planned || []).length > 0 && <CodeBlock label="tests planned (not run)" text={r.tests_planned.join('\n')} />}
      {r.expected_result && <CodeBlock label="expected result" text={r.expected_result} />}
      {r.generation && <div className="sub">{r.generation.batches} batch(es), {r.generation.fix_rounds_used} fix round(s)</div>}
      {(r.remaining || []).length > 0 && <CodeBlock label="remaining" tone="warn" text={r.remaining.join('\n')} />}
    </div>
  )
}

function Chat({ repos, onResult, setErr, goTab }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [msgs, setMsgs] = useState([])
  async function go() {
    const message = text.trim(); if (!message) return
    const history = msgs.slice(-10).map(m => ({ role: m.role, text: m.text }))
    setMsgs(m => [...m, { role: 'user', text: message }]); setText(''); setBusy(true); setErr('')
    try {
      const r = await callAgent2('dev_chat', { repo: selectedRepo('agent2', repos) || undefined, message, history })
      setMsgs(m => [...m, { role: 'assistant', text: r.answer || '', mode: r.mode, agent: r.responsible_agent, res: r.mode === 'proposal' ? r : null, files: r.context_files }])
      if (r.mode === 'proposal') onResult(r)
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }
  return (
    <div className="card">
      <b>Ask Agent 2</b> <span className="sub">(Hindi / English / Hinglish. Questions get answers; build requests become a proposal for your approval)</span>
      <RepoPick />
      {msgs.map((m, i) => (
        <div key={i} className="msg" style={m.role === 'user' ? { background: 'transparent' } : undefined}>
          <b>{m.role === 'user' ? 'You' : 'Agent 2'}</b>
          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 4 }}>{m.text}</div>
          {m.mode === 'unsupported' && <div className="sub" style={{ marginTop: 6 }}>Not Agent 2's job{m.agent ? ': ask ' + m.agent.replace('agent', 'Agent ') : ''}.</div>}
          {m.files && m.files.length > 0 && <div className="sub" style={{ marginTop: 6 }}>Read: {m.files.join(', ')}</div>}
          {m.res && <div className="sub" style={{ marginTop: 6 }}>Proposal sent to Approvals. <a href="#pending" onClick={e => { e.preventDefault(); goTab('pending') }}>Open Pending</a></div>}
        </div>
      ))}
      <textarea rows={3} placeholder="e.g. Login flow kaise kaam karta hai? / Settings page mein dark-mode toggle add karo" value={text} onChange={e => setText(e.target.value)} />
      <div className="actions">
        <button className="btn" disabled={busy || !text.trim()} onClick={go}>{busy ? 'Thinking...' : 'Send'}</button>
        {msgs.length > 0 && <button className="btn ghost" disabled={busy} onClick={() => setMsgs([])}>New chat</button>}
      </div>
    </div>
  )
}

function ProposalForm({ title, hint, defaultKind, fixedKind, placeholder, initialText, repos, onResult, setErr }) {
  const [kind, setKind] = useState(defaultKind || 'feature')
  const [request, setRequest] = useState(initialText || '')
  const [paths, setPaths] = useState('')
  const [contBranch, setContBranch] = useState('')
  const [busy, setBusy] = useState(false)
  async function go() {
    setBusy(true); setErr('')
    try { onResult(await callAgent2('dev_proposal', { repo: selectedRepo('agent2', repos), kind: fixedKind || kind, request, paths: paths.split(',').map(x => x.trim()).filter(Boolean), ...(contBranch.trim() ? { continue_branch: contBranch.trim() } : {}) })); setRequest('') }
    catch (e) { setErr(e.message) }
    setBusy(false)
  }
  return (
    <div className="card">
      <b>{title}</b> <span className="sub">{hint}</span>
      <RepoPick />
      {!fixedKind && <select value={kind} onChange={e => setKind(e.target.value)}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}
      <textarea rows={4} placeholder={placeholder} value={request} onChange={e => setRequest(e.target.value)} />
      <input placeholder="Files to look at (optional, comma separated)" value={paths} onChange={e => setPaths(e.target.value)} autoCapitalize="none" />
      <input placeholder="Continue on existing agent2/* branch (optional; empty = new branch)" value={contBranch} onChange={e => setContBranch(e.target.value)} autoCapitalize="none" />
      <button className="btn" disabled={busy || !request.trim() || !repos.length} onClick={go}>{busy ? 'Working (plan, code, review)... may take a minute' : 'Create proposal'}</button>
    </div>
  )
}

const ASSIST = {
  explain: { title: 'Explain code', ph: 'Which file or concept should I explain? e.g. api/agent2.js kya karta hai?', btn: 'Explain' },
  debug: { title: 'Debug error', ph: 'What is going wrong?', btn: 'Find the cause', log: true },
  review: { title: 'Review code', ph: 'What should I review? (security, performance, scalability, maintainability)', btn: 'Review' },
  plan: { title: 'Development plan', ph: 'Describe the feature or change to plan (no code is written)', btn: 'Make plan' },
  docs: { title: 'Write documentation', ph: 'What should be documented?', btn: 'Write docs' }
}
function Assist({ kind, repos, setErr, onPropose }) {
  const c = ASSIST[kind]
  const [text, setText] = useState('')
  const [paths, setPaths] = useState('')
  const [log, setLog] = useState('')
  const [busy, setBusy] = useState(false)
  const [out, setOut] = useState(null)
  async function go() {
    setBusy(true); setErr(''); setOut(null)
    try { setOut(await callAgent2('dev_assist', { kind, repo: selectedRepo('agent2', repos) || undefined, text, error_log: log || undefined, paths: paths.split(',').map(x => x.trim()).filter(Boolean) })) } catch (e) { setErr(e.message) }
    setBusy(false)
  }
  return (
    <div className="card">
      <b>{c.title}</b> <span className="sub">(answer only; nothing is changed)</span>
      <RepoPick />
      <input placeholder="Files (optional, comma separated)" value={paths} onChange={e => setPaths(e.target.value)} autoCapitalize="none" />
      <textarea rows={3} placeholder={c.ph} value={text} onChange={e => setText(e.target.value)} />
      {c.log && <textarea rows={3} placeholder="Error log / stack trace" value={log} onChange={e => setLog(e.target.value)} spellCheck="false" />}
      <div className="actions">
        <button className="btn" disabled={busy || (!text.trim() && !paths.trim() && !log.trim())} onClick={go}>{busy ? 'Thinking...' : c.btn}</button>
        {out && (kind === 'debug' || kind === 'plan' || kind === 'review') && onPropose && <button className="btn ghost" onClick={() => onPropose(kind === 'debug' ? 'bugfix' : kind === 'review' ? 'improvement' : 'feature', (text + (log ? '\nError: ' + log.slice(0, 1500) : '')).trim(), paths)}>Turn into proposal</button>}
      </div>
      {out && <CodeBlock label={kind} tone="info" text={out.answer} />}
      {out && out.omitted && out.omitted.length > 0 && <div className="sub">Not read: {out.omitted.join(', ')}</div>}
    </div>
  )
}

function Progress() {
  const { data } = usePoll(() => q(supabase.from('tasks').select('id,title,status,payload,error_message,created_at').like('title', 'Dev proposal%').order('created_at', { ascending: false }).limit(8)), [], 4000)
  const rows = data || []
  if (!rows.length) return <div className="card"><b>Implementation progress</b><div className="sub">No development runs yet.</div></div>
  return (
    <>
      {rows.map(t => {
        const st = (t.payload && t.payload.progress) || []
        const last = st[st.length - 1]
        return (
          <div className="card" key={t.id}>
            <div className="row"><b>{t.title.replace('Dev proposal ', '')}</b><Badge s={t.status} /></div>
            <div className="sub">{last ? (STAGE[last.stage] || last.stage) + (last.note ? ' - ' + last.note : '') : 'starting'}</div>
            <div className="filters" style={{ marginTop: 6 }}>{['inspect', 'plan', 'generate', 'static_checks', 'review', 'submit'].map(k => <span key={k} className={'badge ' + (st.some(x => x.stage === k) ? (t.status === 'running' && last && last.stage === k ? 'warn' : 'good') : 'mute')}>{STAGE[k]}</span>)}</div>
            {t.error_message && <CodeBlock label="stopped" tone="bad" text={t.error_message} />}
          </div>
        )
      })}
    </>
  )
}

function Proposals({ mode, onResult, setErr }) {
  const { data, reload } = usePoll(() => q(supabase.from('approvals').select('*').eq('details->>kind', 'code_change').order('requested_at', { ascending: false }).limit(15)), [], 8000)
  const [open, setOpen] = useState('')
  const [busy, setBusy] = useState('')
  const all = (data || []).filter(a => a.details)
  const rows = mode === 'pending' ? all.filter(a => !a.details.executed_at && ['pending', 'approved'].includes(a.status)) : all.filter(a => a.details.dev_report)
  async function ci(a) {
    setBusy(a.id); setErr('')
    try { onResult(await callAgent2('dev_diagnose', { repo: a.details.repo, branch: a.details.branch })) } catch (e) { setErr(e.message) }
    setBusy('')
  }
  if (!rows.length) return <div className="card"><b>{mode === 'pending' ? 'Pending proposals' : 'Final development reports'}</b><div className="sub">{mode === 'pending' ? 'Nothing waiting.' : 'No AI-generated proposals yet.'}</div></div>
  return (
    <>
      {rows.map(a => (
        <div className="card" key={a.id}>
          <div className="row"><b>{a.title}</b><Badge s={a.details.executed_at ? 'ok' : a.status} /></div>
          <div className="sub">{(a.details.files || []).length} file(s) &rarr; working: {a.details.branch} | base: {a.details.base_branch || '-'} @ {String(a.details.base_sha || '').slice(0, 7)}{a.details.commit_sha ? ' | commit @' + String(a.details.commit_sha).slice(0, 7) : ''}</div>
          {(a.details.warnings || []).length > 0 && <CodeBlock label="warnings" tone="warn" text={a.details.warnings.join('\n')} />}
          <div className="actions">
            <button className="btn ghost" onClick={() => setOpen(open === a.id ? '' : a.id)}>{open === a.id ? 'Hide' : mode === 'pending' ? 'Details' : 'Report'}</button>
            {a.details.executed_at && <button className="btn ghost" disabled={busy === a.id} onClick={() => ci(a)}>{busy === a.id ? 'Checking...' : 'Check CI'}</button>}
            {mode === 'pending' && a.status === 'pending' && <span className="sub">Approve in the list above.</span>}
          </div>
          {open === a.id && (a.details.dev_report ? <DevReport r={a.details.dev_report} /> : <CodeBlock label="review" tone="info" text={a.details.ai_review || 'No report stored'} />)}
        </div>
      ))}
      <button className="btn ghost" onClick={reload}>Refresh</button>
    </>
  )
}

const TABS = [['ask', 'Ask'], ['proposal', 'Proposal'], ['build', 'Build'], ['explain', 'Explain'], ['debug', 'Debug'], ['review', 'Review'], ['plan', 'Plan'], ['pending', 'Pending'], ['progress', 'Progress'], ['report', 'Reports'], ['tools', 'Tools']]

export default function Agent2Panel() {
  const [hb, setHb] = useState(null)
  const [res, setRes] = useState(null)
  const [err, setErr] = useState('')
  const [tab, setTab] = useState('ask')
  const [prefill, setPrefill] = useState(null)

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
      <BranchSelector agent="agent2" repos={repos} initialRepo={repos[0] || ''} call={callAgent2} />
      {res && <Report res={res} />}
      <PendingInline kinds={[...Object.keys(APPLY), 'git_push', 'command']} onDone={reload} />
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
      <div className="filters">{TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === 'ask' && <Chat repos={repos} onResult={setRes} setErr={setErr} goTab={setTab} />}
      {tab === 'proposal' && <ProposalForm key={prefill ? prefill.n : 'p'} title="Generate development proposal" hint="(Agent 2 reads the repo, plans, writes the code, reviews it, then sends it to Approvals. No JSON needed)" defaultKind={prefill ? prefill.kind : 'feature'} initialText={prefill ? prefill.text : ''} placeholder="Describe the feature, bug fix, improvement or architecture change" repos={repos} onResult={setRes} setErr={setErr} />}
      {tab === 'build' && <ProposalForm title="Build feature" hint="(complete module: new files + edits to existing files)" fixedKind="feature" placeholder="e.g. Add a notes page with create / edit / delete, with tests" repos={repos} onResult={setRes} setErr={setErr} />}
      {['explain', 'debug', 'review', 'plan'].includes(tab) && <Assist key={tab} kind={tab} repos={repos} setErr={setErr} onPropose={(kind, text) => { setPrefill({ kind, text, n: Date.now() }); setTab('proposal') }} />}
      {tab === 'pending' && <Proposals mode="pending" onResult={setRes} setErr={setErr} />}
      {tab === 'progress' && <Progress />}
      {tab === 'report' && <Proposals mode="report" onResult={setRes} setErr={setErr} />}
      {tab === 'tools' && (
        <>
          <AskBox repos={repos} onResult={setRes} setErr={setErr} />
        <Inspect repos={repos} onResult={setRes} setErr={setErr} />
        <GithubDesk repos={repos} onResult={setRes} setErr={setErr} />
        <Propose repos={repos} onResult={setRes} setErr={setErr} />
        <Fix repos={repos} onResult={setRes} setErr={setErr} />
        <BranchRequest title="Promote to production" hint="(PR + merge; needs approval and a PRODUCTION tick)" action="request_promote" repos={repos} onResult={setRes} setErr={setErr} />
        <BranchRequest title="Delete Agent 2 branch" hint="(only that agent2/* branch is deleted; nothing else changes. Needs approval)" action="request_rollback" repos={repos} onResult={setRes} setErr={setErr} />
        </>
      )}
      <div className="sub">Local lint, type check, tests and shell commands run only in Termux: <code>npm run agent2 -- checks</code></div>
    </>
  )
}
