import { useEffect, useState, useCallback } from 'react'
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
import { useAgent1Heartbeat } from './Agent1.jsx'
import { Icon } from './ui.jsx'

const TABS = [
  ['overview', 'home', 'Overview'],
  ['agents', 'bot', 'Agents'],
  ['tasks', 'tasks', 'Tasks'],
  ['logs', 'logs', 'Logs'],
  ['approvals', 'shield', 'Approvals'],
  ['usage', 'chart', 'API Usage'],
  ['health', 'heart', 'Health'],
  ['settings', 'gear', 'Settings']
]

export default function App() {
  const [session, setSession] = useState(undefined)
  const [owner, setOwner] = useState(null) // null=checking, false=denied, object=ok
  const [tab, setTab] = useState('overview')
  const [offlineSec, setOfflineSec] = useState(120)

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

  useAgent1Heartbeat(Boolean(owner))

  if (session === undefined) return <div className="empty">Loading...</div>
  if (!session) return <Login />
  if (owner === null) return <div className="empty">Checking access...</div>
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
      <div className="main">{page}</div>
      <div className="nav">
        {TABS.map(([id, icon, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            <Icon n={icon} />{label}
          </button>
        ))}
      </div>
    </div>
  )
}
