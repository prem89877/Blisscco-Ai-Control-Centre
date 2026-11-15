import { useState } from 'react'
import { supabase } from './supabaseClient'
import { usePoll, q, Badge, Err, Loading, Empty, timeAgo } from './ui.jsx'

export default function Health() {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const { data, error, loading, reload } = usePoll(async () => {
    const t0 = performance.now()
    const rows = await q(supabase.from('system_health').select('*').order('checked_at', { ascending: false }).limit(60))
    const ms = Math.round(performance.now() - t0)
    const latest = {}
    rows.forEach(r => { if (!latest[r.component]) latest[r.component] = r })
    return { latest: Object.values(latest), clientMs: ms }
  }, [], 30000)

  async function run() {
    setBusy(true); setErr('')
    try {
      const { data: s } = await supabase.auth.getSession()
      const res = await fetch('/api/health', { method: 'POST', headers: { Authorization: 'Bearer ' + s.session.access_token } })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) setErr(j.error || 'Health check failed (' + res.status + ')')
      else reload()
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }

  if (loading && !data) return <Loading />
  return (
    <>
      <Err msg={error} /><Err msg={err} />
      <div className="card row">
        <div><b>Browser to database</b><div className="sub">{data ? data.clientMs + ' ms' : '-'}</div></div>
        <Badge s={data ? (data.clientMs > 1500 ? 'degraded' : 'ok') : 'down'} />
      </div>
      <button className="btn" disabled={busy} onClick={run} style={{ marginBottom: 12 }}>{busy ? 'Checking...' : 'Run server health check'}</button>
      {!data || data.latest.length === 0 ? <Empty text="No server checks yet. Tap the button." /> : data.latest.map(r => (
        <div className="card row" key={r.component}>
          <div><b>{r.component}</b><div className="sub">{r.latency_ms != null ? r.latency_ms + ' ms · ' : ''}{timeAgo(r.checked_at)}</div></div>
          <Badge s={r.status} />
        </div>
      ))}
    </>
  )
}
