import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { Badge, Err, CodeBlock, Empty, Loading, usePoll, q, timeAgo } from './ui.jsx'

export async function callOrch(action, params = {}) {
  const { data } = await supabase.auth.getSession()
  const token = data.session && data.session.access_token
  const r = await fetch('/api/orchestrator', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ action, params })
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) { const e = new Error(body.error || 'Request failed (' + r.status + ')'); e.code = body.code; e.workflow_id = body.workflow_id; throw e }
  return body
}

const STAGE_LABEL = {
  proposing: 'Agent 2 is preparing the proposal', awaiting_approval: 'Waiting for your approval', applying: 'Agent 2 is committing',
  ci_waiting: 'Waiting for GitHub CI', awaiting_sql: 'Waiting for your SQL approval (Agent 1)', applying_sql: 'Agent 1 is running approved SQL', ci_passed: 'CI passed - Agent 1 next', verifying: 'Agent 1 is verifying',
  completed: 'Completed', failed: 'Stopped (failed)', cancelled: 'Cancelled'
}
const STEPS = [['proposing', 'Agent 2 proposal'], ['awaiting_approval', 'Your approval'], ['applying', 'Agent 2 commit'], ['ci_waiting', 'GitHub CI'], ['awaiting_sql', 'Agent 1 SQL'], ['verifying', 'Agent 1 verify'], ['completed', 'Done']]
const norm = s => (s === 'ci_passed' ? 'verifying' : s === 'applying_sql' ? 'awaiting_sql' : s)

function Progress({ w }) {
  const stopped = w.stage === 'failed' || w.stage === 'cancelled'
  const hasSql = ((w.zip && w.zip.sql) || []).some(x => x.status === 'reviewed')
  const steps = STEPS.filter(([s]) => s !== 'awaiting_sql' || hasSql)
  const cur = steps.findIndex(([s]) => s === norm(stopped ? (w.failure && w.failure.stage) : w.stage))
  return (
    <div className="actions" style={{ margin: '8px 0' }}>
      {steps.map(([s, label], i) => {
        const cls = w.stage === 'completed' || i < cur ? 'good' : i === cur ? (stopped ? 'bad' : 'info') : 'mute'
        return <span key={s} className={'badge ' + cls}>{label}</span>
      })}
    </div>
  )
}

function Create({ repos, onCreated, setErr }) {
  const [repo, setRepo] = useState('')
  const [title, setTitle] = useState('')
  const [mode, setMode] = useState('files')
  const [json, setJson] = useState('')
  const [problem, setProblem] = useState('')
  const [paths, setPaths] = useState('')
  const [busy, setBusy] = useState(false)
  const [reqId, setReqId] = useState(() => crypto.randomUUID())
  async function go() {
    setBusy(true); setErr('')
    try {
      const base = { repo: repo || repos[0], title, mode, request_id: reqId } // same request_id on retry = no duplicate workflow
      let params
      if (mode === 'files') { const parsed = JSON.parse(json); params = { ...base, files: Array.isArray(parsed) ? parsed : parsed.files } }
      else params = { ...base, problem, paths: paths.split(/[\s,]+/).filter(Boolean) }
      const r = await callOrch('start', params)
      setReqId(crypto.randomUUID()); setTitle(''); setJson(''); setProblem(''); setPaths('')
      onCreated(r.workflow.id)
    } catch (e) {
      setErr(e instanceof SyntaxError ? 'The change is not valid JSON: ' + e.message : e.message)
      if (e.workflow_id) { setReqId(crypto.randomUUID()); onCreated(e.workflow_id) }
    }
    setBusy(false)
  }
  return (
    <div className="card">
      <b>Create Orchestrated Task</b> <span className="sub">(Agent 2 prepares it, you approve, Agent 1 verifies. Nothing goes to production.)</span>
      <select value={repo || repos[0] || ''} onChange={e => setRepo(e.target.value)} disabled={!repos.length}>
        {!repos.length && <option value="">No repos in AGENT2_GITHUB_REPOS</option>}
        {repos.map(r => <option key={r} value={r}>{r}</option>)}
      </select>
      <input placeholder="Task title" value={title} onChange={e => setTitle(e.target.value)} />
      <select value={mode} onChange={e => setMode(e.target.value)}>
        <option value="files">I give the code (JSON)</option>
        <option value="fix">Fix a bug with AI</option>
      </select>
      {mode === 'files'
        ? <textarea rows={6} placeholder={'{\n  "files": [\n    { "path": "src/example.js", "op": "update", "content": "...full new file..." }\n  ]\n}'} value={json} onChange={e => setJson(e.target.value)} autoCapitalize="none" spellCheck={false} />
        : <>
          <textarea rows={3} placeholder="Describe the problem" value={problem} onChange={e => setProblem(e.target.value)} />
          <input placeholder="File paths, comma separated (max 5)" value={paths} onChange={e => setPaths(e.target.value)} autoCapitalize="none" />
        </>}
      <button className="btn" disabled={busy || !title.trim() || !repos.length || (mode === 'files' ? !json.trim() : !problem.trim() || !paths.trim())} onClick={go}>{busy ? 'Agent 2 is working...' : 'Start workflow'}</button>
    </div>
  )
}

function Report({ r }) {
  const a1 = r.agent1 || {}
  return (
    <>
      <div className="row"><b>Combined report</b><Badge s={r.verdict === 'healthy' ? 'ok' : r.verdict === 'critical' ? 'failed' : 'warn'} /></div>
      <CodeBlock label="stages" wrap={false} text={(r.stages || []).map(s => s.name + ': ' + s.status).join('\n')} />
      <CodeBlock label="agent 2" tone="good" wrap={false} text={[
        'branch: ' + r.agent2.branch, 'commit: ' + String(r.agent2.commit_sha).slice(0, 7), 'CI: ' + r.agent2.ci.state,
        ...(r.agent2.changed_files || []).map(f => f.op + ' ' + f.path + '  +' + f.added + ' -' + f.removed), r.agent2.compare_url
      ].join('\n')} />
      <CodeBlock label={'agent 1 - ' + (a1.overall || '?')} tone={a1.overall === 'healthy' ? 'good' : 'warn'} wrap={false} text={[
        'GitHub: ' + (a1.github && a1.github.status), 'Vercel: ' + (a1.vercel && a1.vercel.status), 'Supabase: ' + (a1.supabase && a1.supabase.status),
        ...((a1.vercel && a1.vercel.branch_deployments) || []).map(d => 'deployment ' + d.project + ': ' + d.state + ' (' + d.target + ')')
      ].join('\n')} />
      {(a1.issues || []).length > 0 && <CodeBlock label="agent 1 issues" tone="warn" text={a1.issues.map(i => i.severity + ' [' + i.area + '] ' + i.message + (i.target ? ' - ' + i.target : '')).join('\n')} />}
      {r.sql && <CodeBlock label="agent 1 - sql migrations" tone={(r.sql.blocked || []).length ? 'warn' : 'good'} wrap={false} text={[
        ...(r.sql.migrations || []).map(m => m.status.toUpperCase() + '  ' + m.path + (m.rows != null ? '  (' + m.rows + ' rows)' : '') + (m.risk === 'destructive' ? '  [destructive]' : '')),
        ...(r.sql.blocked || []).map(b => 'BLOCKED  ' + b.path + ' - ' + b.reason), 'verified by: ' + r.sql.verified_by
      ].join('\n')} />}
      {(r.warnings || []).length > 0 && <CodeBlock label="warnings" tone="warn" text={r.warnings.join('\n')} />}
      <CodeBlock label="what you do next" tone="info" text={(r.next_actions || []).join('\n')} />
    </>
  )
}

function Detail({ id, onChanged, setErr }) {
  const [busy, setBusy] = useState('')
  const [ack, setAck] = useState(false)
  const [dbAck, setDbAck] = useState(false)
  const [destAck, setDestAck] = useState(false)
  const { data, error, loading, reload } = usePoll(() => callOrch('get', { workflow_id: id }), [id], 8000)
  const { data: ap } = usePoll(async () => {
    const w = data && data.workflow; const aid = w && w.steps && w.steps.approval && w.steps.approval.id
    if (!aid) return null
    return (await q(supabase.from('approvals').select('id,status,decided_at,details').eq('id', aid).maybeSingle()))
  }, [data && data.workflow && data.workflow.rev], 8000)
  const { data: sqlAps } = usePoll(async () => {
    const w = data && data.workflow; const ids = ((w && w.steps && w.steps.sql && w.steps.sql.items) || []).map(i => i.approval_id).filter(Boolean)
    if (!ids.length) return []
    return (await q(supabase.from('approvals').select('id,status').in('id', ids)))
  }, [data && data.workflow && data.workflow.rev], 8000)
  const { data: agents } = usePoll(() => q(supabase.from('agents').select('slot,status,last_heartbeat_at').in('slot', [1, 2])), [], 10000)
  if (loading && !data) return <Loading />
  if (!data) return <Err msg={error} />
  const w = data.workflow
  const s = w.steps || {}
  const ag = n => { const a = (agents || []).find(x => x.slot === n); return a ? a.status : '-' }
  const sensitive = ap && ap.details && (ap.details.sensitive_paths || []).length > 0
  async function act(action, params = {}) {
    setBusy(action); setErr('')
    try { await callOrch(action, { workflow_id: id, ...params }) } catch (e) { setErr(e.message) }
    setBusy(''); reload(); onChanged()
  }
  const apStatus = (ap && ap.status) || (s.approval && s.approval.status) || '-'
  const ci = s.ci
  return (
    <div className="card">
      <Err msg={error} />
      <div className="row"><b>{w.title}</b><Badge s={w.status} /></div>
      <div className="sub">{STAGE_LABEL[w.stage] || w.stage} · {timeAgo(w.updated_at)}</div>
      <Progress w={w} />
      {w.failure && <CodeBlock label={w.stage === 'cancelled' ? 'cancelled' : 'workflow stopped'} tone="bad" text={w.failure.message + '\n(stage: ' + w.failure.stage + ', ' + w.failure.agent + ', ' + w.failure.code + ')'} />}

      <CodeBlock label="status" wrap={false} text={[
        'Agent 2: ' + ag(2) + (s.agent2_propose ? ' · proposal ' + s.agent2_propose.status : ''),
        'Agent 1: ' + ag(1) + (s.agent1_verify ? ' · verify ' + s.agent1_verify.status : ' · not started'),
        'Approval: ' + apStatus,
        'Commit: ' + (s.agent2_apply && s.agent2_apply.commit_sha ? String(s.agent2_apply.commit_sha).slice(0, 7) + ' on ' + s.agent2_apply.branch : '-'),
        'GitHub CI: ' + (ci ? ci.state : '-'),
        ...(s.sql ? ['SQL (Agent 1): ' + s.sql.status] : []),
        'Vercel: ' + (w.report ? w.report.agent1.vercel.status : '-'),
        'Supabase: ' + (w.report ? w.report.agent1.supabase.status : '-')
      ].join('\n')} />

      {w.zip && <CodeBlock label="ZIP validation" tone="info" wrap={false} text={[
        'Repository: ' + w.repo + '  (base branch: ' + (w.zip.base_branch || '?') + ')',
        'Base commit: ' + w.zip.base_commit,
        'ZIP SHA-256: ' + w.zip.checksum,
        'Extracted: ' + w.zip.total_extracted_bytes + ' bytes in ' + (w.zip.changed_files || []).length + ' change(s)',
        ...((w.zip.ignored_entries || []).length ? ['Skipped OS junk: ' + w.zip.ignored_entries.length] : []),
        'Secret scan: ' + (w.zip.secret_scan || 'passed')
      ].join('\n')} />}
      {w.zip && <CodeBlock label="files in this ZIP" wrap={false} text={(w.zip.changed_files || []).map(f => f.op.toUpperCase() + '  ' + f.path + (f.sha256 ? '  ' + f.sha256.slice(0, 10) : '')).join('\n')} />}
      {w.zip && w.zip.gemini && <CodeBlock label="gemini review (compact diff only)" tone={w.zip.gemini.review_partial ? 'warn' : 'info'} wrap={false} text={[
        'Input cap: ' + w.zip.gemini.input_max_chars + ' chars, output cap: ' + w.zip.gemini.output_max_tokens + ' tokens',
        'Sent: ' + (w.zip.gemini.input_chars != null ? w.zip.gemini.input_chars + ' chars' : '-') + ' (ZIP and full files are never sent)',
        'Review: ' + (w.zip.gemini.review_available === false ? 'not available' : w.zip.gemini.review_partial ? 'PARTIAL - lower-priority hunks were truncated' : 'complete'),
        'Tokens: ' + (w.zip.gemini.tokens_in ?? '-') + ' in / ' + (w.zip.gemini.tokens_out ?? '-') + ' out' + (w.zip.gemini.estimated_cost_usd != null ? '  ~$' + w.zip.gemini.estimated_cost_usd : '')
      ].join('\n')} />}
      {ap && ap.details && Array.isArray(ap.details.files) && ap.details.files.length > 0 && (
        <details open={w.stage === 'awaiting_approval'} style={{ marginTop: 6 }}>
          <summary className="sub" style={{ cursor: 'pointer' }}>Diff preview ({ap.details.files.length} files, base {String(ap.details.base_sha || '').slice(0, 7)})</summary>
          {ap.details.files.map(f => <CodeBlock key={f.path} label={f.op + ' ' + f.path + '  +' + f.added + ' -' + f.removed + (f.sensitive ? '  [SENSITIVE]' : '')} tone={f.sensitive ? 'warn' : undefined} text={f.preview || '(no text preview)'} />)}
        </details>
      )}
      {w.zip && (w.zip.sql || []).length > 0 && (
        <CodeBlock label="sql migrations (separate approval, Agent 1)" tone={(w.zip.sql || []).some(x => x.status === 'blocked') ? 'warn' : 'info'} wrap={false} text={(w.zip.sql || []).map(x => {
          const it = ((s.sql && s.sql.items) || []).find(y => y.path === x.path)
          const live = it && (sqlAps || []).find(a => a.id === it.approval_id)
          return (x.status === 'blocked' ? 'BLOCKED  ' : (it ? String(it.status === 'pending' && live ? live.status : it.status).toUpperCase() : 'REVIEWED') + '  ') + x.path + (x.risk === 'destructive' ? '  [destructive: ' + (x.flags || []).join(', ') + ']' : '') + (x.reason ? '\n    ' + x.reason : '')
        }).join('\n')} />
      )}
      {w.zip && (w.zip.sql || []).filter(x => x.status === 'reviewed').map(x => <details key={x.path}><summary className="sub" style={{ cursor: 'pointer' }}>SQL text: {x.path}</summary><CodeBlock label={x.path} text={x.sql || ''} /></details>)}
      {s.agent2_propose && s.agent2_propose.changed_files && <CodeBlock label={'proposal (' + s.agent2_propose.changed_files.length + ' files)'} wrap={false} text={s.agent2_propose.changed_files.map(f => f.op + ' ' + f.path + '  +' + f.added + ' -' + f.removed + (f.sensitive ? '  [SENSITIVE]' : '')).join('\n')} />}
      {s.agent2_propose && (s.agent2_propose.warnings || []).length > 0 && <CodeBlock label="agent 2 warnings" tone="warn" text={s.agent2_propose.warnings.join('\n')} />}
      {s.agent2_propose && s.agent2_propose.ai_review && <CodeBlock label="ai review" tone="info" text={s.agent2_propose.ai_review} />}
      {ci && ci.state !== 'unknown' && <CodeBlock label={'github actions: ' + ci.state} wrap={false} text={(ci.runs || []).map(r => r.name + ' ' + r.status + '/' + (r.conclusion || '-') + '@' + r.sha).join('\n') || 'no run seen for this commit yet'} />}

      {w.stage === 'awaiting_approval' && (
        <>
          <CodeBlock label="next" tone="info" text={apStatus === 'approved' ? 'Approved. Press Apply to let Agent 2 create its agent2/* branch and commit.' : 'Open the Approvals tab, review and approve (or reject). Then come back and press Apply.'} />
          {sensitive && <label className="sub" style={{ display: 'block', margin: '6px 0' }}><input type="checkbox" style={{ width: 'auto', marginRight: 8 }} checked={ack} onChange={e => setAck(e.target.checked)} />I confirm: this change touches sensitive files ({ap.details.sensitive_paths.join(', ')})</label>}
          <div className="actions">
            <button className="btn ok" disabled={!!busy || apStatus !== 'approved' || (sensitive && !ack)} onClick={() => act('apply', ack ? { sensitive_ack: 'APPROVE-SENSITIVE' } : {})}>{busy === 'apply' ? 'Applying...' : 'Apply approved change'}</button>
            <button className="btn ghost" disabled={!!busy} onClick={() => act('cancel')}>Cancel</button>
          </div>
        </>
      )}
      {w.stage === 'ci_waiting' && (
        <div className="actions">
          <button className="btn" disabled={!!busy} onClick={() => act('check_ci')}>{busy === 'check_ci' ? 'Checking...' : 'Check CI (Agent 1 starts when it passes)'}</button>
          <button className="btn ghost" disabled={!!busy} onClick={() => act('cancel')}>Cancel</button>
        </div>
      )}
      {w.stage === 'awaiting_sql' && (() => {
        const items = (s.sql && s.sql.items) || []
        const allOk = items.length > 0 && items.every(it => { const live = (sqlAps || []).find(a => a.id === it.approval_id); return (live && live.status === 'approved') || it.status === 'approved' })
        const destructive = items.some(it => it.risk === 'destructive')
        return (
          <>
            <CodeBlock label="next - sql" tone="info" text={allOk ? 'All SQL approvals are in. Press Run to let Agent 1 execute them (ai_control only, one transaction per file). Agent 1 verifies Supabase and Vercel afterwards.' : 'Open the Approvals tab and approve each SQL migration (or reject it to stop). Agent 1 runs nothing before that.'} />
            <label className="sub" style={{ display: 'block', margin: '6px 0' }}><input type="checkbox" style={{ width: 'auto', marginRight: 8 }} checked={dbAck} onChange={e => setDbAck(e.target.checked)} />I confirm: run the approved SQL against Supabase (ai_control only)</label>
            {destructive && <label className="sub" style={{ display: 'block', margin: '6px 0' }}><input type="checkbox" style={{ width: 'auto', marginRight: 8 }} checked={destAck} onChange={e => setDestAck(e.target.checked)} />I confirm: this SQL contains destructive statements (DELETE / UPDATE / ALTER ... DROP)</label>}
            <div className="actions">
              <button className="btn ok" disabled={!!busy || !allOk || !dbAck || (destructive && !destAck)} onClick={() => act('apply_sql', { db_ack: 'RUN-SQL', ...(destAck ? { destructive_ack: 'APPROVE-DESTRUCTIVE' } : {}) })}>{busy === 'apply_sql' ? 'Running SQL...' : 'Run approved SQL'}</button>
              <button className="btn ghost" disabled={!!busy} onClick={() => act('cancel')}>Cancel</button>
            </div>
          </>
        )
      })()}
      {w.stage === 'ci_passed' && (
        <div className="actions"><button className="btn" disabled={!!busy} onClick={() => act('verify')}>{busy === 'verify' ? 'Verifying...' : 'Run Agent 1 verification'}</button></div>
      )}

      {w.report && <><Report r={w.report} /><CodeBlock label="rollback guidance" tone="warn" text={w.report.rollback_guidance || 'No automatic rollback. Owner must review and revert through a separately approved change.'} /></>}

      <details style={{ marginTop: 8 }}>
        <summary className="sub" style={{ cursor: 'pointer' }}>History</summary>
        <CodeBlock label="events" wrap={false} text={(w.events || []).map(e => (e.at || '').slice(11, 19) + '  ' + e.message).join('\n')} />
      </details>
    </div>
  )
}


function ZipUpload({ repos, onCreated, setErr }) {
  const [repo,setRepo]=useState('')
  const [title,setTitle]=useState('ZIP deployment')
  const [file,setFile]=useState(null)
  const [baseSha,setBaseSha]=useState('')
  const [busy,setBusy]=useState(false)
  async function upload(){
    if(!file) return
    setBusy(true); setErr('')
    try {
      if(file.size>2*1024*1024) throw new Error('ZIP max size is 2 MB')
      const base64=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=()=>reject(new Error('Could not read ZIP'));r.readAsDataURL(file)})
      const result=await callOrch('upload_zip',{repo:repo||repos[0],title,zip_base64:base64,request_id:crypto.randomUUID(),...(baseSha.trim()?{expected_base_sha:baseSha.trim()}:{})})
      onCreated(result.workflow.id)
      setFile(null); setBaseSha('')
    } catch(e){setErr(e.message)}
    setBusy(false)
  }
  return <div className="card">
    <b>Deployment Control Center — ZIP upload</b>
    <p className="sub">Upload changed files only. Max 2 MB ZIP / 40 files / 600 KB extracted. The ZIP is checked on the server only; nothing is written to GitHub until you approve, and only a small diff summary (never the ZIP) is sent to Gemini.</p>
    <select value={repo||repos[0]||''} onChange={e=>setRepo(e.target.value)} disabled={!repos.length}>{repos.map(r=><option key={r} value={r}>{r}</option>)}</select>
    <input value={title} onChange={e=>setTitle(e.target.value)} placeholder="Change title"/>
    <input value={baseSha} onChange={e=>setBaseSha(e.target.value)} placeholder="Expected base commit SHA (optional, 40 chars)" autoCapitalize="none" spellCheck={false}/>
    <input type="file" accept=".zip,application/zip" onChange={e=>setFile(e.target.files&&e.target.files[0]||null)}/>
    <p className="sub">Deletions: add a UTF-8 <code>.blisscco-delete.txt</code> with one repository path per line. SQL (<code>.sql</code>) files are reviewed by Agent 1 and need their own approval after CI passes; anything Agent 1's safeguards forbid is shown as BLOCKED with the reason and is never executed. A ZIP with only SQL is not accepted.</p>
    <button className="btn" disabled={busy||!file||!repos.length||!title.trim()} onClick={upload}>{busy?'Validating ZIP...':'Validate & preview ZIP'}</button>
  </div>
}

export default function Orchestrator() {
  const [err, setErr] = useState('')
  const [sel, setSel] = useState(() => (location.hash.startsWith('#wf=') ? location.hash.slice(4) : ''))
  const [repos, setRepos] = useState([])
  useEffect(() => { callOrch('heartbeat').then(r => setRepos(r.repos || [])).catch(e => setErr(e.message)) }, [])
  const { data, error, loading, reload } = usePoll(() => callOrch('list'), [], 10000)
  const pick = (id) => { setSel(id); history.replaceState(null, '', id ? '#wf=' + id : location.pathname); reload() } // survives refresh
  const list = (data && data.workflows) || []
  return (
    <>
      <Err msg={error} /><Err msg={err} />
      <ZipUpload repos={repos} onCreated={pick} setErr={setErr} />
      <Create repos={repos} onCreated={pick} setErr={setErr} />
      {sel && <><h2>Current workflow</h2><Detail key={sel} id={sel} onChanged={reload} setErr={setErr} /></>}
      <h2>Task history</h2>
      {loading && !data ? <Loading /> : list.length === 0 ? <Empty text="No orchestrated tasks yet" /> : list.map(w => (
        <div className="card" key={w.id} onClick={() => pick(w.id)} style={{ cursor: 'pointer', outline: w.id === sel ? '1px solid var(--muted)' : 'none' }}>
          <div className="row"><b>{w.title}</b><Badge s={w.status} /></div>
          <div className="sub">{STAGE_LABEL[w.stage] || w.stage} · {timeAgo(w.created_at)}</div>
          <div className="sub">{w.commit_sha ? 'commit ' + String(w.commit_sha).slice(0, 7) + ' · ' : ''}{w.ci ? 'CI ' + w.ci + ' · ' : ''}{w.verdict ? 'verdict ' + w.verdict : ''}</div>
          {w.failure && <div className="sub" style={{ color: 'var(--bad, #c0392b)' }}>{w.failure}</div>}
        </div>
      ))}
    </>
  )
}
