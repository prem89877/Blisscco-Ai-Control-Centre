// Termux-only checks. This file is imported by the dashboard API too (for parseCommand validation),
// but nothing here runs a process unless the worker/CLI calls runLocal / runOne.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { AgentError } from './util.js'
import { maskSecrets } from './guard.js'
import * as C from './checks.js'
import type { Finding } from './checks.js'

export interface RunRes { code: number; out: string; ms: number; timedOut: boolean }
export type ExecFn = (bin: string, args: string[], o: { cwd: string; timeoutMs: number }) => Promise<RunRes>
export interface Ev { check: string; ok: boolean; detail: string }
export interface CmdRes { cmd: string; code: number; ms: number; output: string }

// ---------------------------------------------------------------- real executor (no shell, minimal env: no secrets reach children)
const OUT_CAP = 400_000
export const realExec: ExecFn = (bin, args, o) => new Promise(res => {
  const t0 = Date.now()
  let out = '', timedOut = false
  const env: Record<string, string> = { CI: '1', NO_COLOR: '1' }
  for (const k of ['PATH', 'HOME', 'TERM', 'LANG', 'TMPDIR', 'PREFIX', 'TZ']) if (process.env[k]) env[k] = process.env[k] as string
  const ch = spawn(bin, args, { cwd: o.cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
  const add = (b: Buffer) => { if (out.length < OUT_CAP) out += b.toString('utf8') }
  ch.stdout.on('data', add); ch.stderr.on('data', add)
  const timer = setTimeout(() => { timedOut = true; ch.kill('SIGKILL') }, o.timeoutMs)
  ch.on('error', e => { clearTimeout(timer); res({ code: 127, out: out + String(e.message), ms: Date.now() - t0, timedOut }) })
  ch.on('close', code => { clearTimeout(timer); res({ code: code ?? 1, out, ms: Date.now() - t0, timedOut }) })
})

export function ensureProject(root: string) {
  if (!existsSync(join(root, 'package.json')) || !existsSync(join(root, 'agent3'))) throw new AgentError('Run this from the project folder (the one that has package.json and agent3/).', 400, 'bad_cwd')
}

// ---------------------------------------------------------------- custom command guard (allow-list, no shell syntax, no secrets files)
export const ALLOWED_HELP = 'ls, cat, head, tail, wc, grep, find, du, df, pwd, date, uname, node -v, npm (test | run build | audit | ls | outdated | -v), git (status | log | diff --stat | branch | ls-files | show --stat)'
const BAD_CHARS = /[;&|<>`$(){}\\\n\r\0'~]/
const SENSITIVE = /(^|\/)\.env|\.pem$|\.key$|id_rsa|id_ed25519|\.ssh|\.git(\/|$)|\.npmrc|\.netrc|credential|secret|\.agent[123]/i
const bad = (m: string) => new AgentError('Command not allowed: ' + m + '. Allowed: ' + ALLOWED_HELP, 400, 'command_blocked')

export function relPath(p: string): string {
  if (!p || p.length > 200 || p.startsWith('/') || p.startsWith('-') || p.includes('..') || /\s/.test(p)) throw bad('bad path "' + p.slice(0, 40) + '" (only relative paths inside the project)')
  if (SENSITIVE.test(p)) throw bad('"' + p.slice(0, 40) + '" is a protected file')
  return p
}
const digits = (s: string | undefined, max: number) => { if (!s || !/^\d{1,4}$/.test(s) || Number(s) > max || Number(s) < 1) throw bad('number out of range'); return s }
const flagsIn = (flags: string[], ok: string[]) => { for (const f of flags) if (!ok.includes(f)) throw bad('flag ' + f) }

export interface Parsed { bin: string; args: string[]; display: string }
export function parseCommand(cmd: unknown): Parsed {
  if (typeof cmd !== 'string') throw bad('empty')
  const s = cmd.trim()
  if (!s || s.length > 300) throw bad('empty or too long')
  if (BAD_CHARS.test(s)) throw bad('shell characters (; & | < > ` $ ( ) { } \\ \' ~) are not allowed')
  if ((s.match(/"/g) || []).length % 2) throw bad('unbalanced quote')
  const tok = [...s.matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] !== undefined ? m[1] : m[2])
  const [name, ...a] = tok
  const flags = a.filter(x => x.startsWith('-')), pos = a.filter(x => !x.startsWith('-'))
  const out = (bin: string, args: string[]): Parsed => ({ bin, args, display: s })
  switch (name) {
    case 'pwd': case 'date': if (a.length) throw bad(name + ' takes no arguments'); return out(name, [])
    case 'uname': flagsIn(flags, ['-a', '-m', '-s', '-r']); if (pos.length) throw bad('uname arguments'); return out('uname', a)
    case 'df': flagsIn(flags, ['-h']); if (pos.length) throw bad('df arguments'); return out('df', a)
    case 'du': flagsIn(flags, ['-s', '-h', '-sh', '-hs']); return out('du', [...flags, ...(pos.length ? pos.map(relPath) : ['.'])])
    case 'ls': flagsIn(flags, ['-a', '-l', '-la', '-al', '-h', '-lh', '-lah', '-1', '-R']); return out('ls', [...flags, ...pos.map(relPath)])
    case 'cat': if (flags.length || !pos.length) throw bad('cat needs file paths only'); return out('cat', pos.map(relPath))
    case 'wc': flagsIn(flags, ['-l', '-w', '-c']); if (!pos.length) throw bad('wc needs files'); return out('wc', [...flags, ...pos.map(relPath)])
    case 'head': case 'tail': {
      if (a[0] === '-n') { const n = digits(a[1], 500); const files = a.slice(2); if (!files.length || files.some(f => f.startsWith('-'))) throw bad(name + ' needs files'); return out(name, ['-n', n, ...files.map(relPath)]) }
      if (!pos.length || flags.length) throw bad(name + ' usage: ' + name + ' -n 20 file'); return out(name, pos.map(relPath))
    }
    case 'grep': {
      for (const f of flags) if (!/^-[rnilcEwFH]{1,6}$/.test(f)) throw bad('grep flag ' + f)
      const [pat, ...paths] = pos
      if (!pat || pat.length > 100) throw bad('grep needs a pattern (max 100 chars)')
      if (!paths.length) throw bad('grep needs a path, e.g. grep -rn TODO src')
      return out('grep', [...flags, '--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=dist', '--exclude=.env*', '--exclude=*.pem', '--exclude=*.key', '-e', pat, '--', ...paths.map(relPath)])
    }
    case 'find': {
      const paths: string[] = []; let i = 0
      while (i < a.length && !a[i].startsWith('-')) paths.push(relPath(a[i++]))
      if (!paths.length) paths.push('.')
      const ex: string[] = []
      while (i < a.length) {
        const f = a[i++], v = a[i++]
        if (v === undefined) throw bad('find ' + f + ' needs a value')
        if (f === '-name' || f === '-iname') { if (v.includes('/') || v.length > 80) throw bad('bad name pattern'); ex.push(f, v) }
        else if (f === '-type') { if (!['f', 'd'].includes(v)) throw bad('find -type f|d'); ex.push(f, v) }
        else if (f === '-maxdepth' || f === '-mindepth') { if (!/^[0-6]$/.test(v)) throw bad(f + ' 0-6'); ex.push(f, v) }
        else if (f === '-size') { if (!/^[+-]?\d{1,6}[kMc]$/.test(v)) throw bad('find -size'); ex.push(f, v) }
        else throw bad('find option ' + f)
      }
      return out('find', [...paths, '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*', '-not', '-name', '.env*', ...ex])
    }
    case 'node': if (a.length === 1 && ['-v', '--version'].includes(a[0])) return out('node', a); throw bad('only node -v')
    case 'npm': {
      const k = a.join(' ')
      if (['-v', 'test', 'run test', 'run build', 'outdated', 'ls', 'audit'].includes(k)) return out('npm', a)
      if (a[0] === 'audit') { flagsIn(a.slice(1), ['--omit=dev', '--json']); return out('npm', a) }
      if (a[0] === 'ls') { flagsIn(a.slice(1), ['--depth=0', '--omit=dev']); return out('npm', a) }
      throw bad('npm ' + k.slice(0, 30))
    }
    case 'git': {
      const sub = a[0], rest = a.slice(1)
      if (sub === 'status') { flagsIn(rest, ['-s', '--short', '-sb', '-b', '--branch']); return out('git', ['--no-pager', ...a]) }
      if (sub === 'log') {
        const r = [...rest]; const o: string[] = []
        while (r.length) { const x = r.shift()!; if (x === '--oneline') o.push(x); else if (x === '-n') o.push('-n', digits(r.shift(), 50)); else throw bad('git log option ' + x) }
        return out('git', ['--no-pager', 'log', ...(o.includes('-n') ? o : [...o, '-n', '20'])])
      }
      if (sub === 'diff') { if (rest.length !== 1 || !['--stat', '--name-only', '--name-status'].includes(rest[0])) throw bad('git diff --stat | --name-only | --name-status'); return out('git', ['--no-pager', ...a]) }
      if (sub === 'branch') { flagsIn(rest, ['-a', '-v', '-vv', '--show-current']); if (rest.some(x => !x.startsWith('-'))) throw bad('git branch'); return out('git', ['--no-pager', ...a]) }
      if (sub === 'ls-files') { if (rest.length) throw bad('git ls-files takes no arguments'); return out('git', ['--no-pager', 'ls-files']) }
      if (sub === 'show') { flagsIn(rest.filter(x => x !== 'HEAD'), ['--stat', '--oneline']); if (rest.some(x => x !== 'HEAD' && !x.startsWith('-'))) throw bad('git show HEAD --stat'); return out('git', ['--no-pager', ...a]) }
      throw bad('git ' + String(sub).slice(0, 20))
    }
    default: throw bad(String(name).slice(0, 30))
  }
}

export function tailOut(s: string, lines = 40, chars = 3500): string {
  return maskSecrets(s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trimEnd().split('\n').slice(-lines).join('\n')).slice(-chars)
}
export async function runOne(p: Parsed, exec: ExecFn, root: string, timeoutMs = 60_000): Promise<CmdRes & { timedOut: boolean; raw: string }> {
  const r = await exec(p.bin, p.args, { cwd: root, timeoutMs })
  return { cmd: p.display, code: r.code, ms: r.ms, output: tailOut(r.out) + (r.timedOut ? '\n[stopped: time limit]' : ''), timedOut: r.timedOut, raw: r.out }
}

// ---------------------------------------------------------------- analyzers (pure)
const F = (severity: Finding['severity'], id: string, title: string, evidence: string, fix: string, target?: string): Finding => ({ id, area: 'local', severity, title, evidence, fix, target })

export function analyzeTests(code: number, out: string, timedOut = false): Finding[] {
  const pass = Number((/^# pass (\d+)/m.exec(out) || [])[1] || 0), fail = Number((/^# fail (\d+)/m.exec(out) || [])[1] || 0)
  if (code === 0 && fail === 0) return []
  const names = [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].slice(0, 5).map(m => m[1].slice(0, 80))
  return [F('high', 'local.tests_failed', timedOut ? 'Tests timed out' : 'Project tests failed', `exit ${code}, pass ${pass}, fail ${fail}${names.length ? ': ' + names.join(' | ') : ''}`, 'Open the output below, fix the failing test or the code, then retest.', 'npm test')]
}
export function analyzeBuild(code: number, out: string, timedOut = false): Finding[] {
  if (code === 0) return []
  const line = (out.split('\n').find(l => /error/i.test(l)) || out.trim().split('\n').pop() || '').trim().slice(0, 200)
  return [F('high', 'local.build_failed', timedOut ? 'Build timed out' : 'Build failed', `exit ${code}: ${maskSecrets(line)}`, 'Fix the first error line, then rebuild. Vercel will fail the same way.', 'npm run build')]
}
export function analyzeAudit(out: string): Finding[] {
  let v: Record<string, number> | null = null
  try { v = JSON.parse(out).metadata.vulnerabilities } catch { /* unreadable */ }
  if (!v) return [F('info', 'local.audit_unreadable', 'npm audit gave no readable result', 'needs internet or npm registry was unreachable', 'Retry on Wi-Fi/data.', 'npm audit')]
  const map: [string, Finding['severity']][] = [['critical', 'critical'], ['high', 'high'], ['moderate', 'medium'], ['low', 'low']]
  return map.filter(([k]) => (v![k] || 0) > 0).map(([k, sev]) => F(sev, 'local.audit_' + k, `${v![k]} ${k} dependency vulnerabilit${v![k] === 1 ? 'y' : 'ies'}`, 'npm audit metadata', 'Run npm audit fix (or upgrade the named package). Avoid --force unless you retest.', 'npm audit'))
}
export function analyzeGit(statusCode: number, status: string, ignoreCode: number): Finding[] {
  if (statusCode !== 0) return [F('info', 'local.not_git', 'Folder is not a git repository', status.trim().slice(0, 120), 'Ignore if you only use this folder to run tests.')]
  const out: Finding[] = []
  if (ignoreCode === 1) out.push(F('critical', 'local.env_not_ignored', '.env.agent3 is NOT git-ignored', 'git check-ignore says the file would be committed', 'Add ".env.*" to .gitignore before any commit; rotate keys if it was ever pushed.', '.gitignore'))
  const lines = status.split('\n').filter(l => /^[ MADRCU?!]{2} /.test(l))
  for (const l of lines) { const p = l.slice(3).trim(); if (/(^|\/)\.env(?!\.example)/.test(p)) out.push(F('critical', 'local.env_untracked', 'An .env file is about to be committed', p, 'git restore --staged it and add it to .gitignore.', p)) }
  const ab = /\[(ahead|behind)[^\]]*\]/.exec(status.split('\n')[0] || '')
  if (lines.length) out.push(F('info', 'local.dirty', `${lines.length} changed/untracked file(s) not committed`, lines.slice(0, 5).map(l => l.trim()).join(' | '), 'Commit or discard before deploying.'))
  if (ab) out.push(F('info', 'local.git_sync', 'Branch is out of sync with remote', ab[0], 'git pull / git push as needed.'))
  return out
}
export const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'VITE_SUPABASE_ANON_KEY', 'AGENT3_GEMINI_API_KEY', 'AGENT3_TARGETS', 'AGENT3_API_ENDPOINTS', 'AGENT3_SUPABASE_ACCESS_TOKEN', 'AGENT3_GITHUB_TOKEN', 'AGENT3_GITHUB_REPOS']
export function analyzeEnv(env: Record<string, string | undefined>): { f: Finding[]; ev: Ev[] } {
  const f: Finding[] = [], ev: Ev[] = []
  const have = (k: string) => Boolean(env[k] && String(env[k]).trim())
  const missing = REQUIRED_ENV.filter(k => !have(k) && !(k === 'VITE_SUPABASE_ANON_KEY' && have('SUPABASE_ANON_KEY')))
  ev.push({ check: 'Required variables set (names only)', ok: !missing.length, detail: missing.length ? 'missing: ' + missing.join(', ') : 'all ' + REQUIRED_ENV.length + ' set' })
  for (const k of missing) f.push(F(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].includes(k) ? 'high' : 'low', 'local.env_missing', 'Variable not set in Termux: ' + k, 'worker environment', 'Add it to .env.agent3.', k))
  if (have('AGENT3_API_ENDPOINTS')) { try { const j = JSON.parse(env.AGENT3_API_ENDPOINTS as string); if (!Array.isArray(j)) throw new Error('not a list'); ev.push({ check: 'AGENT3_API_ENDPOINTS is valid JSON', ok: true, detail: j.length + ' endpoint(s)' }) } catch { ev.push({ check: 'AGENT3_API_ENDPOINTS is valid JSON', ok: false, detail: 'cannot parse' }); f.push(F('medium', 'local.env_json', 'AGENT3_API_ENDPOINTS is not valid JSON', 'parse failed', 'Paste it again as one line, e.g. [{"name":"x","path":"/api/x","method":"GET","auth":"none"}].', 'AGENT3_API_ENDPOINTS')) } }
  if (have('AGENT3_TARGETS') && !String(env.AGENT3_TARGETS).split(',').every(t => /^https:\/\/[^/\s]+$/.test(t.trim()))) f.push(F('medium', 'local.env_targets', 'AGENT3_TARGETS has an entry that is not a plain https origin', 'format', 'Use https://yoursite.com (no path, no trailing slash).', 'AGENT3_TARGETS'))
  return { f, ev }
}
export function analyzeSystem(nodeOut: string, dfOut: string): { f: Finding[]; ev: Ev[] } {
  const f: Finding[] = [], ev: Ev[] = []
  const major = Number((/v?(\d+)\./.exec(nodeOut) || [])[1] || 0)
  ev.push({ check: 'Node version', ok: major >= 18, detail: nodeOut.trim().slice(0, 30) })
  if (major && major < 18) f.push(F('medium', 'local.node_old', 'Node is older than 18', nodeOut.trim(), 'pkg upgrade nodejs', 'node'))
  const use = [...dfOut.matchAll(/(\d+)%/g)].map(m => Number(m[1])).sort((a, b) => b - a)[0]
  if (use !== undefined && use >= 95) f.push(F('medium', 'local.disk_full', 'Phone storage almost full', use + '% used', 'Free some space.', 'df'))
  return { f, ev }
}
export function analyzeProject(root: string): { f: Finding[]; ev: Ev[] } {
  const f: Finding[] = [], ev: Ev[] = []
  for (const file of ['package.json', 'vercel.json', '.gitignore', 'agent3/agent.ts', 'api/agent3.js', 'src/Agent3.jsx', 'e2e/tests/smoke.spec.ts', '.github/workflows/ci.yml', '.github/workflows/qa.yml']) {
    const ok = existsSync(join(root, file)); ev.push({ check: 'File exists: ' + file, ok, detail: ok ? 'yes' : 'MISSING' })
    if (!ok) f.push(F('medium', 'local.file_missing', 'Project file missing', file, 'Re-extract the latest zip.', file))
  }
  const ok = existsSync(join(root, 'node_modules')); ev.push({ check: 'node_modules installed', ok, detail: ok ? 'yes' : 'no' })
  if (!ok) f.push(F('medium', 'local.no_modules', 'Dependencies not installed', 'node_modules missing', 'npm install', 'node_modules'))
  try { const gi = readFileSync(join(root, '.gitignore'), 'utf8'); const gok = /^\.env(\.\*)?$/m.test(gi); ev.push({ check: '.gitignore protects .env files', ok: gok, detail: gok ? 'yes' : 'NO' }); if (!gok) f.push(F('high', 'local.gitignore_env', '.gitignore does not protect .env files', 'no ".env" / ".env.*" line', 'Add ".env" and ".env.*" lines.', '.gitignore')) } catch { /* reported above */ }
  return { f, ev }
}

// Local secret scan: pure Node, no shell. Env files are skipped (they are supposed to hold secrets; git preset checks they are ignored).
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', '.vercel', '.next', 'test-results', 'playwright-report'])
const TEXT_EXT = /\.(js|jsx|ts|tsx|json|md|yml|yaml|sql|html|toml|css|txt|mjs|cjs|sh)$/i
export function scanLocalSecrets(root: string, limit = 800): { f: Finding[]; files: number } {
  const f: Finding[] = []; let files = 0
  const walk = (dir: string) => {
    if (files >= limit) return
    let names: string[] = []
    try { names = readdirSync(dir) } catch { return }
    for (const n of names) {
      if (files >= limit) return
      const p = join(dir, n)
      let st; try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) { if (!SKIP_DIR.has(n)) walk(p); continue }
      if (/^\.env/.test(n) || !TEXT_EXT.test(n) || st.size > 300_000) continue
      if (/(\.test\.ts|\.spec\.ts)$/.test(n)) continue
      files++
      let txt = ''; try { txt = readFileSync(p, 'utf8') } catch { continue }
      f.push(...C.analyzeBundleText(p.slice(root.length + 1), txt).map(x => ({ ...x, area: 'local' as const, evidence: x.evidence.replace('(value hidden)', '(value hidden, local file)') })))
    }
  }
  walk(resolve(root))
  return { f, files }
}

// ---------------------------------------------------------------- presets
export const PRESETS: { id: string; label: string }[] = [
  { id: 'tests', label: 'Project tests (npm test)' },
  { id: 'build', label: 'Build (npm run build)' },
  { id: 'audit', label: 'Dependency audit (npm audit)' },
  { id: 'secrets', label: 'Secret scan of local files' },
  { id: 'git', label: 'Git status + .env safety' },
  { id: 'env', label: 'Env variables (names only)' },
  { id: 'system', label: 'Phone: Node, npm, disk' },
  { id: 'project', label: 'Project files sanity' }
]
export const PRESET_IDS = PRESETS.map(p => p.id)

export async function runLocal(presets: string[], exec: ExecFn, root: string, env: Record<string, string | undefined> = process.env) {
  const f: Finding[] = [], ev: Ev[] = [], commands: CmdRes[] = []
  const sh = async (bin: string, args: string[], timeoutMs: number) => {
    const p: Parsed = { bin, args, display: [bin, ...args.filter(a => a !== '--no-pager')].join(' ') }
    const r = await runOne(p, exec, root, timeoutMs)
    commands.push({ cmd: r.cmd, code: r.code, ms: r.ms, output: r.output })
    return r
  }
  for (const id of presets) {
    try {
      if (id === 'tests') { const r = await sh('npm', ['test'], 300_000); const fs = analyzeTests(r.code, r.raw, r.timedOut); f.push(...fs); ev.push({ check: 'npm test', ok: !fs.length, detail: `exit ${r.code} in ${Math.round(r.ms / 1000)}s, ${(/^# pass (\d+)/m.exec(r.raw) || [])[0] || 'pass ?'}, ${(/^# fail (\d+)/m.exec(r.raw) || [])[0] || 'fail ?'}` }) }
      else if (id === 'build') { const r = await sh('npm', ['run', 'build'], 300_000); const fs = analyzeBuild(r.code, r.raw, r.timedOut); f.push(...fs); ev.push({ check: 'npm run build', ok: !fs.length, detail: `exit ${r.code} in ${Math.round(r.ms / 1000)}s` }) }
      else if (id === 'audit') { const r = await sh('npm', ['audit', '--json'], 90_000); const fs = analyzeAudit(r.raw); f.push(...fs); ev.push({ check: 'npm audit', ok: !fs.some(x => ['critical', 'high', 'medium'].includes(x.severity)), detail: fs.length ? fs.map(x => x.title).join('; ') : 'no known vulnerabilities' }); commands[commands.length - 1].output = fs.map(x => x.title).join('\n') || 'no known vulnerabilities' }
      else if (id === 'secrets') { const r = scanLocalSecrets(root); f.push(...r.f); ev.push({ check: 'Secret scan of local files', ok: !r.f.length, detail: `${r.files} file(s) scanned, ${r.f.length} hit(s) (values never shown)` }) }
      else if (id === 'git') {
        const st = await sh('git', ['--no-pager', 'status', '-sb'], 30_000)
        await sh('git', ['--no-pager', 'log', '--oneline', '-n', '5'], 30_000)
        const ig = await sh('git', ['check-ignore', '-q', '.env.agent3'], 30_000)
        const fs = analyzeGit(st.code, st.raw, ig.code); f.push(...fs)
        ev.push({ check: 'Git status + .env.agent3 ignored', ok: !fs.some(x => ['critical', 'high', 'medium'].includes(x.severity)), detail: st.code ? 'not a git repo' : `${fs.filter(x => x.id === 'local.dirty').length ? 'uncommitted changes' : 'clean'}; .env.agent3 ${ig.code === 0 ? 'ignored (good)' : ig.code === 1 ? 'NOT ignored' : 'not checked'}` })
      }
      else if (id === 'env') { const r = analyzeEnv(env); f.push(...r.f); ev.push(...r.ev) }
      else if (id === 'system') {
        const n = await sh('node', ['-v'], 15_000); await sh('npm', ['-v'], 15_000); const d = await sh('df', ['-h'], 15_000); await sh('uname', ['-a'], 15_000)
        const r = analyzeSystem(n.raw, d.raw); f.push(...r.f); ev.push(...r.ev)
      }
      else if (id === 'project') { const r = analyzeProject(root); f.push(...r.f); ev.push(...r.ev.filter(e => !e.ok), { check: 'Project files', ok: !r.f.length, detail: r.ev.filter(e => e.ok).length + '/' + r.ev.length + ' present' }) }
    } catch (e) { ev.push({ check: 'Preset ' + id, ok: false, detail: 'FAILED TO RUN: ' + (e instanceof Error ? e.message : String(e)).slice(0, 160) }) }
  }
  return { findings: f, evidence: ev, commands }
}
