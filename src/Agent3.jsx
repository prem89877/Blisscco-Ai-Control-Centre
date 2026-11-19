import { BranchSelector, SelectedLine, selectedRepo } from './BranchSelector.jsx'
import { scopeParams } from './branchContext.js'
import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { Badge, Err, CodeBlock, usePoll, q } from './ui.jsx'
import { PendingInline } from './InlineApproval.jsx'

export async function callAgent3(action, params = {}) {
  const { data } = await supabase.auth.getSession()
  const token = data.session && data.session.access_token
  const r = await fetch('/api/agent3', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ action, params: scopeParams('agent3', action, params) })
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error || 'Request failed (' + r.status + ')')
  return body
}

export function useAgent3Heartbeat(enabled) {
  useEffect(() => {
    if (!enabled) return
    const ping = () => callAgent3('heartbeat').catch(() => {})
    ping()
    const t = setInterval(ping, 60000)
    return () => clearInterval(t)
  }, [enabled])
}

const SETUP = [['targets', 'Targets'], ['api_endpoints', 'API list'], ['supabase_mgmt', 'DB read'], ['github', 'GitHub'], ['gemini', 'Gemini']]
const TESTS = [
  ['website_smoke', 'Website + mobile'],
  ['auth_check', 'Login / roles'],
  ['api_test', 'API tests'],
  ['db_test', 'Database'],
  ['security_scan', 'Security'],
  ['full_report', 'Full report']
]
const SEV = { critical: 'bad', high: 'bad', medium: 'warn', low: 'mute', info: 'mute' }

function Report({ res, onRetest }) {
  const r = res.result || {}
  const waiting = res.status === 'awaiting_approval'
  const c = r.counts || {}
  const v = String(r.verdict || '').toLowerCase()
  const u = res.understood || r.understood
  return (
    <div className="card">
      <div className="row"><b>{r.title || 'Result'}</b><Badge s={res.status === 'queued' ? 'queued' : waiting ? 'awaiting_approval' : v === 'fail' ? 'failed' : (v === 'blocked' || res.status === 'blocked') ? 'warn' : v === 'attention' ? 'degraded' : 'ok'} /></div>
      {(r.repo || r.branch) && <CodeBlock label="GitHub branch context" tone="info" text={[r.repo && 'Repository: ' + r.repo, r.branch && 'Branch (selected): ' + r.branch, r.branch_sha && 'Commit: ' + String(r.branch_sha).slice(0, 7), (r.repo && r.branch && r.branch_sha) ? 'Used: ' + r.repo + ' @ ' + r.branch + ' @ ' + String(r.branch_sha).slice(0, 7) : null].filter(Boolean).join('\\n')} wrap={false} />}
      {u && <CodeBlock label={'understood: ' + (typeof u === 'string' ? u : u.intent)} tone="info" text={typeof u === 'string' ? u : (u.explanation || u.intent)} />}
      {r.unsupported && <CodeBlock label="not done" tone="warn" text={r.message} />}
      {r.verdict && <div className="sub" style={{ margin: '6px 0' }}>Verdict: <b>{String(r.verdict).toUpperCase()}</b>{r.reason ? ' (' + r.reason + ')' : ''}{r.tests_run != null && <> | {r.tests_passed}/{r.tests_run} checks ok</>}{r.counts && <> | critical {c.critical} | high {c.high} | medium {c.medium} | low {c.low}</>}</div>}
      {r.rate_limit && <CodeBlock label="rate limit" tone={String(r.rate_limit).startsWith('NOT TESTED') ? 'info' : 'warn'} text={r.rate_limit} />}
      {r.ai_summary && <CodeBlock label="ai summary" tone="info" text={r.ai_summary} />}
      {r.ai_note && <CodeBlock label="ai note" tone="warn" text={'AI summary unavailable: ' + r.ai_note} />}
      {r.retest && <CodeBlock label="retest" tone="good" text={['fixed: ' + r.retest.fixed.length, ...r.retest.fixed.map(x => '  + ' + x), 'still failing: ' + r.retest.still_failing.length, ...r.retest.still_failing.map(x => '  ! ' + x), 'new: ' + r.retest.new_findings.length, ...r.retest.new_findings.map(x => '  ? ' + x)].join('\n')} wrap={false} />}
      {(r.findings || []).length > 0 && (
        <>
          <div className="sec-title">Findings ({r.findings.length})</div>
          {r.findings.slice(0, 40).map((f, i) => (
            <div key={i} style={{ margin: '6px 0' }}>
              <span className={'badge ' + (SEV[f.severity] || 'mute')}>{f.severity}</span> <b>{f.title}</b>
              {f.target && <div className="sub">{f.target}</div>}
              <div className="sub">Evidence: {f.evidence}</div>
              <div className="sub">Fix: {f.fix}</div>
            </div>
          ))}
        </>
      )}
      {(r.evidence || []).length > 0 && <CodeBlock label={'evidence (' + r.evidence.length + ' checks)'} wrap={false} text={r.evidence.map(e => (e.ok ? 'PASS ' : 'FAIL ') + e.check + ' - ' + e.detail).join('\n')} />}
      {(r.commands || []).map((c, i) => <CodeBlock key={i} label={'$ ' + c.cmd + '  (exit ' + c.code + ')'} tone={c.code === 0 ? 'good' : 'warn'} wrap={false} text={c.output || '(no output)'} />)}
      {(r.not_run || []).length > 0 && <CodeBlock label="not run (setup missing)" tone="warn" text={r.not_run.join('\n')} />}
      {r.billing_safety && <CodeBlock label="billing safety" tone="good" text={r.billing_safety} />}
      {r.next && <CodeBlock label="next step" tone="info" text={r.next} />}
      {res.task_id && r.verdict && !r.retest && <button className="btn ghost" onClick={() => onRetest(res.task_id)}>Retest after fixing</button>}
      <details style={{ marginTop: 8 }}>
        <summary className="sub" style={{ cursor: 'pointer' }}>Raw data</summary>
        <CodeBlock label="json" wrap={false} text={JSON.stringify(r, null, 2).slice(0, 8000)} />
      </details>
    </div>
  )
}

function Pick({ options, value, set, empty }) {
  return (
    <select value={value} onChange={e => set(e.target.value)} disabled={!options.length}>
      {!options.length && <option value="">{empty}</option>}
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  )
}

function Apply({ a, onDone, onResult, setErr }) {
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  async function go() {
    setBusy(true); setErr('')
    try { onResult(await callAgent3('apply_rate_test', { approval_id: a.id, production_ack: ack ? 'APPROVE-PRODUCTION' : undefined })); onDone() }
    catch (e) { setErr(e.message) }
    setBusy(false)
  }
  return (
    <div className="card">
      <div className="row"><b>{a.title}</b><Badge s="approved" /></div>
      <div className="sub">{a.details.note}</div>
      <label className="sub" style={{ display: 'block', margin: '8px 0' }}><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} style={{ width: 'auto' }} /> I confirm this burst test on the live site</label>
      <button className="btn ok" disabled={busy || !ack} onClick={go}>{busy ? 'Running...' : 'Run rate test'}</button>
    </div>
  )
}

const LOCAL_PRESETS = [
  ['tests', 'Project tests (npm test)'],
  ['build', 'Build (npm run build)'],
  ['audit', 'Dependency audit'],
  ['secrets', 'Secret scan of local files'],
  ['git', 'Git status + .env safety'],
  ['env', 'Env variables (names only)'],
  ['system', 'Phone: Node, npm, disk'],
  ['project', 'Project files sanity']
]

function LocalCard({ busy, setBusy, setErr, setRes, setQueuedId, rows, reload }) {
  const [sel, setSel] = useState(['tests', 'git', 'secrets'])
  const [cmd, setCmd] = useState('')
  const toggle = id => setSel(s => (s.includes(id) ? s.filter(x => x !== id) : [...s, id]))
  async function go(label, fn) {
    setBusy(label); setErr('')
    try { const r = await fn(); setRes(r); if (r.status === 'queued') setQueuedId(r.task_id); return r } catch (e) { setErr(e.message) } finally { setBusy('') }
  }
  return (
    <>
      <div className="card">
        <b>Termux Checks</b> <span className="sub">(runs on your phone, not on Vercel)</span>
        <div style={{ margin: '8px 0' }}>
          {LOCAL_PRESETS.map(([id, label]) => (
            <label key={id} className="sub" style={{ display: 'block', margin: '4px 0' }}>
              <input type="checkbox" checked={sel.includes(id)} onChange={() => toggle(id)} style={{ width: 'auto' }} /> {label}
            </label>
          ))}
        </div>
        <div className="actions" style={{ flexWrap: 'wrap' }}>
          <button className="btn ghost" onClick={() => setSel(sel.length === LOCAL_PRESETS.length ? [] : LOCAL_PRESETS.map(p => p[0]))}>{sel.length === LOCAL_PRESETS.length ? 'Clear all' : 'Select all'}</button>
          <button className="btn" disabled={!!busy || !sel.length} onClick={() => go('local', () => callAgent3('queue_local', { presets: sel }))}>{busy === 'local' ? 'Queueing...' : 'Run on Termux'}</button>
        </div>
        <div className="sub" style={{ marginTop: 6 }}>Termux me: <code>npm run agent3 -- worker --once</code></div>
      </div>
      <div className="card">
        <b>Custom command</b> <span className="sub">(needs your approval)</span>
        <input placeholder="e.g. git status -sb  /  grep -rn TODO src" value={cmd} onChange={e => setCmd(e.target.value)} autoCapitalize="none" autoCorrect="off" />
        <button className="btn ghost" disabled={!!busy || !cmd.trim()} onClick={async () => { const r = await go('cmd', () => callAgent3('request_local_command', { command: cmd })); if (r) { setCmd(''); reload() } }}>{busy === 'cmd' ? 'Checking...' : 'Request approval'}</button>
        <div className="sub" style={{ marginTop: 6 }}>Sirf padhne wale commands: ls, cat, head, tail, wc, grep, find, du, df, git status/log/diff --stat, npm test/audit/ls. Delete, install, push, .env files aur shell symbols (; | &gt; $) blocked hain.</div>
      </div>
      {rows.length > 0 && <><div className="sec-title">Approved commands</div>{rows.map(a => (
        <div className="card" key={a.id}>
          <div className="row"><b style={{ wordBreak: 'break-all' }}>{a.details.command}</b><Badge s="approved" /></div>
          <button className="btn ok" disabled={!!busy} onClick={async () => { await go('queuecmd', () => callAgent3('queue_local_command', { approval_id: a.id })); reload() }}>{busy === 'queuecmd' ? 'Queueing...' : 'Queue on Termux'}</button>
        </div>
      ))}</>}
    </>
  )
}

export default function Agent3Panel() {
  const [hb, setHb] = useState(null)
  const [res, setRes] = useState(null)
  const [err, setErr] = useState('')
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState('')
  const [text, setText] = useState('')
  const [ratePath, setRatePath] = useState('')
  const [where, setWhere] = useState('vercel')
  const [queuedId, setQueuedId] = useState('')

  useEffect(() => { callAgent3('heartbeat').then(setHb).catch(e => setErr(e.message)) }, [])
  const { data: ready, reload } = usePoll(() =>
    q(supabase.from('approvals').select('*').eq('status', 'approved').order('decided_at', { ascending: false }).limit(30)), [], 15000)
  const rows = (ready || []).filter(a => a.details && a.details.kind === 'rate_test' && !a.details.executed_at)
  const localRows = (ready || []).filter(a => a.details && a.details.kind === 'local_command' && !a.details.executed_at)
  const targets = (hb && hb.targets) || []
  const repos = (hb && hb.repos) || []

  // Termux mode: the test is queued; the phone worker runs it; this page picks the result up.
  useEffect(() => {
    if (!queuedId) return
    const t = setInterval(async () => {
      try {
        const rows = await q(supabase.from('tasks').select('id,status,result,error_message').eq('id', queuedId).limit(1))
        const row = rows && rows[0]
        if (row && row.status === 'succeeded') { setRes({ task_id: row.id, status: 'succeeded', result: row.result }); setQueuedId('') }
        else if (row && ['failed', 'cancelled'].includes(row.status)) { setErr('Termux task ' + row.status + (row.error_message ? ': ' + row.error_message : '')); setQueuedId('') }
      } catch { /* keep polling */ }
    }, 4000)
    return () => clearInterval(t)
  }, [queuedId])

  const QUEUEABLE = ['website_smoke', 'auth_check', 'api_test', 'db_test', 'security_scan', 'full_report']
  async function run(action, params = {}) {
    setBusy(action); setErr('')
    try {
      const base = { target: target || targets[0], repo: selectedRepo('agent3', repos) || undefined } // repo comes from the BranchSelector only
      if (where === 'termux' && QUEUEABLE.includes(action)) {
        const r = await callAgent3('queue_task', { task: action, ...base })
        setRes(r); setQueuedId(r.task_id)
      } else setRes(await callAgent3(action, { ...base, ...params }))
    } catch (e) { setErr(e.message) }
    setBusy('')
  }

  return (
    <>
      <Err msg={err} />
      {hb && (
        <div className="card">
          <div className="row"><b>Setup</b><span className="sub">{hb.model}</span></div>
          <div className="filters" style={{ marginTop: 6 }}>{SETUP.map(([k, l]) => <span key={k} className={'badge ' + (hb.ready[k] ? 'good' : 'mute')}>{l}{hb.ready[k] ? ' ✓' : ' ✗'}</span>)}</div>
          <div className="sub" style={{ marginTop: 6 }}>{hb.safety}</div>
        </div>
      )}
      <BranchSelector agent="agent3" repos={repos} initialRepo={repos[0] || ''} call={callAgent3} />
      {res && <Report res={res} onRetest={id => run('retest', { task_id: id })} />}
      <PendingInline kinds={['rate_test', 'local_command']} onDone={reload} />
      {rows.length > 0 && <><div className="sec-title">Approved - ready to run</div>{rows.map(a => <Apply key={a.id} a={a} onDone={reload} onResult={setRes} setErr={setErr} />)}</>}
      <div className="card">
        <b>Run a test</b> <span className="sub">(read-only; nothing is billed or written)</span>
        <div className="filters" style={{ margin: '6px 0' }}>
          <button className={'btn' + (where === 'vercel' ? '' : ' ghost')} onClick={() => setWhere('vercel')}>Run now (Vercel)</button>
          <button className={'btn' + (where === 'termux' ? '' : ' ghost')} onClick={() => setWhere('termux')}>Run on Termux</button>
        </div>
        {where === 'termux' && <div className="sub">Termux me chalao: <code>npm run agent3 -- worker</code>. Result yahin aa jayega{queuedId ? ' (wait kar raha hoon...)' : ''}.</div>}
        <Pick options={targets} value={target || targets[0] || ''} set={setTarget} empty="Set AGENT3_TARGETS" />
        <SelectedLine agent="agent3" label="Repo scans (secrets, dependencies) read" />
        <div className="sub">Live website / API / DB checks always run against the live target, not a branch.</div>
        <div className="actions" style={{ flexWrap: 'wrap' }}>
          <button className="btn ghost" disabled={!!busy} onClick={() => run('ads_routes_check')}>{busy === 'ads_routes_check' ? 'Checking...' : 'Ads routes'}</button>
          <button className="btn ghost" disabled={!!busy} onClick={() => run('match_route_check')}>{busy === 'match_route_check' ? 'Checking...' : 'Match route'}</button>
          {TESTS.map(([a, l]) => <button key={a} className={'btn' + (a === 'full_report' ? '' : ' ghost')} disabled={!!busy || !targets.length} onClick={() => run(a)}>{busy === a ? 'Testing...' : l}</button>)}
        </div>
      </div>
      <LocalCard busy={busy} setBusy={setBusy} setErr={setErr} setRes={setRes} setQueuedId={setQueuedId} rows={localRows} reload={reload} />
      <div className="card">
        <b>Ask Agent 3</b> <span className="sub">(supported checks only; unsupported requests are BLOCKED)</span>
        <textarea rows={2} placeholder="e.g. api test karo / security check chalao" value={text} onChange={e => setText(e.target.value)} />
        <button className="btn" disabled={!!busy || !text.trim()} onClick={async () => { setBusy('ask'); setErr(''); try { setRes(await callAgent3('ai_command', { text })); setText('') } catch (e) { setErr(e.message) } setBusy('') }}>{busy === 'ask' ? 'Thinking...' : 'Do it'}</button>
      </div>
      <div className="card">
        <b>Optional burst test</b> <span className="sub">(OFF by default; separate approval + confirmation; hard cap 40 requests)</span>
        <input placeholder="/api/some-path (not a billing path)" value={ratePath} onChange={e => setRatePath(e.target.value)} autoCapitalize="none" />
        <button className="btn ghost" disabled={!!busy || !ratePath.startsWith('/') || !targets.length} onClick={() => run('request_rate_test', { path: ratePath })}>Request approval</button>
      </div>
      <div className="sub">Browser click-through (login, advertiser, publisher, admin, mobile) runs in GitHub Actions: Actions → QA Playwright → Run workflow. Termux: <code>npm run agent3 -- report</code> ya <code>worker</code></div>
    </>
  )
}
