import { useState } from 'react'
import { supabase, configured } from './supabaseClient'
import { Err } from './ui.jsx'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setError('')
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    if (error) setError(error.message)
    setBusy(false)
  }

  return (
    <div className="login">
      <h2>Blisscco AI Control Center</h2>
      {!configured && <Err msg="Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY env vars." />}
      <Err msg={error} />
      <form onSubmit={submit}>
        <input type="email" placeholder="Email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required />
        <input type="password" placeholder="Password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required />
        <button className="btn" style={{ width: '100%' }} disabled={busy}>{busy ? 'Signing in...' : 'Sign in'}</button>
      </form>
    </div>
  )
}
