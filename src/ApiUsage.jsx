import { supabase } from './supabaseClient'
import { usePoll, q, Err, Loading, Empty } from './ui.jsx'

export default function ApiUsage() {
  const { data, error, loading } = usePoll(async () => {
    const since = new Date(Date.now() - 7 * 86400000).toISOString()
    const [agents, rows] = await Promise.all([
      q(supabase.from('agents').select('id,name')),
      q(supabase.from('api_usage').select('*').gte('occurred_at', since).order('occurred_at', { ascending: false }).limit(2000))
    ])
    return { agents, rows }
  }, [], 30000)

  if (loading && !data) return <Loading />
  if (!data) return <Err msg={error} />
  const { agents, rows } = data
  const sum = (arr, k) => arr.reduce((s, r) => s + Number(r[k] || 0), 0)

  const byDay = {}
  rows.forEach(r => { const d = r.occurred_at.slice(0, 10); byDay[d] = (byDay[d] || 0) + Number(r.request_count || 0) })
  const days = Object.keys(byDay).sort()
  const max = Math.max(1, ...Object.values(byDay))

  const byAgent = {}
  rows.forEach(r => {
    const n = (agents.find(a => a.id === r.agent_id) || {}).name || 'Unknown'
    byAgent[n] = byAgent[n] || { req: 0, tok: 0 }
    byAgent[n].req += Number(r.request_count || 0)
    byAgent[n].tok += Number(r.tokens_in || 0) + Number(r.tokens_out || 0)
  })

  return (
    <>
      <Err msg={error} />
      <p className="sub">Last 7 days</p>
      <div className="grid">
        <div className="stat"><b>{sum(rows, 'request_count')}</b><small>Requests</small></div>
        <div className="stat"><b>{sum(rows, 'tokens_in') + sum(rows, 'tokens_out')}</b><small>Tokens</small></div>
        <div className="stat"><b>${sum(rows, 'cost_estimate').toFixed(4)}</b><small>Est. cost</small></div>
        <div className="stat"><b>{rows.filter(r => r.status_code >= 400).length}</b><small>Failed calls</small></div>
      </div>
      {rows.length === 0 ? <Empty text="No API usage recorded yet (starts in Phase 2)" /> : (
        <>
          <h2>Requests per day</h2>
          <div className="card">
            {days.map(d => (
              <div key={d} style={{ marginBottom: 8 }}>
                <div className="row sub"><span>{d}</span><span>{byDay[d]}</span></div>
                <div className="bar" style={{ width: (byDay[d] / max) * 100 + '%' }} />
              </div>
            ))}
          </div>
          <h2>Per agent</h2>
          {Object.entries(byAgent).map(([n, v]) => (
            <div className="card row" key={n}><b>{n}</b><span className="sub">{v.req} req · {v.tok} tokens</span></div>
          ))}
        </>
      )}
    </>
  )
}
