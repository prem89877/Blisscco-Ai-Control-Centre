import { useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from './supabaseClient'
import { Err, CodeBlock, usePoll } from './ui.jsx'

// ---------------------------------------------------------------- approval indicator
// The green dot is derived ONLY from the persisted approvals table (status = 'pending'), re-read every few seconds, on focus,
// when the tab becomes visible again and when the device comes back online. No frontend state decides it, so a refresh or an
// app restart shows exactly the same result. Approving / rejecting still happens in the Approvals tab (and is checked server-side / by RLS).
export function usePendingApprovals(enabled = true) {
  const [count, setCount] = useState(null)
  const load = useCallback(async () => {
    try {
      const { count: c, error } = await supabase.from('approvals').select('id', { count: 'exact', head: true }).eq('status', 'pending')
      if (!error && typeof c === 'number') setCount(c)
    } catch { /* keep the last known value */ }
  }, [])
  useEffect(() => {
    if (!enabled) return
    load()
    const t = setInterval(load, 8000)
    const on = () => { if (document.visibilityState !== 'hidden') load() }
    document.addEventListener('visibilitychange', on); window.addEventListener('focus', on); window.addEventListener('online', on)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', on); window.removeEventListener('focus', on); window.removeEventListener('online', on) }
  }, [enabled, load])
  return { count, reload: load }
}

export function PendingDot({ count }) {
  if (!count || count < 1) return null
  return <span className="dot-green" role="status" aria-label={count + ' approval request' + (count === 1 ? '' : 's') + ' pending'} title={count + ' pending'} />
}

const HCLS = { healthy: 'good', busy: 'info', unavailable: 'warn', failed: 'bad', unknown: 'mute' }
const NAMES = { orchestrator: 'Orchestrator', agent1: 'Agent 1', agent2: 'Agent 2', gemini: 'Gemini API', github: 'GitHub', supabase: 'Supabase', vercel: 'Vercel' }
const fmtDur = (ms) => ms == null ? '-' : ms < 1000 ? ms + ' ms' : ms < 60000 ? Math.round(ms / 1000) + ' s' : Math.floor(ms / 60000) + ' m ' + Math.round((ms % 60000) / 1000) + ' s'
const fmtLeft = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0')

function useNow(ms = 1000) { const [n, setN] = useState(Date.now()); useEffect(() => { const t = setInterval(() => setN(Date.now()), ms); return () => clearInterval(t) }, [ms]); return n }

function Row({ t, now, at }) {
  // Countdown = server-computed remaining time minus the time since that answer arrived. It is recomputed from the server on every
  // poll, so a refresh / reopen never restarts it.
  const left = t.remaining_s == null ? null : Math.max(0, t.remaining_s - (now - at) / 1000)
  if (left !== null && left <= 0) return null
  return (
    <div className="card" style={{ margin: '6px 0' }}>
      <div className="row"><b>{t.name}</b><span className={'badge ' + (t.status === 'succeeded' ? 'good' : t.status === 'failed' ? 'bad' : t.status === 'waiting' ? 'warn' : 'info')}>{t.status === 'succeeded' ? 'Successful' : t.status === 'waiting' ? 'Waiting for you' : t.status === 'failed' ? 'Failed' : 'Running'}</span></div>
      <div className="sub">{t.workflow_title} · {t.agent === 'owner' ? 'You' : t.agent === 'agent1' ? 'Agent 1' : 'Agent 2'} · {fmtDur(t.duration_ms != null && (t.status === 'running' || t.status === 'waiting') ? t.duration_ms + (now - at) : t.duration_ms)}{left !== null ? ' · visible for ' + fmtLeft(left) : ''}</div>
      {t.status === 'failed' && t.error && <div className="sub" style={{ color: 'var(--bad)' }}>{t.error}</div>}
    </div>
  )
}

export function Monitor({ call, onOpenWorkflow, go }) {
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState('')
  const stamp = useRef(Date.now())
  const { data, error, reload } = usePoll(async () => { const r = await call('monitor'); stamp.current = Date.now(); return r }, [], 5000)
  const { data: health, error: hErr } = usePoll(() => call('health'), [], 30000)
  const now = useNow()
  const [seen, setSeen] = useState(() => { try { return JSON.parse(localStorage.getItem('orch_seen_failures') || '[]') } catch { return [] } })
  const dismiss = (id) => { const n = [...seen, id].slice(-100); setSeen(n); try { localStorage.setItem('orch_seen_failures', JSON.stringify(n)) } catch { /* per-viewer convenience only */ } }
  async function act(key, action, params) {
    setBusy(key); setErr(''); setNote('')
    try { const r = await call(action, params); if (r && r.next) setNote(r.next) } catch (e) { setErr(e.message) }
    setBusy(''); reload()
  }
  if (!data) return <><Err msg={error} />{!error && <div className="sub">Loading monitor...</div>}</>
  const at = stamp.current
  const pend = data.approvals.pending
  const running = data.tasks.running, okT = data.tasks.recent_succeeded, badT = data.tasks.recent_failed
  const fresh = (data.failures || []).filter(f => !seen.includes(f.event_id))
  const op = data.operational
  return (
    <>
      <Err msg={error} /><Err msg={err} />
      {note && <CodeBlock label="result" tone="info" text={note} />}
      <div className="card" onClick={() => go && go('approvals')} style={{ cursor: go ? 'pointer' : 'default' }}>
        <div className="row"><b>Approvals <PendingDot count={data.approvals.pending_count} /></b><span className={'badge ' + (pend.length ? 'warn' : 'good')}>{pend.length ? pend.length + ' pending' : 'None pending'}</span></div>
        {pend.map(a => <div key={a.id} className="sub">• {a.title}{a.kind ? ' (' + String(a.kind).replace('_', ' ') + ')' : ''}</div>)}
        {pend.length > 0 && <div className="sub">Tap to open the Approvals tab. Nothing is approved automatically.</div>}
      </div>

      {fresh.map(f => (
        <div className="card" key={f.event_id} style={{ borderColor: 'var(--bad)' }}>
          <div className="row"><b>Failed: {f.title}</b><button className="btn" onClick={() => dismiss(f.event_id)}>Dismiss</button></div>
          <div className="sub">{f.agent} / {f.stage}: {f.message}</div>
          <div className="sub">{f.recovery}</div>
        </div>
      ))}

      {data.interrupted.length > 0 && <h2>Interrupted workflows</h2>}
      {data.interrupted.map(i => (
        <div className="card" key={i.workflow_id} style={{ borderColor: 'var(--warn)' }}>
          <div className="row"><b>{i.title}</b><span className="badge warn">{i.uncertain ? 'Result uncertain' : 'Interrupted'}</span></div>
          <div className="sub">{i.summary}</div>
          {i.verified && <div className="sub">Last check: {JSON.stringify(i.verified.sql || i.verified.commit)}</div>}
          <div className="actions">
            {i.action !== 'restart' && <button className="btn" disabled={!!busy} onClick={() => act(i.workflow_id, 'resume', { workflow_id: i.workflow_id })}>{busy === i.workflow_id ? 'Checking...' : i.uncertain ? 'Verify state' : 'Resume'}</button>}
            <button className="btn" onClick={() => onOpenWorkflow && onOpenWorkflow(i.workflow_id)}>Open</button>
          </div>
          {(i.uncertain_paths || []).map(pth => (
            <div key={pth} style={{ marginTop: 6 }}>
              <div className="sub">{pth}: after you checked Supabase yourself, tell the system what you saw. Nothing runs automatically.</div>
              <div className="actions">
                <button className="btn" disabled={!!busy} onClick={() => window.confirm('Confirm: you checked Supabase and this migration IS applied?') && act(i.workflow_id + pth, 'resolve_sql', { workflow_id: i.workflow_id, path: pth, outcome: 'applied', ack: 'VERIFIED-IN-SUPABASE' })}>I checked: applied</button>
                <button className="btn no" disabled={!!busy} onClick={() => window.confirm('Confirm: you checked Supabase and this migration is NOT applied? It cannot be re-run; you will upload a corrected migration.') && act(i.workflow_id + pth + 'n', 'resolve_sql', { workflow_id: i.workflow_id, path: pth, outcome: 'not_applied', ack: 'VERIFIED-IN-SUPABASE' })}>I checked: not applied</button>
              </div>
            </div>
          ))}
        </div>
      ))}

      <h2>Running tasks</h2>
      {running.length === 0 ? <div className="sub">Nothing is running.</div> : running.map(t => <Row key={t.workflow_id + t.key} t={t} now={now} at={at} />)}
      <h2>Recently completed <span className="sub">(kept visible {Math.round(data.retention_seconds / 60)} min)</span></h2>
      {okT.length === 0 ? <div className="sub">No recent completions.</div> : okT.map(t => <Row key={t.workflow_id + t.key} t={t} now={now} at={at} />)}
      {badT.length > 0 && <h2>Recently failed</h2>}
      {badT.map(t => <Row key={t.workflow_id + t.key} t={t} now={now} at={at} />)}

      <h2>Health</h2>
      <Err msg={hErr} />
      {health && <div className="card">
        {Object.entries(health.components).map(([k, v]) => (
          <div className="row" key={k} style={{ margin: '3px 0' }}><span className="sub">{NAMES[k] || k}{v.reason ? ' - ' + v.reason : ''}</span><span className={'badge ' + (HCLS[v.state] || 'mute')}>{v.state}</span></div>
        ))}
        <div className="sub" style={{ marginTop: 4 }}>Agent 3: independent - start it yourself when you want QA.</div>
      </div>}
      <div className="sub">Operational: {op.active_workflows} active · {op.failed_workflows} failed · {op.pending_approvals} pending approval(s) · {op.interrupted} interrupted</div>
    </>
  )
}
