import { supabase } from './supabaseClient'
import { usePoll, q, Badge, Err, Loading, Empty, timeAgo, effStatus } from './ui.jsx'

export default function Overview({ offlineSec, go }) {
  const { data, error, loading } = usePoll(async () => {
    const [agents, tasks, approvals, logs] = await Promise.all([
      q(supabase.from('agents').select('*').order('slot')),
      q(supabase.from('tasks').select('id,status').order('created_at', { ascending: false }).limit(500)),
      q(supabase.from('approvals').select('id').eq('status', 'pending')),
      q(supabase.from('activity_logs').select('id,level,action,message,created_at').order('created_at', { ascending: false }).limit(6))
    ])
    return { agents, tasks, approvals, logs }
  })

  if (loading && !data) return <Loading />
  if (!data) return <Err msg={error} />
  const { agents, tasks, approvals, logs } = data
  const n = s => tasks.filter(t => t.status === s).length
  const online = agents.filter(a => ['idle', 'running'].includes(effStatus(a, offlineSec))).length

  return (
    <>
      <Err msg={error} />
      <div className="grid">
        <div className="stat"><b>{online}/{agents.length}</b><small>Agents online</small></div>
        <div className="stat" onClick={() => go('approvals')}><b>{approvals.length}</b><small>Pending approvals</small></div>
        <div className="stat"><b>{n('running') + n('queued') + n('pending')}</b><small>Active tasks</small></div>
        <div className="stat"><b>{n('succeeded')} / {n('failed')}</b><small>Success / Failed</small></div>
      </div>
      <h2>Agents</h2>
      {agents.map(a => (
        <div className="card row" key={a.id}>
          <div><b>{a.name}</b><div className="sub">Heartbeat: {timeAgo(a.last_heartbeat_at)}</div></div>
          <Badge s={effStatus(a, offlineSec)} />
        </div>
      ))}
      <h2>Recent activity</h2>
      {logs.length === 0 ? <Empty text="No activity yet" /> : logs.map(l => (
        <div className="card" key={l.id}>
          <div className="row"><b>{l.action}</b><Badge s={l.level} /></div>
          <div className="sub">{l.message || ''} · {timeAgo(l.created_at)}</div>
        </div>
      ))}
    </>
  )
}
