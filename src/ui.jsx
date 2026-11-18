import { useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from './supabaseClient'

export async function q(builder) {
  const { data, error } = await builder
  if (error) throw error
  return data
}

export function usePoll(fn, deps = [], ms = 10000) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const ref = useRef(fn)
  ref.current = fn
  const load = useCallback(async () => {
    try { setData(await ref.current()); setError(null) }
    catch (e) { setError(e.message || String(e)) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => {
    setLoading(true)
    load()
    const t = setInterval(load, ms)
    return () => clearInterval(t)
  }, [load, ms, ...deps])
  return { data, error, loading, reload: load }
}

export function timeAgo(ts) {
  if (!ts) return 'never'
  const s = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000))
  if (s < 60) return s + 's ago'
  if (s < 3600) return Math.floor(s / 60) + 'm ago'
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'
  return Math.floor(s / 86400) + 'd ago'
}

export function effStatus(agent, offlineSec) {
  if (agent.status === 'disabled') return 'disabled'
  if (!agent.last_heartbeat_at) return 'offline'
  const age = (Date.now() - new Date(agent.last_heartbeat_at).getTime()) / 1000
  return age > offlineSec ? 'offline' : agent.status
}

const GOOD = ['succeeded', 'ok', 'idle', 'approved', 'success']
const INFO = ['running', 'queued', 'pending', 'awaiting_approval', 'info']
const BAD = ['failed', 'error', 'down', 'rejected']
const WARN = ['warn', 'degraded']

export function Badge({ s }) {
  const c = GOOD.includes(s) ? 'good' : INFO.includes(s) ? 'info' : BAD.includes(s) ? 'bad' : WARN.includes(s) ? 'warn' : 'mute'
  return <span className={'badge ' + c}>{String(s).replace('_', ' ')}</span>
}

/* ---------- Icons (minimal line icons) ---------- */
const P = {
  copy: <><rect x="9" y="9" width="11" height="11" rx="2.5" /><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  chevron: <path d="M6 9l6 6 6-6" />,
  home: <path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" />,
  bot: <><rect x="4" y="8" width="16" height="11" rx="3" /><path d="M12 4v4M9 13v1.5M15 13v1.5" /></>,
  flow: <><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="12" r="2.5" /><circle cx="6" cy="18" r="2.5" /><path d="M8.5 6H13a3 3 0 0 1 3 3v.5M8.5 18H13a3 3 0 0 0 3-3v-.5" /></>,
  tasks: <><circle cx="12" cy="12" r="8.5" /><path d="M8.5 12.5l2.5 2.5 4.5-5" /></>,
  logs: <><path d="M7 4h10a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" /><path d="M9 9h6M9 13h6M9 17h3" /></>,
  shield: <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />,
  chart: <path d="M5 20V10M12 20V4M19 20v-7" />,
  heart: <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.600-7 10-7 10z" />,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M12 3v2.500M12 18.500V21M3 12h2.500M18.500 12H21M5.600 5.600l1.800 1.800M16.600 16.600l1.800 1.800M5.600 18.400l1.800-1.800M16.600 7.400l1.800-1.800" /></>
}

export function Icon({ n }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{P[n]}</svg>
  )
}

/* ---------- Copy helper ---------- */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true }
  } catch (e) { /* fall through to legacy */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text; ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch (e) { return false }
}

/* ---------- ChatGPT-style code block: label on left, copy icon top-right ---------- */
export function CodeBlock({ text, label = 'output', tone = '', wrap = true }) {
  const [done, setDone] = useState(false)
  const t = useRef(null)
  useEffect(() => () => clearTimeout(t.current), [])
  const body = typeof text === 'string' ? text : JSON.stringify(text, null, 2)
  async function copy() {
    if (await copyText(body)) {
      setDone(true); clearTimeout(t.current); t.current = setTimeout(() => setDone(false), 1800)
    }
  }
  return (
    <div className={'code ' + tone}>
      <div className="code-head">
        <span className="tag"><i />{label}</span>
        <button type="button" className={'copy' + (done ? ' done' : '')} onClick={copy} aria-label="Copy to clipboard">
          <Icon n={done ? 'check' : 'copy'} />{done ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className={wrap ? 'wrap' : ''}>{body}</pre>
    </div>
  )
}

export function Err({ msg }) {
  if (!msg) return null
  const hint = /schema|relation|does not exist|permission/i.test(msg)
    ? '\n\nCheck: ai_control is in Supabase > Settings > API > Exposed schemas, and your user is in ai_control.owners.'
    : ''
  return <CodeBlock label="error" tone="bad" text={msg + hint} />
}

export function Empty({ text }) {
  return <div className="empty">{text}</div>
}

/* iOS-style activity spinner (12 fading blades) */
export function Spinner({ size = 22 }) {
  return (
    <span className="ios-spin" style={{ width: size, height: size }} aria-hidden="true">
      {Array.from({ length: 12 }, (_, i) => <i key={i} style={{ transform: 'rotate(' + i * 30 + 'deg)', animationDelay: -(1.2 - i * 0.1).toFixed(1) + 's' }} />)}
    </span>
  )
}

/* White iPhone-style loading HUD */
export function Loading({ text = 'Loading' }) {
  return (
    <div className="loading-wrap" role="status" aria-live="polite">
      <div className="hud"><Spinner /><span>{text}</span></div>
    </div>
  )
}

/* White shimmer placeholder cards while a list loads */
export function Skeleton({ rows = 3 }) {
  return (
    <div className="skel-list" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skel" key={i} style={{ animationDelay: i * 70 + 'ms' }}><i className="l1" /><i className="l2" /><i className="l3" /></div>
      ))}
    </div>
  )
}

export async function logAction(action, message, { level = 'info', task_id = null, agent_id = null, metadata = {} } = {}) {
  const { data } = await supabase.auth.getSession()
  const uid = data.session && data.session.user ? data.session.user.id : null
  const { error } = await supabase.from('activity_logs').insert({
    actor_type: 'user', actor_id: uid, level, action, message, task_id, agent_id, metadata
  })
  if (error) console.error('log failed:', error.message)
}
