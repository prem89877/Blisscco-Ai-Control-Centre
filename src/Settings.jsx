import { useState } from 'react'
import { supabase } from './supabaseClient'
import { Err, logAction } from './ui.jsx'

export default function Settings({ session, owner, offlineSec, onSaved }) {
  const [sec, setSec] = useState(offlineSec)
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')

  async function save() {
    setErr(''); setOk('')
    const n = Math.round(Number(sec))
    if (!(n >= 30 && n <= 3600)) { setErr('Enter 30 to 3600 seconds'); return }
    const uid = session.user.id
    const { data: ex } = await supabase.from('settings').select('key').eq('key', 'agent_offline_after_sec').maybeSingle()
    const res = ex
      ? await supabase.from('settings').update({ value: { seconds: n }, updated_by: uid, updated_at: new Date().toISOString() }).eq('key', 'agent_offline_after_sec')
      : await supabase.from('settings').insert({ key: 'agent_offline_after_sec', value: { seconds: n }, updated_by: uid })
    if (res.error) { setErr(res.error.message); return }
    await logAction('setting_changed', 'agent_offline_after_sec = ' + n)
    setOk('Saved'); onSaved()
  }

  return (
    <>
      <div className="card">
        <b>Account</b>
        <div className="sub">{session.user.email}</div>
        <div className="sub">Role: {owner.role}</div>
        <button className="btn ghost" style={{ marginTop: 8 }} onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>
      <div className="card">
        <b>Agent offline timeout (seconds)</b>
        <input type="number" value={sec} onChange={e => setSec(e.target.value)} style={{ marginTop: 8 }} />
        <Err msg={err} />
        {ok && <div className="msg">{ok}</div>}
        <button className="btn" onClick={save}>Save</button>
      </div>
    </>
  )
}
