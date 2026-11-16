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

const MAP: Record<string, string> = { health: 'health_report', vercel: 'vercel_status', 'env-audit': 'env_audit', schema: 'supabase_schema', rls: 'rls_check', 'request-env': 'request_env_change', 'apply-env': 'apply_env_change', 'propose-db': 'propose_db_change', 'apply-db': 'apply_db_change', github: 'github_status', 'deploy-logs': 'deploy_logs', 'request-redeploy': 'request_redeploy', 'apply-redeploy': 'apply_redeploy', heartbeat: 'heartbeat' }

async function main() {
  loadDotenv('.env.agent1')
  const [cmd, ...rest0] = process.argv.slice(2)
  const rest = rest0.filter(x => x !== '--json')
  const action = MAP[cmd || '']
  if (!action) { console.log('Usage: npm run agent1 -- <' + Object.keys(MAP).join('|') + '> [--key=value]\nSecret values: --value-env=ENV_NAME (never put values on the command line)'); process.exit(cmd ? 1 : 0) }
  const a: Record<string, string> = {}
  for (const r of rest) { const m = /^--([\w-]+)=(.*)$/.exec(r); if (m) a[m[1]] = m[2] }
  const params: Record<string, unknown> = { ...a }
  if (a.targets) params.targets = a.targets.split(',')
  if (a['value-env']) params.value = process.env[a['value-env']] || ''
  if (a.approval) params.approval_id = a.approval
  if (a['production-ack']) params.production_ack = a['production-ack']
  if (a.ack) params.db_ack = a.ack
  if (a.file) params.sql = readFileSync(a.file, 'utf8')
  delete params['value-env']; delete params.file; delete params.ack
  const ctx = makeCtx(loadConfig(), { type: 'system', id: null })
  const res = await runAction(ctx, action, params)
  const r = res.result || res
  const full = process.argv.includes('--json')
  if (r.ai_summary) console.log('\n' + r.ai_summary + '\n')
  if (r.overall) console.log('Overall: ' + r.overall + '  ' + JSON.stringify(r.counts))
  if (r.issues) for (const i of r.issues) console.log(`[${String(i.severity).toUpperCase()}] ${i.target ? i.target + ': ' : ''}${i.message}`)
  if (Array.isArray(r.projects)) for (const p of r.projects) {
    console.log(`\n${p.name}${p.error ? ' (error: ' + p.error + ')' : ''}`)
    for (const e of p.env || []) console.log(`  ${e.key} [${e.type}] ${(e.targets || []).join(',')}`)
    for (const d of p.deployments || []) console.log(`  deploy ${d.state} ${d.target || ''} ${d.branch || ''} ${d.at}`)
  }
  if (Array.isArray(r.deployments)) for (const d of r.deployments) {
    console.log(`\n${d.project} ${d.deployment_id} ${d.state} ${d.target || ''} ${d.branch || ''}`)
    for (const l of d.log_tail || []) console.log('  ' + l)
  }
  if (Array.isArray(r.repos)) for (const g of r.repos) {
    console.log(`\n${g.repo}${g.found ? '' : ' (not found)'} default=${g.defaultBranch || '-'} pushed=${g.pushedAt || '-'}`)
    for (const c of g.lastCommits || []) console.log(`  commit ${c.sha} ${c.message}`)
    for (const x of g.runs || []) console.log(`  run ${x.name} ${x.status}/${x.conclusion || '-'} ${x.branch}`)
  }
  if (full || !r.overall) console.log(JSON.stringify(res, null, 2))
  else console.log('\ntask_id: ' + res.task_id + '  (add --json for full output)')
}
main().catch(e => { console.error('Agent1 error:', errMsg(e)); process.exit(1) })
