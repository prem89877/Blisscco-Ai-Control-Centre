import { readFileSync, existsSync } from 'node:fs'
import { loadConfig } from './config.js'
import { makeCtx, runAction } from './agent.js'
import { runLocal } from './local.js'
import { errMsg } from './util.js'

// Termux/Android CLI. Secrets come from the environment or an optional .env.agent2 file (git-ignored).
function loadDotenv(path: string) {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '')
  }
}

// cli command -> [scope, action]
const MAP: Record<string, ['local' | 'remote', string]> = {
  'local-inspect': ['local', 'local_inspect'], 'local-apply': ['local', 'local_apply'], checks: ['local', 'local_checks'],
  exec: ['local', 'exec'], 'apply-command': ['local', 'apply_command'], commit: ['local', 'local_commit'],
  'request-push': ['local', 'request_push'], 'apply-push': ['local', 'apply_push'], 'local-rollback': ['local', 'local_rollback'],
  heartbeat: ['remote', 'heartbeat'], 'repo-inspect': ['remote', 'repo_inspect'], monitor: ['remote', 'actions_status'],
  propose: ['remote', 'propose_change'], fix: ['remote', 'ai_fix'], 'apply-change': ['remote', 'apply_change'],
  'request-promote': ['remote', 'request_promote'], 'apply-promote': ['remote', 'apply_promote'],
  'request-rollback': ['remote', 'request_rollback'], 'apply-rollback': ['remote', 'apply_rollback']
}

async function main() {
  loadDotenv('.env.agent2')
  const [cmd, ...rest] = process.argv.slice(2)
  const entry = MAP[cmd || '']
  if (!entry) {
    console.log('Usage: npm run agent2 -- <' + Object.keys(MAP).join('|') + '> [--key=value]\nExamples:\n  local-apply --file=change.json\n  checks\n  commit --message="Fix login"\n  request-push\n  apply-push --approval=<id>\n  exec git status')
    process.exit(cmd ? 1 : 0)
  }
  const a: Record<string, string> = {}
  const words: string[] = []
  for (const r of rest) { const m = /^--([\w-]+)=(.*)$/.exec(r); if (m) a[m[1]] = m[2]; else if (r !== '--json' && r !== '--') words.push(r) }
  const params: Record<string, unknown> = { ...a }
  if (a.approval) params.approval_id = a.approval
  if (a['production-ack']) params.production_ack = a['production-ack']
  if (a['sensitive-ack']) params.sensitive_ack = a['sensitive-ack']
  if (a.paths) params.paths = a.paths.split(',').map(s => s.trim())
  if (a.file) {
    const j = JSON.parse(readFileSync(a.file, 'utf8'))
    if (entry[1] === 'propose_change') Object.assign(params, j)
    else params.changes = j
    delete params.file
  }
  if (cmd === 'exec') params.command = words.join(' ')
  const ctx = makeCtx(loadConfig(), { type: 'system', id: null })
  const res = entry[0] === 'local' ? await runLocal(ctx, entry[1], params) : await runAction(ctx, entry[1], params)
  const r = res.result || res
  if (r.ai_review) console.log('\nAI review:\n' + r.ai_review + '\n')
  if (r.diffstat || r.stat) console.log(r.diffstat || r.stat)
  if (Array.isArray(r.checks)) for (const c of r.checks) console.log(`[${c.ok ? 'PASS' : 'FAIL'}] ${c.name} (${c.ms}ms)${c.ok ? '' : '\n' + c.tail}`)
  if (r.output) console.log(r.output)
  if (r.next) console.log('\nNext: ' + r.next)
  if (process.argv.includes('--json')) console.log(JSON.stringify(res, null, 2))
  else console.log('\ntask_id: ' + res.task_id + (res.status ? '  status: ' + res.status : '') + '  (add --json for full output)')
}
main().catch(e => { console.error('Agent2 error:', errMsg(e)); process.exit(1) })
