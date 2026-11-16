import { readFileSync, existsSync } from 'node:fs'
import { loadConfig } from './config.js'
import { makeCtx, runAction } from './agent.js'
import { errMsg } from './util.js'

// Termux/Android CLI. Secrets come from the environment or an optional .env.agent1 file (git-ignored).
function loadDotenv(path: string) {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '')
  }
}

const MAP: Record<string, string> = { health: 'health_report', vercel: 'vercel_status', 'env-audit': 'env_audit', schema: 'supabase_schema', rls: 'rls_check', 'request-env': 'request_env_change', 'apply-env': 'apply_env_change', 'propose-db': 'propose_db_change', heartbeat: 'heartbeat' }

async function main() {
  loadDotenv('.env.agent1')
  const [cmd, ...rest] = process.argv.slice(2)
  const action = MAP[cmd || '']
  if (!action) { console.log('Usage: npm run agent1 -- <' + Object.keys(MAP).join('|') + '> [--key=value]\nSecret values: --value-env=ENV_NAME (never put values on the command line)'); process.exit(cmd ? 1 : 0) }
  const a: Record<string, string> = {}
  for (const r of rest) { const m = /^--([\w-]+)=(.*)$/.exec(r); if (m) a[m[1]] = m[2] }
  const params: Record<string, unknown> = { ...a }
  if (a.targets) params.targets = a.targets.split(',')
  if (a['value-env']) params.value = process.env[a['value-env']] || ''
  if (a.approval) params.approval_id = a.approval
  if (a['production-ack']) params.production_ack = a['production-ack']
  if (a.file) params.sql = readFileSync(a.file, 'utf8')
  delete params['value-env']; delete params.file
  const ctx = makeCtx(loadConfig(), { type: 'system', id: null })
  const res = await runAction(ctx, action, params)
  const r = res.result || res
  if (r.ai_summary) console.log('\n' + r.ai_summary + '\n')
  if (r.issues) for (const i of r.issues) console.log(`[${i.severity.toUpperCase()}] ${i.target ? i.target + ': ' : ''}${i.message}`)
  console.log(JSON.stringify(res, null, 2).slice(0, 6000))
}
main().catch(e => { console.error('Agent1 error:', errMsg(e)); process.exit(1) })
