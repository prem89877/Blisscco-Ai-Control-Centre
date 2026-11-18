import { useEffect, useState, useCallback, useRef } from 'react'
import { supabase, configured } from './supabaseClient'
import Login from './Login.jsx'
import Overview from './Overview.jsx'
import Agents from './Agents.jsx'
import Tasks from './Tasks.jsx'
import Logs from './Logs.jsx'
import Approvals from './Approvals.jsx'
import ApiUsage from './ApiUsage.jsx'
import Health from './Health.jsx'
import Settings from './Settings.jsx'
import Orchestrator from './Orchestrator.jsx'
import { useAgent1Heartbeat } from './Agent1.jsx'
import { useAgent2Heartbeat } from './Agent2.jsx'
import { useAgent3Heartbeat } from './Agent3.jsx'
import { Icon, Loading } from './ui.jsx'
import { usePendingApprovals, PendingDot } from './Monitor.jsx'

const TABS = [
  ['overview', 'home', 'Overview'],
  ['agents', 'bot', 'Agents'],
  ['orchestrator', 'flow', 'Orchestrator'],
  ['tasks', 'tasks', 'Tasks'],
  ['logs', 'logs', 'Logs'],
  ['approvals', 'shield', 'Approvals'],
  ['usage', 'chart', 'API Usage'],
  ['health', 'heart', 'Health'],
  ['settings', 'gear', 'Settings']
]

// The open tab lives in the URL hash (#approvals), so a refresh, the back button or a shared
// link returns to the same page. An unknown hash (for example a Supabase login token) is ignored.
const TAB_IDS = TABS.map(t => t[0])
function tabFromHash() {
  let raw = ''
  try { raw = decodeURIComponent((window.location.hash || '').replace(/^#\/?/, '')) } catch { /* bad hash: ignore */ }
  if (raw.startsWith('wf=')) return 'orchestrator' // older workflow links
  const id = raw.split(/[/&?]/)[0] // "#orchestrator&wf=<id>" still means the Orchestrator tab
  return TAB_IDS.includes(id) ? id : 'overview'
}

// Scroll position survives a refresh too: the page scrolls inside .main (not the window), so the browser cannot restore it.
const SCROLL_KEY = 'blisscco_scroll'
const readScroll = () => { try { return JSON.parse(sessionStorage.getItem(SCROLL_KEY) || 'null') } catch { return null } }
const writeScroll = (tab, y) => { try { sessionStorage.setItem(SCROLL_KEY, JSON.stringify({ tab, y: Math.max(0, Math.round(y)) })) } catch { /* private mode: skip */ } }

export default function App() {
  const [session, setSession] = useState(undefined)
  const [owner, setOwner] = useState(null) // null=checking, false=denied, object=ok
  const [tab, setTabState] = useState(tabFromHash)
  const [offlineSec, setOfflineSec] = useState(120)
  const mainRef = useRef(null)
  const restored = useRef(false) // true once the saved position was applied (or there was none): only then do we save
  const lastSave = useRef(0)

  const setTab = useCallback(id => {
    if (!TAB_IDS.includes(id)) return
    setTabState(id)
    if (window.location.hash !== '#' + id) window.history.pushState(null, '', '#' + id)
  }, [])

  useEffect(() => {
    const onNav = () => setTabState(tabFromHash())
    window.addEventListener('popstate', onNav)
    window.addEventListener('hashchange', onNav)
    return () => { window.removeEventListener('popstate', onNav); window.removeEventListener('hashchange', onNav) }
  }, [])

  // Restore the saved scroll position once, after the tab's content has loaded (it grows while data arrives, so retry briefly).
  useEffect(() => {
    if (!owner || restored.current) return
    const saved = readScroll()
    if (!saved || saved.tab !== tab || !(saved.y > 0)) { restored.current = true; return }
    let stop = false, tries = 0
    const cancel = () => { stop = true; restored.current = true }
    const el0 = mainRef.current
    if (el0) { el0.addEventListener('touchstart', cancel, { once: true, passive: true }); el0.addEventListener('wheel', cancel, { once: true, passive: true }) }
    const attempt = () => {
      if (stop) return
      const el = mainRef.current
      if (el) {
        el.scrollTop = saved.y
        if (Math.abs(el.scrollTop - saved.y) < 2) { restored.current = true; return }
      }
      if (++tries < 14) setTimeout(attempt, 250); else restored.current = true
    }
    attempt()
    return () => { stop = true }
  }, [owner]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const save = () => { if (restored.current && mainRef.current) writeScroll(tab, mainRef.current.scrollTop) }
    const onHide = () => { if (document.visibilityState === 'hidden') save() }
    window.addEventListener('pagehide', save)
    document.addEventListener('visibilitychange', onHide)
    return () => { window.removeEventListener('pagehide', save); document.removeEventListener('visibilitychange', onHide) }
  }, [tab])

  useEffect(() => {
    if (!configured) { setSession(null); return }
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  const loadSettings = useCallback(async () => {
    const { data } = await supabase.from('settings').select('value').eq('key', 'agent_offline_after_sec').maybeSingle()
    const n = data && data.value && Number(data.value.seconds)
    if (n > 0) setOfflineSec(n)
  }, [])

  useEffect(() => {
    if (!session) { setOwner(null); return }
    supabase.from('owners').select('user_id,role').maybeSingle().then(({ data }) => {
      if (data && ['owner', 'admin'].includes(data.role)) { setOwner(data); loadSettings() }
      else setOwner(false)
    })
  }, [session, loadSettings])

  const pending = usePendingApprovals(Boolean(owner))
  useAgent1Heartbeat(Boolean(owner))
  useAgent2Heartbeat(Boolean(owner))
  useAgent3Heartbeat(Boolean(owner))

  if (session === undefined) return <Loading />
  if (!session) return <Login />
  if (owner === null) return <Loading text="Checking access" />
  if (owner === false) {
    return (
      <div className="login">
        <h2>Access denied</h2>
        <p className="sub">This account is not authorized for AI Control Center.</p>
        <button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>
    )
  }

  const page = {
    overview: <Overview offlineSec={offlineSec} go={setTab} />,
    agents: <Agents offlineSec={offlineSec} />,
    orchestrator: <Orchestrator go={setTab} />,
    tasks: <Tasks />,
    logs: <Logs />,
    approvals: <Approvals />,
    usage: <ApiUsage />,
    health: <Health />,
    settings: <Settings session={session} owner={owner} offlineSec={offlineSec} onSaved={loadSettings} />
  }[tab]

  return (
    <div className="app">
      <div className="top"><span>Blisscco AI</span><span className="sub">{TABS.find(t => t[0] === tab)[2]}</span></div>
      <div className="main" ref={mainRef} onScroll={e => { const t = Date.now(); if (restored.current && t - lastSave.current > 150) { lastSave.current = t; writeScroll(tab, e.currentTarget.scrollTop) } }}><div key={tab} className="page-in">{page}</div></div>
      <div className="nav">
        {TABS.map(([id, icon, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            <Icon n={icon} />{label}{id === 'approvals' && <PendingDot count={pending.count} />}
          </button>
        ))}
      </div>
    </div>
  )
}
