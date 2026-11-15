import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !svc) return res.status(500).json({ error: 'Server not configured' })

  const token = (req.headers.authorization || '').replace(/^Bearer /, '')
  if (!token) return res.status(401).json({ error: 'Unauthorized' })

  const admin = createClient(url, svc, { auth: { persistSession: false }, db: { schema: 'ai_control' } })

  const a0 = Date.now()
  const { data: u, error: uErr } = await admin.auth.getUser(token)
  const authMs = Date.now() - a0
  if (uErr || !u || !u.user) return res.status(401).json({ error: 'Unauthorized' })

  const { data: own } = await admin.from('owners').select('role')
    .eq('user_id', u.user.id).in('role', ['owner', 'admin']).maybeSingle()
  if (!own) return res.status(403).json({ error: 'Forbidden' })

  const d0 = Date.now()
  const { error: dbErr } = await admin.from('agents').select('id', { head: true, count: 'exact' })
  const dbMs = Date.now() - d0

  const rows = [
    { component: 'database', status: dbErr ? 'down' : dbMs > 1500 ? 'degraded' : 'ok', latency_ms: dbMs, details: dbErr ? { error: dbErr.message } : {} },
    { component: 'auth', status: authMs > 1500 ? 'degraded' : 'ok', latency_ms: authMs, details: {} },
    { component: 'vercel_api', status: 'ok', latency_ms: 0, details: {} }
  ]
  await admin.from('system_health').insert(rows)
  await admin.from('activity_logs').insert({
    actor_type: 'system', level: rows.some(r => r.status !== 'ok') ? 'warn' : 'success',
    action: 'health_check', message: 'Server health check run', metadata: { by: u.user.id }
  })
  return res.status(200).json({ ok: true, rows })
}
