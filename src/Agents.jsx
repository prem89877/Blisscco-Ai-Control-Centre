import { useState } from 'react'
import { supabase } from './supabaseClient'
import { usePoll, q, Badge, Err, Loading, Icon, timeAgo, effStatus, logAction } from './ui.jsx'
import Agent1Panel from './Agent1.jsx'
import Agent2Panel from './Agent2.jsx'

function AgentCard({ a, offlineSec, onSaved }) {
  const hasConsole = a.slot === 1 || a.slot === 2
  const [open, setOpen] = useState(false)
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
    <div className={'card agent' + (open ? ' open' : '')}>
      <button type="button" className="agent-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="meta">
          <b>Slot {a.slot}: {a.name}</b>
          <span className="sub">{a.description || 'No description'}</span>
          <span className="sub" style={{ display: 'block' }}>Last heartbeat: {timeAgo(a.last_heartbeat_at)}</span>
        </span>
        <span className="right"><Badge s={effStatus(a, offlineSec)} /><span className="chev"><Icon n="chevron" /></span></span>
      </button>
      <div className="drop"><div className="drop-inner">
        {open && (
          <div className="drop-body">
            <Err msg={err} />
            {hasConsole && <><div className="sec-title">Console</div>{a.slot === 1 ? <Agent1Panel /> : <Agent2Panel />}</>}
            {!hasConsole && <div className="sub">No console for this slot yet.</div>}
            <div className="sec-title">Details</div>
            {edit ? (
              <div>
                <input value={name} onChange={e => setName(e.target.value)} placeholder="Name" />
                <input value={desc} onChange={e => setDesc(e.target.value)} placeholder="Description" />
                <div className="actions">
                  <button className="btn" onClick={save}>Save</button>
                  <button className="btn ghost" onClick={() => setEdit(false)}>Cancel</button>
                </div>
              </div>
            ) : (
              <button className="btn ghost" onClick={() => setEdit(true)}>Edit name and description</button>
            )}
          </div>
        )}
      </div></div>
    </div>
  )
}

export default function Agents({ offlineSec }) {
  const { data, error, loading, reload } = usePoll(() => q(supabase.from('agents').select('*').order('slot')))
  if (loading && !data) return <Loading />
  return (
    <>
      <Err msg={error} />
      <p className="sub">Offline = no heartbeat for {offlineSec}s. Tap an agent to open its console.</p>
      {(data || []).map(a => <AgentCard key={a.id} a={a} offlineSec={offlineSec} onSaved={reload} />)}
    </>
  )
}
