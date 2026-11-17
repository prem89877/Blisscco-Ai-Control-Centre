import { useState } from 'react'
import { supabase } from './supabaseClient'
import { usePoll, q, Badge, Err, Loading, Empty, timeAgo, logAction } from './ui.jsx'

const FILTERS = ['all', 'pending', 'running', 'awaiting_approval', 'succeeded', 'failed', 'cancelled']

export default function Tasks() {
  const [filter, setFilter] = useState('all')
  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const [agentId, setAgentId] = useState('')
  const [priority, setPriority] = useState(3)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const { data, error, loading, reload } = usePoll(async () => {
    const [agents, tasks] = await Promise.all([
      q(supabase.from('agents').select('id,name,slot').order('slot')),
      q(supabase.from('tasks').select('*').order('created_at', { ascending: false }).limit(100))
    ])
    return { agents, tasks }
  })

  async function create() {
    if (!title.trim()) { setErr('Title required'); return }
    setBusy(true); setErr('')
    const { data: s } = await supabase.auth.getSession()
    const { data: row, error } = await supabase.from('tasks').insert({
      title: title.trim(), description: desc || null, priority: Number(priority),
      agent_id: agentId || null, created_by: s.session.user.id
    }).select('id').single()
    if (error) setErr(error.message)
    else {
      await logAction('task_created', 'Task: ' + title.trim(), { task_id: row.id, agent_id: agentId || null })
      setTitle(''); setDesc(''); reload()
    }
    setBusy(false)
  }

  async function cancel(t) {
    const { error } = await supabase.from('tasks').update({ status: 'cancelled' }).eq('id', t.id)
    if (error) { setErr(error.message); return }
    await logAction('task_cancelled', 'Cancelled: ' + t.title, { task_id: t.id, level: 'warn' })
    reload()
  }

  if (loading && !data) return <Loading />
  const agents = data ? data.agents : []
  const name = id => (agents.find(a => a.id === id) || {}).name || 'Unassigned'
  const tasks = (data ? data.tasks : []).filter(t => !(t.payload && t.payload.deleted)).filter(t => filter === 'all' || t.status === filter)

  return (
    <>
      <Err msg={error} /><Err msg={err} />
      <div className="card">
        <b>New task</b>
        <input placeholder="Title" value={title} onChange={e => setTitle(e.target.value)} style={{ marginTop: 8 }} />
        <textarea placeholder="Description (optional)" rows={2} value={desc} onChange={e => setDesc(e.target.value)} />
        <select value={agentId} onChange={e => setAgentId(e.target.value)}>
          <option value="">Unassigned</option>
          {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <select value={priority} onChange={e => setPriority(e.target.value)}>
          {[1, 2, 3, 4, 5].map(p => <option key={p} value={p}>Priority {p}{p === 1 ? ' (highest)' : ''}</option>)}
        </select>
        <button className="btn" disabled={busy} onClick={create}>Add task</button>
      </div>
      <div className="filters">
        {FILTERS.map(f => <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{f.replace('_', ' ')}</button>)}
      </div>
      {tasks.length === 0 ? <Empty text="No tasks" /> : tasks.map(t => (
        <div className="card" key={t.id}>
          <div className="row"><b>{t.title}</b><Badge s={t.status} /></div>
          <div className="sub">{name(t.agent_id)} · P{t.priority} · {timeAgo(t.created_at)}</div>
          {t.description && <div className="sub">{t.description}</div>}
          {t.error_message && <div className="err" style={{ marginTop: 6 }}>{t.error_message}</div>}
          {['pending', 'queued'].includes(t.status) && (
            <button className="btn ghost" style={{ marginTop: 8 }} onClick={() => cancel(t)}>Cancel task</button>
          )}
        </div>
      ))}
    </>
  )
}
