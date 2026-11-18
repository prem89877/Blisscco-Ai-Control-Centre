import { useState } from 'react'
import { supabase } from './supabaseClient'
import { usePoll, q, Badge, Err, Empty, Skeleton, CodeBlock, timeAgo, logAction } from './ui.jsx'

// Per-agent task history. Every agent card shows ONLY its own tasks (tasks.agent_id = this agent),
// the same way the Orchestrator tab keeps its own task history. Nothing new is stored: agents already
// write one task row per run, this page just reads them.
const PAGE = 20
const GROUPS = [
  ['all', 'All', () => true],
  ['succeeded', 'Successful', t => t.status === 'succeeded'],
  ['failed', 'Failed', t => t.status === 'failed'],
  ['active', 'Active', t => ['pending', 'queued', 'running', 'awaiting_approval'].includes(t.status)]
]
const FINISHED = ['succeeded', 'failed', 'cancelled']

function duration(t) {
  if (!t.started_at || !t.finished_at) return ''
  const s = Math.max(0, Math.round((new Date(t.finished_at) - new Date(t.started_at)) / 1000))
  return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's'
}

function Item({ t, onChanged, setErr }) {
  const [ask, setAsk] = useState(false)
  const [busy, setBusy] = useState(false)
  const action = t.payload && t.payload.action
  const dur = duration(t)

  async function remove(e) {
    e.stopPropagation()
    if (!ask) { setAsk(true); return }
    setBusy(true); setErr('')
    // Same soft-delete the Tasks tab already hides (payload.deleted), so the row is kept for audit.
    const { error } = await supabase.from('tasks').update({ payload: { ...(t.payload || {}), deleted: true } }).eq('id', t.id)
    if (error) { setErr(error.message); setAsk(false); setBusy(false); return }
    await logAction('task_deleted', 'Removed from agent history: ' + t.title, { task_id: t.id, agent_id: t.agent_id })
    onChanged()
  }

  return (
    <div className="card hist">
      <div className="row"><b>{t.title}</b><Badge s={t.status} /></div>
      <div className="sub">
        {timeAgo(t.created_at)} · ID {String(t.id).slice(0, 8)}{action ? ' · ' + action : ''}{dur ? ' · took ' + dur : ''}
      </div>
      {t.description && <div className="sub">{t.description}</div>}
      {t.error_message && <div className="err" style={{ marginTop: 6 }}>{t.error_message}</div>}
      {t.result && (
        <details className="hist-more">
          <summary className="sub">Result</summary>
          <CodeBlock label="result" wrap={false} text={JSON.stringify(t.result, null, 2).slice(0, 6000)} />
        </details>
      )}
      {FINISHED.includes(t.status) && (
        <div className="actions" style={{ marginTop: 8 }}>
          <button type="button" className={'btn ' + (ask ? 'no' : 'ghost')} disabled={busy} onClick={remove}>{ask ? 'Tap again to delete' : 'Delete'}</button>
          {ask && !busy && <button type="button" className="btn ghost" onClick={e => { e.stopPropagation(); setAsk(false) }}>Keep</button>}
        </div>
      )}
    </div>
  )
}

export default function AgentHistory({ agentId }) {
  const [group, setGroup] = useState('all')
  const [limit, setLimit] = useState(PAGE * 2)
  const [err, setErr] = useState('')

  const { data, error, loading, reload } = usePoll(() =>
    q(supabase.from('tasks')
      .select('id,agent_id,title,description,status,payload,result,error_message,created_at,started_at,finished_at')
      .eq('agent_id', agentId).order('created_at', { ascending: false }).limit(limit)), [agentId, limit], 10000)

  if (loading && !data) return <Skeleton rows={2} />
  const all = (data || []).filter(t => !(t.payload && t.payload.deleted))
  const pick = (GROUPS.find(g => g[0] === group) || GROUPS[0])[2]
  const list = all.filter(pick)
  const count = id => all.filter(GROUPS.find(g => g[0] === id)[2]).length

  return (
    <>
      <Err msg={error} /><Err msg={err} />
      <div className="filters">
        {GROUPS.map(([id, label]) => <button key={id} className={group === id ? 'on' : ''} onClick={() => setGroup(id)}>{label} {count(id)}</button>)}
      </div>
      {list.length === 0 ? <Empty text="No history yet for this agent" /> : list.slice(0, limit).map(t => <Item key={t.id} t={t} onChanged={reload} setErr={setErr} />)}
      {(data || []).length >= limit && <button type="button" className="btn ghost" onClick={() => setLimit(l => l + PAGE * 2)}>Show older</button>}
    </>
  )
}
