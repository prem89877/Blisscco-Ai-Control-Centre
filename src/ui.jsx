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

export function Err({ msg }) {
  if (!msg) return null
  const hint = /schema|relation|does not exist|permission/i.test(msg)
    ? ' (Check: ai_control is in Supabase > Settings > API > Exposed schemas, and your user is in ai_control.owners.)'
    : ''
  return <div className="err">{msg}{hint}</div>
}

export function Empty({ text }) {
  return <div className="empty">{text}</div>
}

export function Loading() {
  return <div className="empty">Loading...</div>
}

export async function logAction(action, message, { level = 'info', task_id = null, agent_id = null, metadata = {} } = {}) {
  const { data } = await supabase.auth.getSession()
  const uid = data.session && data.session.user ? data.session.user.id : null
  const { error } = await supabase.from('activity_logs').insert({
    actor_type: 'user', actor_id: uid, level, action, message, task_id, agent_id, metadata
  })
  if (error) console.error('log failed:', error.message)
}
