import { readFileSync, existsSync } from 'node:fs'
import { loadConfig } from './config.js'
import { makeCtx, runAction } from './agent.js'
import { errMsg } from './util.js'
import { workOnce } from './worker.js'

// Termux/Android CLI. Secrets come from the environment or an optional .env.agent3 file (git-ignored).
function loadDotenv(path: string) {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '')
  }
}
const MAP: Record<string, string> = {
  heartbeat: 'heartbeat', website: 'website_smoke', auth: 'auth_check', api: 'api_test', db: 'db_test', security: 'security_scan', report: 'full_report',
  worker: 'worker', 'request-rate': 'request_rate_test', 'apply-rate': 'apply_rate_test', retest: 'retest', ask: 'ai_command'
}
async function main() {
  loadDotenv('.env.agent3')
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === 'worker') {
    const cfg = loadConfig(), once = rest.includes('--once')
    console.log('Agent 3 worker on. Dashboard se queued tests yahan chalenge. Band karne ke liye Ctrl+C.')
    for (;;) {
      try { await makeCtx(cfg, { type: 'system', id: null }).store.heartbeat(); const n = await workOnce(cfg, { type: 'system', id: null }, s => console.log(new Date().toLocaleTimeString() + ' ' + s)); if (once) { console.log(n ? 'Done: ' + n + ' task(s).' : 'Queue khali hai.'); break } }
      catch (e) { console.error('worker error:', errMsg(e)); if (once) process.exit(1) }
      await new Promise(r => setTimeout(r, 5000))
    }
    return
  }
  const action = MAP[cmd || '']
  if (!action) {
    console.log('Usage: npm run agent3 -- <' + Object.keys(MAP).join('|') + '> [--key=value]\nExamples:\n  report\n  website --target=https://yoursite.com\n  request-rate --path=/api/serve\n  apply-rate --approval=<id> --production-ack=APPROVE-PRODUCTION\n  retest --task=<task_id>\n  worker [--once]   (dashboard ke queued tests chalata hai)\n  ask "api test karo"')
    process.exit(cmd ? 1 : 0)
  }
  const a: Record<string, string> = {}, words: string[] = []
  for (const r of rest) { const m = /^--([\w-]+)=(.*)$/.exec(r); if (m) a[m[1]] = m[2]; else if (r !== '--json' && r !== '--') words.push(r) }
  const params: Record<string, unknown> = { ...a }
  if (a.approval) params.approval_id = a.approval
  if (a.task) params.task_id = a.task
  if (a['production-ack']) params.production_ack = a['production-ack']
  if (cmd === 'ask') params.text = words.join(' ')
  const ctx = makeCtx(loadConfig(), { type: 'system', id: null })
  const res = await runAction(ctx, action, params)
  const r = res.result || res
  if (r.verdict) {
    console.log(`\n${String(r.title || '').toUpperCase()}  ->  ${String(r.verdict).toUpperCase()}   (${r.tests_passed}/${r.tests_run} checks ok)`)
    const c = r.counts || {}; console.log(`critical ${c.critical} | high ${c.high} | medium ${c.medium} | low ${c.low} | info ${c.info}`)
    for (const e of r.evidence || []) console.log(`[${e.ok ? 'PASS' : 'FAIL'}] ${e.check} - ${e.detail}`)
    for (const f of r.findings || []) console.log(`\n[${f.severity.toUpperCase()}] ${f.title}${f.target ? ' @ ' + f.target : ''}\n  evidence: ${f.evidence}\n  fix: ${f.fix}`)
    if (r.ai_summary) console.log('\nAI summary:\n' + r.ai_summary)
    if (r.retest) console.log('\nRetest: fixed ' + r.retest.fixed.length + ', still failing ' + r.retest.still_failing.length + ', new ' + r.retest.new_findings.length)
  }
  if (r.next) console.log('\nNext: ' + r.next)
  if (process.argv.includes('--json')) console.log(JSON.stringify(res, null, 2))
  else console.log('\ntask_id: ' + res.task_id + (res.status ? '  status: ' + res.status : '') + '  (add --json for full output)')
}
main().catch(e => { console.error('Agent3 error:', errMsg(e)); process.exit(1) })
