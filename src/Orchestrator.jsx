import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { Badge, Err, CodeBlock, Empty, Loading, usePoll, q, timeAgo } from './ui.jsx'
import { Monitor } from './Monitor.jsx'
import { ApproveBar } from './InlineApproval.jsx'

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
const TASK_CLS = { Successful: 'good', Running: 'info', 'Waiting for owner': 'warn', Failed: 'bad', Blocked: 'mute', 'Not started': 'mute', Cancelled: 'mute' }
const AGENT_LABEL = { agent1: 'Agent 1', agent2: 'Agent 2', owner: 'You' }
const OUTCOME_CLS = { Successful: 'good', Running: 'info', 'Waiting for owner': 'warn', Failed: 'bad', Cancelled: 'mute', 'Completed with warnings': 'warn' }

function Tasks({ w }) {
  return (
    <div style={{ margin: '8px 0' }}>
      {(w.tasks || []).map(t => (
        <div className="row" key={t.key} style={{ margin: '3px 0' }}>
          <span className="sub">{t.name}{t.status === 'Blocked' ? ' (blocked by ' + t.blocked_by + ')' : ''}</span>
          <span className={'badge ' + (TASK_CLS[t.status] || 'mute')}>{t.status}</span>
        </div>
      ))}
    </div>
  )
}

const FINISHED = ['completed', 'failed', 'cancelled']

// Red two-step delete for a FINISHED task (first tap asks, second tap deletes). Releases the ZIP so it can be uploaded again.
function DeleteBtn({ id, onDeleted, setErr }) {
  const [ask, setAsk] = useState(false)
  const [busy, setBusy] = useState(false)
  async function del(e) {
    e.stopPropagation()
    if (!ask) { setAsk(true); return }
    setBusy(true); setErr('')
    try { await callOrch('delete_workflow', { workflow_id: id }); onDeleted(id) } catch (x) { setErr(x.message); setAsk(false) }
    setBusy(false)
  }
  return (
    <div className="actions" onClick={e => e.stopPropagation()}>
      <button type="button" className="btn no" disabled={busy} onClick={del}>{busy ? 'Deleting...' : ask ? 'Tap again to delete' : 'Delete'}</button>
      {ask && !busy && <button type="button" className="btn ghost" onClick={e => { e.stopPropagation(); setAsk(false) }}>Keep</button>}
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

function Detail({ id, onChanged, onDeleted, setErr }) {
  const [busy, setBusy] = useState('')
  const [ack, setAck] = useState(false)
  const [destAck, setDestAck] = useState(false)
  // The poll calls "advance": the server moves every stage that needs no owner decision and stops at the first one that does.
  // The poll never sends a confirmation: sensitive / destructive steps only move when you tick and press Continue.
  const { data, error, loading, reload } = usePoll(() => callOrch('advance', { workflow_id: id }), [id], 8000)
  const { data: ap } = usePoll(async () => {
    const w = data && data.workflow; const aid = w && w.stage === 'awaiting_approval' && w.steps && w.steps.approval && w.steps.approval.id
    if (!aid) return null
    return (await q(supabase.from('approvals').select('id,status,decided_at,details').eq('id', aid).maybeSingle()))
  }, [data && data.workflow && data.workflow.rev], 8000)
  if (loading && !data) return <Loading />
  if (!data) return <Err msg={error} />
  const w = data.workflow
  const s = w.steps || {}
  const wait = data.waiting
  const pend = w.pending_approvals || []
  const sensitiveCode = pend.find(x => x.kind === 'code_change' && x.sensitive)
  const destructive = pend.some(x => x.kind === 'db_change' && x.sensitive) || ((s.sql && s.sql.items) || []).some(it => it.risk === 'destructive')
  async function act(action, params = {}) {
    setBusy(action); setErr('')
    try { await callOrch(action, { workflow_id: id, ...params }) } catch (e) { setErr(e.message) }
    setBusy(''); reload(); onChanged()
  }
  const f = w.failure
  const ok = w.outcome === 'Successful'

  // Successful: only the status. No logs, no step details.
  if (ok) return (
    <div className="card">
      <Err msg={error} />
      <div className="row"><b>{w.title}</b><span className="badge good">Successful</span></div>
      <div className="sub">{timeAgo(w.finished_at || w.updated_at)}</div>
      {w.report && <details style={{ marginTop: 8 }}><summary className="sub" style={{ cursor: 'pointer' }}>Report</summary><Report r={w.report} /><CodeBlock label="rollback guidance" tone="warn" text={w.report.rollback_guidance || ''} /></details>}
      <DeleteBtn id={id} onDeleted={onDeleted} setErr={setErr} />
    </div>
  )

  return (
    <div className="card">
      <Err msg={error} />
      <div className="row"><b>{w.title}</b><span className={'badge ' + (OUTCOME_CLS[w.outcome] || 'mute')}>{w.outcome}</span></div>
      <div className="sub">{STAGE_LABEL[w.stage] || w.stage} · {timeAgo(w.updated_at)}{w.running ? ' · running: ' + AGENT_LABEL[w.running.agent] + ' (' + w.running.action + ')' : ''}</div>
      <Tasks w={w} />

      {f && w.stage !== 'cancelled' && (
        <>
          <CodeBlock label="failed" tone="bad" text={[
            'Agent: ' + f.agent, 'Stage: ' + f.stage, 'Task: ' + (f.task || '-') + (f.task_id ? ' (' + f.task_id + ')' : ''), 'Code: ' + f.code, '', f.message
          ].join('\n')} />
          {f.log && <CodeBlock label="error log" tone="bad" text={f.log} />}
          <CodeBlock label="what to do" tone="info" text={f.recovery || 'Read the error above and start a new workflow.'} />
          {f.retryable && <div className="actions"><button className="btn" disabled={!!busy} onClick={() => act('retry')}>{busy === 'retry' ? 'Retrying...' : 'Retry (read-only step)'}</button></div>}
        </>
      )}
      {w.stage === 'cancelled' && f && <CodeBlock label="cancelled" tone="bad" text={f.message} />}

      {!f && wait && wait.for === 'approval_unavailable' && <CodeBlock label="approval system unavailable" tone="warn" text={wait.detail} />}
      {!f && wait && wait.for === 'ci' && <CodeBlock label="waiting" tone="info" text={wait.detail} />}

      {pend.length > 0 && (
        <CodeBlock label="needs your approval" tone="warn" wrap={false} text={pend.map(x => (x.sensitive ? 'SENSITIVE  ' : '') + (x.kind === 'code_change' ? 'Code change' : 'SQL ' + (x.path || '')) + ' - ' + x.why).join('\n') + '\n\nApprove or reject right below. Everything after your approval continues by itself.'} />
      )}
      {pend.filter(x => x.approval_id).map(x => (
        <div className="card" key={x.approval_id} style={{ margin: '6px 0' }}>
          <div className="sub" style={{ wordBreak: 'break-word' }}>{x.sensitive ? 'SENSITIVE · ' : ''}{x.kind === 'code_change' ? 'Code change' : 'SQL ' + (x.path || '')}</div>
          <ApproveBar id={x.approval_id} title={w.title + ' - ' + (x.kind === 'code_change' ? 'code change' : 'SQL ' + (x.path || ''))} kind={x.kind} risky={x.sensitive}
            onDone={() => { reload(); onChanged() }} setErr={setErr} />
        </div>
      ))}
      {(w.stage === 'awaiting_approval' && sensitiveCode && ap && ap.status === 'approved') || (wait && wait.for === 'sensitive_confirmation') ? (
        <>
          <label className="sub" style={{ display: 'block', margin: '6px 0' }}><input type="checkbox" style={{ width: 'auto', marginRight: 8 }} checked={ack} onChange={e => setAck(e.target.checked)} />I confirm: this change touches sensitive files ({((sensitiveCode && sensitiveCode.sensitive_paths) || []).join(', ')})</label>
          <div className="actions"><button className="btn ok" disabled={!!busy || !ack} onClick={() => act('advance', { sensitive_ack: 'APPROVE-SENSITIVE' })}>{busy === 'advance' ? 'Continuing...' : 'Confirm and continue'}</button></div>
        </>
      ) : null}
      {wait && wait.for === 'destructive_confirmation' && (
        <>
          <label className="sub" style={{ display: 'block', margin: '6px 0' }}><input type="checkbox" style={{ width: 'auto', marginRight: 8 }} checked={destAck} onChange={e => setDestAck(e.target.checked)} />I confirm: this SQL contains destructive statements (DELETE / UPDATE / ALTER ... DROP). It is never run automatically.</label>
          <div className="actions"><button className="btn ok" disabled={!!busy || !destAck} onClick={() => act('advance', { destructive_ack: 'APPROVE-DESTRUCTIVE' })}>{busy === 'advance' ? 'Running SQL...' : 'Confirm and run SQL'}</button></div>
        </>
      )}

      {w.zip && <CodeBlock label="ZIP validation" tone="info" wrap={false} text={[
        'Repository: ' + w.repo + '  (base branch: ' + (w.zip.base_branch || '?') + ')',
        'Base commit: ' + w.zip.base_commit,
        ...(w.zip.supabase_project ? ['Supabase project for SQL: ' + w.zip.supabase_project.label + ' (' + String(w.zip.supabase_project.ref).slice(0, 8) + '...)'] : []),
        'ZIP SHA-256: ' + w.zip.checksum,
        'Extracted: ' + w.zip.total_extracted_bytes + ' bytes in ' + (w.zip.changed_files || []).length + ' change(s)',
        ...((w.zip.ignored_entries || []).length ? ['Skipped OS junk: ' + w.zip.ignored_entries.length] : []),
        'Secret scan: ' + (w.zip.secret_scan || 'passed')
      ].join('\n')} />}
      {w.zip && <CodeBlock label="files in this ZIP" wrap={false} text={(w.zip.changed_files || []).map(x => x.op.toUpperCase() + '  ' + x.path + (x.sha256 ? '  ' + x.sha256.slice(0, 10) : '')).join('\n')} />}
      {w.zip && w.zip.gemini && <CodeBlock label="gemini review (compact diff only)" tone={w.zip.gemini.review_partial ? 'warn' : 'info'} wrap={false} text={[
        'Input cap: ' + w.zip.gemini.input_max_chars + ' chars, output cap: ' + w.zip.gemini.output_max_tokens + ' tokens',
        'Sent: ' + (w.zip.gemini.input_chars != null ? w.zip.gemini.input_chars + ' chars' : '-') + ' (ZIP and full files are never sent)',
        'Review: ' + (w.zip.gemini.review_available === false ? 'not available' : w.zip.gemini.review_partial ? 'PARTIAL - lower-priority hunks were truncated' : 'complete'),
        ...(w.zip.gemini.omitted ? ['Omitted: ' + ((w.zip.gemini.omitted.files_dropped || []).length ? (w.zip.gemini.omitted.files_dropped.length + ' file(s) dropped (' + w.zip.gemini.omitted.files_dropped.slice(0, 5).join(', ') + '); ') : '') + (((w.zip.gemini.omitted.hunks_truncated || []).length + (w.zip.gemini.omitted.hunks_removed || []).length) + ' diff hunk(s) truncated/removed (' + [...(w.zip.gemini.omitted.hunks_truncated || []), ...(w.zip.gemini.omitted.hunks_removed || [])].slice(0, 5).join(', ') + '). Security findings are always kept.')] : []),
        'Tokens: ' + (w.zip.gemini.tokens_in ?? '-') + ' in / ' + (w.zip.gemini.tokens_out ?? '-') + ' out' + (w.zip.gemini.estimated_cost_usd != null ? '  ~$' + w.zip.gemini.estimated_cost_usd : '')
      ].join('\n')} />}
      {ap && ap.details && Array.isArray(ap.details.files) && ap.details.files.length > 0 && (
        <details open={w.stage === 'awaiting_approval'} style={{ marginTop: 6 }}>
          <summary className="sub" style={{ cursor: 'pointer' }}>Diff preview ({ap.details.files.length} files, base {String(ap.details.base_sha || '').slice(0, 7)})</summary>
          {ap.details.files.map(x => <CodeBlock key={x.path} label={x.op + ' ' + x.path + '  +' + x.added + ' -' + x.removed + (x.sensitive ? '  [SENSITIVE]' : '')} tone={x.sensitive ? 'warn' : undefined} text={x.preview || '(no text preview)'} />)}
        </details>
      )}
      {w.zip && (w.zip.sql || []).length > 0 && (
        <CodeBlock label="sql migrations (Agent 1)" tone={(w.zip.sql || []).some(x => x.status === 'blocked') ? 'warn' : 'info'} wrap={false} text={(w.zip.sql || []).map(x => {
          const it = ((s.sql && s.sql.items) || []).find(y => y.path === x.path)
          return (x.status === 'blocked' ? 'BLOCKED  ' : (it ? String(it.status).toUpperCase() : 'REVIEWED') + '  ') + x.path + (x.risk === 'destructive' ? '  [destructive: ' + (x.flags || []).join(', ') + ']' : '') + (x.reason ? '\n    ' + x.reason : '')
        }).join('\n')} />
      )}
      {w.zip && (w.zip.sql || []).filter(x => x.status === 'reviewed').map(x => <details key={x.path}><summary className="sub" style={{ cursor: 'pointer' }}>SQL text: {x.path}</summary><CodeBlock label={x.path} text={x.sql || ''} /></details>)}
      {s.agent2_propose && (s.agent2_propose.warnings || []).length > 0 && <CodeBlock label="agent 2 warnings" tone="warn" text={s.agent2_propose.warnings.join('\n')} />}
      {s.agent2_propose && s.agent2_propose.ai_review && <CodeBlock label="ai review" tone="info" text={s.agent2_propose.ai_review} />}
      {s.ci && s.ci.state === 'failing' && <CodeBlock label="github actions: failing" tone="bad" wrap={false} text={(s.ci.runs || []).map(r => r.name + ' ' + r.status + '/' + (r.conclusion || '-') + '@' + r.sha).join('\n') || 'no run detail'} />}

      {w.report && <><Report r={w.report} /><CodeBlock label="rollback guidance" tone="warn" text={w.report.rollback_guidance || 'No automatic rollback. Owner must review and revert through a separately approved change.'} /></>}

      {['awaiting_approval', 'ci_waiting', 'awaiting_sql', 'ci_passed'].includes(w.stage) && <div className="actions"><button className="btn ghost" disabled={!!busy} onClick={() => act('cancel')}>Cancel</button></div>}
      {FINISHED.includes(w.stage) && <DeleteBtn id={id} onDeleted={onDeleted} setErr={setErr} />}

      {w.events && w.events.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary className="sub" style={{ cursor: 'pointer' }}>History</summary>
          <CodeBlock label="events" wrap={false} text={w.events.map(e => (e.at || '').slice(11, 19) + '  ' + e.message).join('\n')} />
        </details>
      )}
    </div>
  )
}


function ZipUpload({ repos, projects, onCreated, setErr }) {
  const [repo,setRepo]=useState('')
  const [branches,setBranches]=useState(null) // null = not loaded / not supported by the server yet
  const [brNote,setBrNote]=useState('')
  const [base,setBase]=useState('')
  const [project,setProject]=useState('')
  const curRepo=repo||repos[0]||''
  useEffect(()=>{
    if(!curRepo){setBranches(null);return}
    let live=true
    setBranches(null); setBrNote(''); setBase('')
    callOrch('list_branches',{repo:curRepo}).then(r=>{if(live)setBranches(r)}).catch(e=>{if(live)setBrNote(/unknown action/i.test(e.message)?'Branch list needs the latest server files (default branch is used).':'Branch list unavailable: '+e.message)})
    return ()=>{live=false}
  },[curRepo])
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
      const proj=(projects||[]).find(x=>x.ref===(project||(projects[0]&&projects[0].ref)))
      if(proj&&/prod/i.test(proj.label)&&!window.confirm('SQL in this ZIP will run on the PRODUCTION project "'+proj.label+'" (after your approvals). Continue?')){setBusy(false);return}
      const result=await callOrch('upload_zip',{repo:curRepo,title,zip_base64:base64,request_id:crypto.randomUUID(),...(base?{base}:{}),...(proj?{supabase_project:proj.ref}:{}),...(baseSha.trim()?{expected_base_sha:baseSha.trim()}:{})})
      onCreated(result.workflow.id)
      setFile(null); setBaseSha('')
    } catch(e){setErr(e.message)}
    setBusy(false)
  }
  return <div className="card">
    <b>Deployment Control Center — ZIP upload</b>
    <p className="sub">Upload changed files only. Max 2 MB ZIP / 40 files / 600 KB extracted. The ZIP is checked on the server only; nothing is written to GitHub until you approve, and only a small diff summary (never the ZIP) is sent to Gemini.</p>
    <select value={curRepo} onChange={e=>setRepo(e.target.value)} disabled={!repos.length}>{repos.map(r=><option key={r} value={r}>{r}</option>)}</select>
    {branches ? <>
      <label className="sub" style={{display:'block',marginTop:6}}>Branch to build on</label>
      <select value={base} onChange={e=>setBase(e.target.value)}>
        <option value="">Default ({branches.default_branch})</option>
        {branches.branches.filter(b=>!b.default).map(b=><option key={b.name} value={b.name}>{b.name}{b.protected?' (protected)':''}</option>)}
      </select>
      <div className="sub">Your code is committed to a NEW agent2/* branch created from this branch. Protected branches are never written directly; merging stays a separate approval.{branches.truncated?' Showing the first 100 branches.':''}</div>
    </> : brNote ? <div className="sub">{brNote}</div> : null}
    {projects&&projects.length>0&&<>
      <label className="sub" style={{display:'block',marginTop:6}}>Supabase project for SQL</label>
      <select value={project||projects[0].ref} onChange={e=>setProject(e.target.value)}>{projects.map(x=><option key={x.ref} value={x.ref}>{x.label} ({String(x.ref).slice(0,8)}...)</option>)}</select>
      <div className="sub">Used only if the ZIP has .sql files. Only projects on the server allow-list can be chosen, and each SQL still needs its own approval.</div>
    </>}
    <input value={title} onChange={e=>setTitle(e.target.value)} placeholder="Change title"/>
    <input value={baseSha} onChange={e=>setBaseSha(e.target.value)} placeholder="Expected base commit SHA (optional, 40 chars)" autoCapitalize="none" spellCheck={false}/>
    <input type="file" accept=".zip,application/zip" onChange={e=>setFile(e.target.files&&e.target.files[0]||null)}/>
    <p className="sub">Deletions: add a UTF-8 <code>.blisscco-delete.txt</code> with one repository path per line. SQL (<code>.sql</code>) files are reviewed by Agent 1 and need their own approval after CI passes; anything Agent 1's safeguards forbid is shown as BLOCKED with the reason and is never executed. A ZIP with only SQL is not accepted.</p>
    <button className="btn" disabled={busy||!file||!repos.length||!title.trim()} onClick={upload}>{busy?'Validating ZIP...':'Validate & preview ZIP'}</button>
  </div>
}

export default function Orchestrator({ go }) {
  const [err, setErr] = useState('')
  const [sel, setSel] = useState(() => { const m = /wf=([\w-]+)/.exec(location.hash); if (m) return m[1]; try { return sessionStorage.getItem('orch_sel') || '' } catch { return '' } })
  const [repos, setRepos] = useState([])
  const [projects, setProjects] = useState([])
  useEffect(() => { callOrch('heartbeat').then(r => { setRepos(r.repos || []); setProjects(r.supabase_projects || []) }).catch(e => setErr(e.message)) }, [])
  const { data, error, loading, reload } = usePoll(() => callOrch('list'), [], 10000)
  const pick = (id) => { setSel(id); history.replaceState(null, '', id ? '#orchestrator&wf=' + id : '#orchestrator'); try { if (id) sessionStorage.setItem('orch_sel', id); else sessionStorage.removeItem('orch_sel') } catch { /* skip */ } reload() } // survives refresh and tab switches
  const list = (data && data.workflows) || []
  const deleted = (id) => { if (id === sel) pick(''); else reload() }
  return (
    <>
      <Err msg={error} /><Err msg={err} />
      <Monitor call={callOrch} onOpenWorkflow={pick} go={go} />
      <ZipUpload repos={repos} projects={projects} onCreated={pick} setErr={setErr} />
      <Create repos={repos} onCreated={pick} setErr={setErr} />
      {list.filter(w => w.needs_owner).length > 0 && <div className="card"><b>Pending owner approvals</b> <span className="sub">{list.filter(w => w.needs_owner).length} workflow(s) wait for you: approve inside the workflow card below (or in the Approvals tab). Only sensitive or mandatory steps ask; everything else runs by itself.</span></div>}
      {sel && <><h2>Current workflow</h2><Detail key={sel} id={sel} onChanged={reload} onDeleted={deleted} setErr={setErr} /></>}
      <h2>Task history</h2>
      {loading && !data ? <Loading /> : list.length === 0 ? <Empty text="No orchestrated tasks yet" /> : list.map(w => (
        <div className="card" key={w.id} onClick={() => pick(w.id)} style={{ cursor: 'pointer', outline: w.id === sel ? '1px solid var(--muted)' : 'none' }}>
          <div className="row"><b>{w.title}</b><span className={'badge ' + (OUTCOME_CLS[w.outcome] || 'mute')}>{w.outcome}</span></div>
          <div className="sub">{w.outcome === 'Successful' ? timeAgo(w.created_at) : (STAGE_LABEL[w.stage] || w.stage) + ' · ' + timeAgo(w.created_at)}</div>
          <div className="sub">ID {String(w.id).slice(0, 8)} · {(w.agents || []).map(a => a === 'agent1' ? 'Agent 1' : 'Agent 2').join(' + ') || '-'} · started {timeAgo(w.started_at)}{w.finished_at ? ' · finished ' + timeAgo(w.finished_at) : ''}{w.retries ? ' · retries ' + w.retries : ''}{w.approval ? ' · approval ' + w.approval : ''}</div>
          {w.needs_owner && <div className="sub">Needs your approval</div>}
          {w.failure && <div className="sub" style={{ color: 'var(--bad, #c0392b)' }}>{w.failed_agent} / {w.failed_stage}: {w.failure}{w.failure_detail && w.failure_detail.recovery ? ' - ' + w.failure_detail.recovery : ''}</div>}
          {FINISHED.includes(w.stage) && <DeleteBtn id={w.id} onDeleted={deleted} setErr={setErr} />}
        </div>
      ))}
    </>
  )
}
