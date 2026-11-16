import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { Badge, Err, Empty, usePoll, q, timeAgo } from './ui.jsx'

export async function callAgent1(action, params = {}) {
  const { data } = await supabase.auth.getSession()
  const token = data.session && data.session.access_token
  const r = await fetch('/api/agent1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ action, params })
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error || 'Request failed (' + r.status + ')')
  return body
}

const RUNS = [
  ['health_report', 'Health report'], ['vercel_status', 'Vercel status'], ['env_audit', 'Env audit'],
  ['supabase_schema', 'DB schema'], ['rls_check', 'RLS check'],
  ['deploy_logs', 'Vercel error logs'], ['github_status', 'GitHub status']
]
const SEV = { critical: 'bad', error: 'bad', warn: 'warn', info: 'info' }
const SETUP = [['vercel', 'Vercel'], ['supabase_mgmt', 'Supabase API'], ['github', 'GitHub'], ['gemini', 'Gemini']]

export function useAgent1Heartbeat(enabled) {
  useEffect(() => {
    if (!enabled) return
    const ping = () => callAgent1('heartbeat').catch(() => {})
    ping()
    const t = setInterval(ping, 60000)
    return () => clearInterval(t)
  }, [enabled])
}

function Report({ res }) {
  const r = res.result || {}
  return (
    <div className="card">
      <div className="row"><b>Result</b><Badge s={r.overall === 'critical' ? 'error' : r.overall === 'attention' ? 'warn' : res.status === 'awaiting_approval' ? 'awaiting_approval' : 'ok'} /></div>
      {r.ai_summary && <pre>{r.ai_summary}</pre>}
      {r.ai_note && <div className="sub">AI summary unavailable: {r.ai_note}</div>}
      {res.status === 'awaiting_approval' && <div className="sub">{r.next}</div>}
      {(r.issues || []).map((i, n) => (
        <div key={n} style={{ marginTop: 6 }}><span className={'badge ' + (SEV[i.severity] || 'mute')}>{i.severity}</span> <span className="sub">{i.target ? i.target + ': ' : ''}{i.message}</span></div>
      ))}
      {r.issues && r.issues.length === 0 && <div className="sub">No issues found.</div>}
      {(r.deployments || []).map((d, n) => (
        <div key={n} style={{ marginTop: 8 }}><b>{d.project}</b> <span className="sub">{d.state} {d.target} {d.branch || ''}</span><pre>{(d.log_tail || []).join('\n')}</pre></div>
      ))}
      {(r.repos || []).map((g, n) => (
        <div key={n} style={{ marginTop: 8 }}><b>{g.repo}</b> <span className="sub">{g.found ? 'branch ' + g.defaultBranch : 'not found'}</span>
          {(g.lastCommits || []).map((c, i) => <div key={'c' + i} className="sub">commit {c.sha} {c.message}</div>)}
          {(g.runs || []).map((x, i) => <div key={'r' + i} className="sub">run {x.name}: {x.status}/{x.conclusion || '-'} ({x.branch})</div>)}
        </div>
      ))}
      <details style={{ marginTop: 8 }}><summary className="sub">Raw data</summary><pre>{JSON.stringify(r, null, 2).slice(0, 8000)}</pre></details>
    </div>
  )
}

function EnvRequest({ onResult, setErr }) {
  const [f, setF] = useState({ project: '', op: 'upsert', key: '', type: 'encrypted', value: '' })
  const [targets, setTargets] = useState(['preview'])
  const [busy, setBusy] = useState(false)
  const tgl = t => setTargets(x => x.includes(t) ? x.filter(y => y !== t) : [...x, t])
  async function go() {
    setBusy(true); setErr('')
    try { onResult(await callAgent1('request_env_change', { ...f, targets })); setF({ ...f, value: '' }) }
    catch (e) { setErr(e.message) }
    setBusy(false)
  }
  return (
    <div className="card">
      <b>Request env change</b> <span className="sub">(needs your approval)</span>
      <input placeholder="Vercel project name" value={f.project} onChange={e => setF({ ...f, project: e.target.value })} style={{ marginTop: 8 }} />
      <select value={f.op} onChange={e => setF({ ...f, op: e.target.value })}><option value="upsert">Set / update</option><option value="delete">Delete</option></select>
      <input placeholder="KEY_NAME" value={f.key} onChange={e => setF({ ...f, key: e.target.value })} autoCapitalize="characters" />
      {f.op === 'upsert' && <>
        <select value={f.type} onChange={e => setF({ ...f, type: e.target.value })}><option value="encrypted">encrypted</option><option value="sensitive">sensitive</option><option value="plain">plain</option></select>
        <input type="password" placeholder="Value (never stored)" value={f.value} onChange={e => setF({ ...f, value: e.target.value })} autoComplete="off" />
      </>}
      <div className="filters">{['preview', 'development', 'production'].map(t => <button key={t} className={targets.includes(t) ? 'on' : ''} onClick={() => tgl(t)}>{t}</button>)}</div>
      <button className="btn" disabled={busy} onClick={go}>Request approval</button>
    </div>
  )
}

function Apply({ a, onDone, setErr }) {
  const [value, setValue] = useState('')
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const d = a.details
  async function go() {
    setBusy(true); setErr('')
    try { await callAgent1('apply_env_change', { approval_id: a.id, value, production_ack: ack ? 'APPROVE-PRODUCTION' : undefined }); onDone() }
    catch (e) { setErr(e.message) }
    setBusy(false)
  }
  return (
    <div className="card">
      <div className="row"><b>{a.title}</b><Badge s="approved" /></div>
      {d.op === 'upsert' && <input type="password" placeholder="Re-enter the same value" value={value} onChange={e => setValue(e.target.value)} autoComplete="off" style={{ marginTop: 8 }} />}
      {d.production && <label className="sub" style={{ display: 'block', marginBottom: 8 }}><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} style={{ width: 'auto' }} /> I confirm this PRODUCTION change</label>}
      <button className="btn ok" disabled={busy || (d.production && !ack)} onClick={go}>Apply now</button>
    </div>
  )
}

function ApplyDb({ a, onDone, setErr }) {
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [out, setOut] = useState('')
  async function go() {
    setBusy(true); setErr(''); setOut('')
    try { const r = await callAgent1('apply_db_change', { approval_id: a.id, db_ack: ack ? 'RUN-SQL' : undefined }); setOut('Done. Rows returned: ' + ((r.result && r.result.rows) || 0)); onDone() }
    catch (e) { setErr(e.message) }
    setBusy(false)
  }
  return (
    <div className="card">
      <div className="row"><b>{a.title}</b><Badge s="approved" /></div>
      <pre>{a.details.sql}</pre>
      <label className="sub" style={{ display: 'block', marginBottom: 8 }}><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} style={{ width: 'auto' }} /> I confirm Agent 1 may run this SQL on the ai_control schema</label>
      <button className="btn ok" disabled={busy || !ack} onClick={go}>{busy ? 'Running...' : 'Run SQL now'}</button>
      {out && <div className="sub" style={{ marginTop: 6 }}>{out}</div>}
    </div>
  )
}

function RedeployRequest({ onResult, setErr }) {
  const [opts, setOpts] = useState(null)
  const [loading, setLoading] = useState(false)
  const [target, setTarget] = useState('preview')
  const [project, setProject] = useState('')
  const [deployment, setDeployment] = useState('')
  const [busy, setBusy] = useState(false)

  async function load() {
    setLoading(true); setErr('')
    try {
      const r = await callAgent1('vercel_options')
      const list = (r.result && r.result.projects) || []
      setOpts(list); setProject(p => (list.some(x => x.name === p) ? p : (list[0] ? list[0].name : ''))); setDeployment('')
    } catch (e) { setErr(e.message) }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const proj = (opts || []).find(x => x.name === project)
  const deps = ((proj && proj.deployments) || []).filter(d => d.target === target)

  async function go() {
    setBusy(true); setErr('')
    try { onResult(await callAgent1('request_redeploy', { project, target, deployment })); setDeployment('') }
    catch (e) { setErr(e.message) }
    setBusy(false)
  }
  return (
    <div className="card">
      <div className="row"><b>Request redeploy</b><button className="btn ghost" disabled={loading} onClick={load}>{loading ? 'Loading...' : 'Refresh'}</button></div>
      <span className="sub">Needs your approval. Production also needs a confirmation tick.</span>
      <select value={target} onChange={e => { setTarget(e.target.value); setDeployment('') }} style={{ marginTop: 8 }}>
        <option value="preview">Preview</option>
        <option value="production">Production</option>
      </select>
      <select value={project} onChange={e => { setProject(e.target.value); setDeployment('') }} disabled={!opts || !opts.length}>
        {!opts && <option value="">Loading projects...</option>}
        {opts && !opts.length && <option value="">No projects found</option>}
        {(opts || []).map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
      </select>
      <select value={deployment} onChange={e => setDeployment(e.target.value)} disabled={!deps.length}>
        <option value="">{deps.length ? 'Latest ' + target + ' deployment' : 'No ' + target + ' deployments'}</option>
        {deps.map(d => <option key={d.id} value={d.id}>{d.id.slice(0, 14)} | {d.state} | {d.branch || '-'} | {timeAgo(d.at)}</option>)}
      </select>
      <button className="btn" disabled={busy || !project || !deps.length} onClick={go}>Request approval</button>
    </div>
  )
}

function ApplyRedeploy({ a, onDone, setErr }) {
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [out, setOut] = useState('')
  const d = a.details
  async function go() {
    setBusy(true); setErr(''); setOut('')
    try { const r = await callAgent1('apply_redeploy', { approval_id: a.id, production_ack: ack ? 'APPROVE-PRODUCTION' : undefined }); setOut('Redeploy started: ' + ((r.result && r.result.new_deployment) || 'ok')); onDone() }
    catch (e) { setErr(e.message) }
    setBusy(false)
  }
  return (
    <div className="card">
      <div className="row"><b>{a.title}</b><Badge s="approved" /></div>
      {d.production && <label className="sub" style={{ display: 'block', margin: '8px 0' }}><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} style={{ width: 'auto' }} /> I confirm this PRODUCTION redeploy</label>}
      <button className="btn ok" disabled={busy || (d.production && !ack)} onClick={go}>{busy ? 'Starting...' : 'Redeploy now'}</button>
      {out && <div className="sub" style={{ marginTop: 6 }}>{out}</div>}
    </div>
  )
}

function DbProposal({ onResult, setErr }) {
  const [title, setTitle] = useState('')
  const [sql, setSql] = useState('')
  const [busy, setBusy] = useState(false)
  async function go() {
    setBusy(true); setErr('')
    try { onResult(await callAgent1('propose_db_change', { title, sql })); setTitle(''); setSql('') }
    catch (e) { setErr(e.message) }
    setBusy(false)
  }
  return (
    <div className="card">
      <b>Propose DB change</b> <span className="sub">(ai_control only; after approval press Run SQL)</span>
      <input placeholder="Title" value={title} onChange={e => setTitle(e.target.value)} style={{ marginTop: 8 }} />
      <textarea rows={3} placeholder="SQL" value={sql} onChange={e => setSql(e.target.value)} />
      <button className="btn" disabled={busy} onClick={go}>Request approval</button>
    </div>
  )
}

export default function Agent1Panel() {
  const [hb, setHb] = useState(null)
  const [res, setRes] = useState(null)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => { callAgent1('heartbeat').then(setHb).catch(e => setErr(e.message)) }, [])

  const { data: ready, reload } = usePoll(() =>
    q(supabase.from('approvals').select('*').eq('status', 'approved').order('decided_at', { ascending: false }).limit(20)), [], 15000)
  const applicable = (ready || []).filter(a => a.details && (['env_change', 'db_change', 'redeploy'].includes(a.details.kind)) && !a.details.executed_at)

  async function run(action) {
    setBusy(action); setErr(''); setRes(null)
    try { setRes(await callAgent1(action)) } catch (e) { setErr(e.message) }
    setBusy('')
  }

  return (
    <>
      <h2>Agent 1 console</h2>
      <Err msg={err} />
      {hb && (
        <div className="card">
          <div className="row"><b>Setup</b><span className="sub">model: {hb.model}</span></div>
          <div className="filters" style={{ marginTop: 6 }}>{SETUP.map(([k, l]) => <span key={k} className={'badge ' + (hb.ready[k] ? 'good' : 'mute')}>{l}{hb.ready[k] ? ' ✓' : ' ✗'}</span>)}</div>
        </div>
      )}
      <div className="actions" style={{ marginBottom: 10 }}>
        {RUNS.map(([a, l]) => <button key={a} className="btn" disabled={!!busy} onClick={() => run(a)}>{busy === a ? 'Running...' : l}</button>)}
      </div>
      {res && <Report res={res} />}
      {applicable.length > 0 && <><h2>Approved - ready to apply</h2>{applicable.map(a => a.details.kind === 'db_change' ? <ApplyDb key={a.id} a={a} onDone={reload} setErr={setErr} /> : a.details.kind === 'redeploy' ? <ApplyRedeploy key={a.id} a={a} onDone={reload} setErr={setErr} /> : <Apply key={a.id} a={a} onDone={reload} setErr={setErr} />)}</>}
      <EnvRequest onResult={setRes} setErr={setErr} />
      <RedeployRequest onResult={setRes} setErr={setErr} />
      <DbProposal onResult={setRes} setErr={setErr} />
    </>
  )
}
