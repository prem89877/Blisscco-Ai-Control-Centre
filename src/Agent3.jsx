import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { Badge, Err, CodeBlock, usePoll, q } from './ui.jsx'

export async function callAgent3(action, params = {}) {
  const { data } = await supabase.auth.getSession()
  const token = data.session && data.session.access_token
  const r = await fetch('/api/agent3', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ action, params })
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
  return (
    <div className="card">
      <div className="row"><b>{r.title || 'Result'}</b><Badge s={res.status === 'queued' ? 'queued' : waiting ? 'awaiting_approval' : r.verdict === 'fail' ? 'failed' : r.verdict === 'attention' ? 'degraded' : 'ok'} /></div>
      {res.understood && <CodeBlock label={'understood: ' + res.understood.intent} tone="info" text={res.understood.explanation || res.understood.intent} />}
      {r.unsupported && <CodeBlock label="not done" tone="warn" text={r.message} />}
      {r.verdict && <div className="sub" style={{ margin: '6px 0' }}>Verdict: <b>{r.verdict.toUpperCase()}</b> | {r.tests_passed}/{r.tests_run} checks ok | critical {c.critical} | high {c.high} | medium {c.medium} | low {c.low}</div>}
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

export default function Agent3Panel() {
  const [hb, setHb] = useState(null)
  const [res, setRes] = useState(null)
  const [err, setErr] = useState('')
  const [target, setTarget] = useState('')
  const [repo, setRepo] = useState('')
  const [busy, setBusy] = useState('')
  const [text, setText] = useState('')
  const [ratePath, setRatePath] = useState('')
  const [where, setWhere] = useState('vercel')
  const [queuedId, setQueuedId] = useState('')

  useEffect(() => { callAgent3('heartbeat').then(setHb).catch(e => setErr(e.message)) }, [])
  const { data: ready, reload } = usePoll(() =>
    q(supabase.from('approvals').select('*').eq('status', 'approved').order('decided_at', { ascending: false }).limit(30)), [], 15000)
  const rows = (ready || []).filter(a => a.details && a.details.kind === 'rate_test' && !a.details.executed_at)
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
      const base = { target: target || targets[0], repo: repo || repos[0] }
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
      {res && <Report res={res} onRetest={id => run('retest', { task_id: id })} />}
      {rows.length > 0 && <><div className="sec-title">Approved - ready to run</div>{rows.map(a => <Apply key={a.id} a={a} onDone={reload} onResult={setRes} setErr={setErr} />)}</>}
      <div className="card">
        <b>Run a test</b> <span className="sub">(read-only; nothing is billed or written)</span>
        <div className="filters" style={{ margin: '6px 0' }}>
          <button className={'btn' + (where === 'vercel' ? '' : ' ghost')} onClick={() => setWhere('vercel')}>Run now (Vercel)</button>
          <button className={'btn' + (where === 'termux' ? '' : ' ghost')} onClick={() => setWhere('termux')}>Run on Termux</button>
        </div>
        {where === 'termux' && <div className="sub">Termux me chalao: <code>npm run agent3 -- worker</code>. Result yahin aa jayega{queuedId ? ' (wait kar raha hoon...)' : ''}.</div>}
        <Pick options={targets} value={target || targets[0] || ''} set={setTarget} empty="Set AGENT3_TARGETS" />
        <Pick options={repos} value={repo || repos[0] || ''} set={setRepo} empty="No repo (secret/dependency scan skipped)" />
        <div className="actions" style={{ flexWrap: 'wrap' }}>
          {TESTS.map(([a, l]) => <button key={a} className={'btn' + (a === 'full_report' ? '' : ' ghost')} disabled={!!busy || !targets.length} onClick={() => run(a)}>{busy === a ? 'Testing...' : l}</button>)}
        </div>
      </div>
      <div className="card">
        <b>Ask Agent 3</b> <span className="sub">(AI picks ONE read-only test)</span>
        <textarea rows={2} placeholder="e.g. api test karo / security check chalao" value={text} onChange={e => setText(e.target.value)} />
        <button className="btn" disabled={!!busy || !text.trim()} onClick={async () => { setBusy('ask'); setErr(''); try { setRes(await callAgent3('ai_command', { text })); setText('') } catch (e) { setErr(e.message) } setBusy('') }}>{busy === 'ask' ? 'Thinking...' : 'Do it'}</button>
      </div>
      <div className="card">
        <b>Rate-limit test</b> <span className="sub">(needs approval + confirmation; anonymous GETs only)</span>
        <input placeholder="/api/some-path (not a billing path)" value={ratePath} onChange={e => setRatePath(e.target.value)} autoCapitalize="none" />
        <button className="btn ghost" disabled={!!busy || !ratePath.startsWith('/') || !targets.length} onClick={() => run('request_rate_test', { path: ratePath })}>Request approval</button>
      </div>
      <div className="sub">Browser click-through (login, advertiser, publisher, admin, mobile) runs in GitHub Actions: Actions → QA Playwright → Run workflow. Termux: <code>npm run agent3 -- report</code> ya <code>worker</code></div>
    </>
  )
}
