import { BranchSelector, SelectedLine } from './BranchSelector.jsx'
import { scopeParams } from './branchContext.js'
import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { Badge, Err, CodeBlock, usePoll, q, timeAgo } from './ui.jsx'
import { PendingInline } from './InlineApproval.jsx'

export async function callAgent1(action, params = {}) {
  const { data } = await supabase.auth.getSession()
  const token = data.session && data.session.access_token
  const r = await fetch('/api/agent1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ action, params: scopeParams('agent1', action, params) })
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
  if (r.unsupported) {
    return (
      <div className="card">
        {res.understood && <CodeBlock label={'understood: ' + res.understood.intent} tone="info" text={res.understood.explanation || res.understood.intent} />}
        <CodeBlock label="not possible" tone="warn" text={r.message} />
      </div>
    )
  }
  const tone = r.overall === 'critical' ? 'bad' : r.overall === 'attention' ? 'warn' : res.status === 'awaiting_approval' ? 'info' : 'good'
  const badge = r.overall === 'critical' ? 'error' : r.overall === 'attention' ? 'warn' : res.status === 'awaiting_approval' ? 'awaiting_approval' : 'ok'
  const branchInfo = (r.repos || []).map(x => 'Used: ' + x.repo + ' @ ' + (x.branch || '-') + (x.branchSha ? ' @ ' + x.branchSha.slice(0, 7) : '') + (x.defaultBranch && x.branch && x.branch !== x.defaultBranch ? '   (repo default is ' + x.defaultBranch + ', not used)' : '')).join('\\n')
  const issues = (r.issues || []).map(i => '[' + String(i.severity).toUpperCase() + '] ' + (i.target ? i.target + ': ' : '') + i.message).join('\n')
  return (
    <div className="card">
      <div className="row"><b>Result</b><Badge s={badge} /></div>
      {branchInfo && <CodeBlock label="GitHub branch context" tone="info" text={branchInfo} wrap={false} />}
      {res.understood && <CodeBlock label={'understood: ' + res.understood.intent} tone="info" text={res.understood.explanation || res.understood.intent} />}
      {r.ai_summary && <CodeBlock label="summary" tone={tone} text={r.ai_summary} />}
      {r.firewall_enabled !== undefined && <CodeBlock label="firewall / rate limits (read-only)" tone="info" text={JSON.stringify({ project: r.project, config_version: r.config_version, enabled: r.firewall_enabled, bot_id_enabled: r.bot_id_enabled, rule_count: r.rule_count, rate_limit_count: r.rate_limit_count, ip_rule_count: r.ip_rule_count, rate_limit_rules: r.rate_limit_rules, rules: r.rules, ip_rules: r.ip_rules, managed_rulesets: r.managed_rulesets, note: r.note }, null, 2)} wrap={false} />}
      {r.ai_note && <CodeBlock label="ai note" tone="warn" text={'AI summary unavailable: ' + r.ai_note} />}
      {res.status === 'awaiting_approval' && r.next && <CodeBlock label="next step" tone="info" text={r.next} />}
      {issues && <CodeBlock label={'issues (' + r.issues.length + ')'} tone={tone === 'good' ? 'warn' : tone} text={issues} />}
      {r.issues && r.issues.length === 0 && <CodeBlock label="status" tone="good" text="No issues found." />}
      {(r.deployments || []).map((d, n) => (
        <CodeBlock key={n} label={'error log - ' + d.project + ' - ' + d.state + ' ' + (d.target || '') + ' ' + (d.branch || '')} tone="bad" wrap={false}
          text={(d.log_tail || []).join('\n') || 'No log lines.'} />
      ))}
      {(r.repos || []).map((g, n) => {
        const lines = [g.found ? 'branch: ' + (g.branch || g.defaultBranch) + (g.branchSha ? ' @ ' + g.branchSha.slice(0, 7) : '') : 'not found']
        ;(g.lastCommits || []).forEach(c => lines.push('commit ' + c.sha + ' ' + c.message))
        ;(g.runs || []).forEach(x => lines.push('run ' + x.name + ': ' + x.status + '/' + (x.conclusion || '-') + ' (' + x.branch + ')'))
        return <CodeBlock key={n} label={'github - ' + g.repo} tone={g.found ? 'good' : 'bad'} text={lines.join('\n')} />
      })}
      <details style={{ marginTop: 8 }}>
        <summary className="sub" style={{ cursor: 'pointer' }}>Raw data</summary>
        <CodeBlock label="json" wrap={false} text={JSON.stringify(r, null, 2).slice(0, 8000)} />
      </details>
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
      <CodeBlock label="sql" wrap={false} text={a.details.sql} />
      <label className="sub" style={{ display: 'block', marginBottom: 8 }}><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} style={{ width: 'auto' }} /> I confirm Agent 1 may run this SQL on the ai_control schema</label>
      <button className="btn ok" disabled={busy || !ack} onClick={go}>{busy ? 'Running...' : 'Run SQL now'}</button>
      {out && <CodeBlock label="success" tone="good" text={out} />}
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
      {out && <CodeBlock label="success" tone="good" text={out} />}
    </div>
  )
}

function FirewallCheck({ onResult, setErr }) {
  const [names, setNames] = useState(null)
  const [project, setProject] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { callAgent1('project_options').then(r => { const v = (r.result && r.result.vercel) || []; setNames(v); setProject(v[0] || '') }).catch(e => setErr(e.message)) }, [])
  async function go() {
    setBusy(true); setErr('')
    try { onResult(await callAgent1('firewall_inspect', { project })) } catch (e) { setErr(e.message) }
    setBusy(false)
  }
  return (
    <div className="card">
      <b>Firewall &amp; rate limits</b> <span className="sub">(read-only: shows the active firewall config, rate-limit rules and IP rules. Nothing is changed. Header and cookie values are hidden)</span>
      <select value={project} onChange={e => setProject(e.target.value)} disabled={!names || !names.length} style={{ marginTop: 8 }}>
        {!names && <option value="">Loading projects...</option>}
        {names && !names.length && <option value="">No Vercel projects</option>}
        {(names || []).map(n => <option key={n} value={n}>{n}</option>)}
      </select>
      <button className="btn" disabled={busy || !project} onClick={go}>{busy ? 'Reading...' : 'Inspect firewall'}</button>
    </div>
  )
}

function AskBox({ onResult, setErr }) {
  const [opts, setOpts] = useState(null)
  const [vp, setVp] = useState('')
  const [sp, setSp] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { callAgent1('project_options').then(r => setOpts(r.result || { vercel: [], supabase: [] })).catch(e => setErr(e.message)) }, [])
  async function go() {
    setBusy(true); setErr('')
    try { onResult(await callAgent1('ai_command', { text, vercel_project: vp || undefined, supabase_ref: sp || undefined })); setText('') } catch (e) { setErr(e.message) }
    setBusy(false)
  }
  const supa = ((opts && opts.supabase) || []).filter(x => x.label !== 'default')
  return (
    <div className="card">
      <b>Ask Agent 1</b> <span className="sub">(write anything; AI picks ONE safe check. Redeploy still needs approval)</span>
      <select value={vp} onChange={e => setVp(e.target.value)} disabled={!opts} style={{ marginTop: 8 }}>
        <option value="">{opts ? (opts.vercel.length ? 'All Vercel projects' : 'No Vercel projects') : 'Loading Vercel projects...'}</option>
        {((opts && opts.vercel) || []).map(n => <option key={n} value={n}>{n}</option>)}
      </select>
      <select value={sp} onChange={e => setSp(e.target.value)} disabled={!opts}>
        <option value="">{opts ? 'Default Supabase project' : 'Loading Supabase projects...'}</option>
        {supa.map(x => <option key={x.ref} value={x.ref}>{x.label}</option>)}
      </select>
      <textarea rows={3} placeholder="e.g. firewall aur rate-limit rules inspect karo / vercel status / last failed deploy log / RLS check" value={text} onChange={e => setText(e.target.value)} />
      <button className="btn" disabled={busy || !text.trim()} onClick={go}>{busy ? 'Thinking...' : 'Do it'}</button>
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
      <Err msg={err} />
      {hb && (
        <div className="card">
          <div className="row"><b>Setup</b><span className="sub">{hb.model}</span></div>
          <div className="filters" style={{ marginTop: 6 }}>{SETUP.map(([k, l]) => <span key={k} className={'badge ' + (hb.ready[k] ? 'good' : 'mute')}>{l}{hb.ready[k] ? ' ✓' : ' ✗'}</span>)}</div>
        </div>
      )}
      <BranchSelector agent="agent1" repos={(hb && hb.repos) || []} initialRepo={(hb && hb.repos && hb.repos[0]) || ''} call={callAgent1} />
      <div className="sec-title">Run a check</div>
      <SelectedLine agent="agent1" label="GitHub parts (status, health) read" />
      <div className="sub" style={{ marginBottom: 6 }}>Vercel and Supabase parts are live and not branch-filtered.</div>
      <div className="actions" style={{ marginBottom: 10 }}>
        {RUNS.map(([a, l]) => <button key={a} className="btn ghost" disabled={!!busy} onClick={() => run(a)}>{busy === a ? 'Running...' : l}</button>)}
      </div>
      {res && <Report res={res} />}
      <PendingInline kinds={['env_change', 'db_change', 'redeploy']} onDone={reload} />
      {applicable.length > 0 && <><div className="sec-title">Approved - ready to apply</div>{applicable.map(a => a.details.kind === 'db_change' ? <ApplyDb key={a.id} a={a} onDone={reload} setErr={setErr} /> : a.details.kind === 'redeploy' ? <ApplyRedeploy key={a.id} a={a} onDone={reload} setErr={setErr} /> : <Apply key={a.id} a={a} onDone={reload} setErr={setErr} />)}</>}
      <AskBox onResult={setRes} setErr={setErr} />
      <FirewallCheck onResult={setRes} setErr={setErr} />
      <EnvRequest onResult={setRes} setErr={setErr} />
      <RedeployRequest onResult={setRes} setErr={setErr} />
      <DbProposal onResult={setRes} setErr={setErr} />
    </>
  )
}
