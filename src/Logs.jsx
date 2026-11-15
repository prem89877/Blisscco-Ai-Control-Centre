import { useState } from 'react'
import { supabase } from './supabaseClient'
import { usePoll, q, Badge, Err, Loading, Empty, timeAgo } from './ui.jsx'

const LEVELS = ['all', 'info', 'success', 'warn', 'error']

export default function Logs() {
  const [level, setLevel] = useState('all')
  const { data, error, loading } = usePoll(async () => {
    const [agents, logs] = await Promise.all([
      q(supabase.from('agents').select('id,name')),
      q(supabase.from('activity_logs').select('*').order('created_at', { ascending: false }).limit(150))
    ])
    return { agents, logs }
  })
  if (loading && !data) return <Loading />
  const agents = data ? data.agents : []
  const logs = (data ? data.logs : []).filter(l => level === 'all' || l.level === level)

  return (
    <>
      <Err msg={error} />
      <div className="filters">
        {LEVELS.map(l => <button key={l} className={level === l ? 'on' : ''} onClick={() => setLevel(l)}>{l}</button>)}
      </div>
      {logs.length === 0 ? <Empty text="No logs" /> : logs.map(l => {
        const a = agents.find(x => x.id === l.agent_id)
        return (
          <div className="card" key={l.id}>
            <div className="row"><b>{l.action}</b><Badge s={l.level} /></div>
            {l.message && <div>{l.message}</div>}
            <div className="sub">{l.actor_type}{a ? ' · ' + a.name : ''} · {timeAgo(l.created_at)}</div>
          </div>
        )
      })}
    </>
  )
}
