import { useState } from 'react'
import { supabase } from './supabaseClient'
import { usePoll, q, Badge, Err, Loading, timeAgo, effStatus, logAction } from './ui.jsx'

function AgentCard({ a, offlineSec, onSaved }) {
  const [edit, setEdit] = useState(false)
  const [name, setName] = useState(a.name)
  const [desc, setDesc] = useState(a.description || '')
  const [err, setErr] = useState('')

  async function save() {
    setErr('')
    const { error } = await supabase.from('agents').update({ name: name.trim() || a.name, description: desc }).eq('id', a.id)
    if (error) { setErr(error.message); return }
    await logAction('agent_updated', 'Updated ' + name, { agent_id: a.id })
    setEdit(false); onSaved()
  }

  return (
    <div className="card">
      <div className="row"><b>Slot {a.slot}: {a.name}</b><Badge s={effStatus(a, offlineSec)} /></div>
      <div className="sub">{a.description || 'No description'}</div>
      <div className="sub">Last heartbeat: {timeAgo(a.last_heartbeat_at)}</div>
      <Err msg={err} />
      {edit ? (
        <div style={{ marginTop: 8 }}>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Name" />
          <input value={desc} onChange={e => setDesc(e.target.value)} placeholder="Description" />
          <div className="actions">
            <button className="btn" onClick={save}>Save</button>
            <button className="btn ghost" onClick={() => setEdit(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="btn ghost" style={{ marginTop: 8 }} onClick={() => setEdit(true)}>Edit</button>
      )}
    </div>
  )
}

export default function Agents({ offlineSec }) {
  const { data, error, loading, reload } = usePoll(() => q(supabase.from('agents').select('*').order('slot')))
  if (loading && !data) return <Loading />
  return (
    <>
      <Err msg={error} />
      <p className="sub">Agents are placeholders until Phase 2. Offline = no heartbeat for {offlineSec}s.</p>
      {(data || []).map(a => <AgentCard key={a.id + a.updated_at} a={a} offlineSec={offlineSec} onSaved={reload} />)}
    </>
  )
}
