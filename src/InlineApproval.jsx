import { useState, useEffect } from 'react'
import { supabase } from './supabaseClient'
import { usePoll, q, Badge, Err, logAction } from './ui.jsx'

// One decision path for every screen: the same update the Approvals tab always did (only a still-pending row can be decided,
// and RLS / the server re-check it). Approving here changes nothing about what runs afterwards; apply / confirm steps and
// their PRODUCTION / SENSITIVE ticks stay exactly where they were.
const NEEDS_CONFIRM = ['promote', 'rollback', 'workflow_run', 'db_change', 'env_change', 'redeploy', 'git_push', 'rate_test', 'ads_burst']

export async function decideApproval(id, status, { title = 'Approval', note = null, task_id = null, agent_id = null } = {}) {
  const { data: s } = await supabase.auth.getSession()
  const uid = s.session && s.session.user ? s.session.user.id : null
  if (!uid) throw new Error('Not signed in')
  const { data, error } = await supabase.from('approvals')
    .update({ status, decided_by: uid, decision_note: note })
    .eq('id', id).eq('status', 'pending').select('id')
  if (error) throw new Error(error.message)
  if (!data || data.length === 0) throw new Error('Already decided, expired or not found. Refresh and check the Approvals tab.')
  await logAction('approval_' + status, title, { task_id, agent_id, level: status === 'approved' ? 'success' : 'warn' })
  try { window.dispatchEvent(new Event('approvals-changed')) } catch { /* the dot also refreshes by itself */ }
}

// Approve / Reject buttons that can sit next to any action button.
export function ApproveBar({ id, title, kind, risky, task_id, agent_id, onDone, setErr }) {
  const [busy, setBusy] = useState('')
  async function go(status) {
    if (status === 'approved' && (risky || NEEDS_CONFIRM.includes(kind)) && !window.confirm('Approve: ' + (title || 'this request') + '?')) return
    setBusy(status); if (setErr) setErr('')
    try { await decideApproval(id, status, { title: title || 'Approval', task_id, agent_id }); if (onDone) onDone(status) }
    catch (e) { if (setErr) setErr(e.message); else window.alert(e.message) }
    setBusy('')
  }
  return (
    <div className="actions">
      <button className="btn ok" disabled={!!busy} onClick={() => go('approved')}>{busy === 'approved' ? 'Approving...' : 'Approve'}</button>
      <button className="btn no" disabled={!!busy} onClick={() => go('rejected')}>{busy === 'rejected' ? 'Rejecting...' : 'Reject'}</button>
    </div>
  )
}

function summary(a) {
  const d = a.details || {}
  if (d.kind === 'code_change') return (d.files ? d.files.length : 0) + ' file(s) to ' + (d.branch || '?')
  if (d.kind === 'db_change') return (d.project_label ? '[Supabase: ' + d.project_label + '] ' : '') + (d.sql ? String(d.sql).slice(0, 300) : 'SQL on ai_control')
  if (d.kind === 'local_command' || d.kind === 'command') return d.command || ''
  return d.note || d.summary || ''
}

// Pending approvals of the given kinds, shown right where the request was made. Approving moves the row to the
// "Approved - ready to apply" list of the same page (onDone reloads it).
export function PendingInline({ kinds, onDone }) {
  const [err, setErr] = useState('')
  const { data, error, reload } = usePoll(() =>
    q(supabase.from('approvals').select('*').eq('status', 'pending').order('requested_at', { ascending: false }).limit(30)), [], 6000)
  useEffect(() => {
    const on = () => reload()
    window.addEventListener('approvals-changed', on)
    return () => window.removeEventListener('approvals-changed', on)
  }, [reload])
  const rows = (data || []).filter(a => a.details && kinds.includes(a.details.kind))
  if (rows.length === 0 && !error && !err) return null
  return (
    <>
      <div className="sec-title">Waiting for your approval</div>
      <Err msg={error} /><Err msg={err} />
      {rows.map(a => (
        <div className="card" key={a.id}>
          <div className="row"><b>{a.title}</b><Badge s="pending" /></div>
          {summary(a) && <div className="sub" style={{ wordBreak: 'break-word' }}>{summary(a)}</div>}
          <ApproveBar id={a.id} title={a.title} kind={a.details.kind} task_id={a.task_id} agent_id={a.agent_id}
            risky={Boolean(a.details.production || (a.details.sensitive_paths || []).length)}
            onDone={() => { reload(); if (onDone) onDone() }} setErr={setErr} />
        </div>
      ))}
    </>
  )
}
