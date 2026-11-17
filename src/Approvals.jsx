import { useState } from 'react'
import { supabase } from './supabaseClient'
import { usePoll, q, Badge, Err, Loading, Empty, timeAgo, logAction } from './ui.jsx'
import { PendingDot } from './Monitor.jsx'

function Pending({ a, onDone, setErr }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  async function decide(status) {
    setBusy(true); setErr('')
    const { data: s } = await supabase.auth.getSession()
    const { error } = await supabase.from('approvals')
      .update({ status, decided_by: s.session.user.id, decision_note: note || null })
      .eq('id', a.id).eq('status', 'pending')
    if (error) setErr(error.message)
    else {
      await logAction('approval_' + status, a.title, { task_id: a.task_id, agent_id: a.agent_id, level: status === 'approved' ? 'success' : 'warn' })
      onDone()
    }
    setBusy(false)
  }

  return (
    <div className="card">
      <div className="row"><b>{a.title}</b><Badge s={a.status} /></div>
      <div className="sub">Requested {timeAgo(a.requested_at)}</div>
      {a.details && Object.keys(a.details).length > 0 && <pre>{JSON.stringify(a.details, null, 2)}</pre>}
      <input placeholder="Note (optional)" value={note} onChange={e => setNote(e.target.value)} style={{ marginTop: 8 }} />
      <div className="actions">
        <button className="btn ok" disabled={busy} onClick={() => decide('approved')}>Approve</button>
        <button className="btn no" disabled={busy} onClick={() => decide('rejected')}>Reject</button>
      </div>
    </div>
  )
}

export default function Approvals() {
  const [err, setErr] = useState('')
  const { data, error, loading, reload } = usePoll(() =>
    q(supabase.from('approvals').select('*').order('requested_at', { ascending: false }).limit(100)), [], 6000)
  if (loading && !data) return <Loading />
  const all = data || []
  const pending = all.filter(a => a.status === 'pending')
  const done = all.filter(a => a.status !== 'pending')

  return (
    <>
      <Err msg={error} /><Err msg={err} />
      <h2>Pending ({pending.length}) <PendingDot count={pending.length} /></h2>
      {pending.length === 0 ? <Empty text="Nothing waiting for approval" /> : pending.map(a => <Pending key={a.id} a={a} onDone={reload} setErr={setErr} />)}
      <h2>History</h2>
      {done.length === 0 ? <Empty text="No decisions yet" /> : done.map(a => (
        <div className="card" key={a.id}>
          <div className="row"><b>{a.title}</b><Badge s={a.status} /></div>
          <div className="sub">Decided {timeAgo(a.decided_at)}{a.decision_note ? ' · ' + a.decision_note : ''}</div>
        </div>
      ))}
    </>
  )
}
