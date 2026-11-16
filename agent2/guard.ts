import { createHash } from 'node:crypto'
import { AgentError } from './util.js'

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
// Same value git computes for a file's blob. Lets us compare GitHub's current file with what we committed.
export const gitBlobSha = (s: string) => { const b = Buffer.from(s, 'utf8'); return createHash('sha1').update('blob ' + b.length + '\0').update(b).digest('hex') }

// ---------------------------------------------------------------- paths
export function isSecretFile(path: string): boolean {
  const base = (path.split('/').pop() || '').toLowerCase()
  if (/^\.env(\..+)?$/.test(base) && !/\.(example|sample|template)$/.test(base)) return true
  if (/\.(pem|key|p12|pfx|jks|keystore)$/.test(base)) return true
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(base)) return true
  if (base === '.npmrc' || base === '.netrc' || base === '.pgpass') return true
  if (/service[-_]?account.*\.json$/.test(base)) return true
  return false
}

export function validatePath(raw: unknown): string {
  if (typeof raw !== 'string') throw new AgentError('Path must be a string', 400, 'bad_path')
  const p = raw.trim()
  if (!p || p.length > 200) throw new AgentError('Bad path length', 400, 'bad_path')
  if (/[\0\\]/.test(p) || p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:/.test(p)) throw new AgentError('Path must be relative: ' + p, 400, 'bad_path')
  const segs = p.split('/')
  for (const s of segs) {
    if (!s || s === '.' || s === '..') throw new AgentError('Unsafe path: ' + p, 400, 'bad_path')
    const l = s.toLowerCase()
    if (l === '.git' || l === 'node_modules' || l === '.agent2') throw new AgentError('Blocked path: ' + p, 403, 'blocked_path')
  }
  if (isSecretFile(p)) throw new AgentError('Secret/credential file blocked: ' + p, 403, 'secret_file')
  return p
}

const SENSITIVE = [/^\.github\//, /^vercel\.json$/, /(^|\/)package(-lock)?\.json$/, /^supabase\//, /\.sql$/i, /^\.gitignore$/, /^agent[0-9]+\//, /^\.env\.example$/]
export const isSensitivePath = (p: string) => SENSITIVE.some(r => r.test(p))

// ---------------------------------------------------------------- secrets in code
const RULES: [string, RegExp][] = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{25,}/],
  ['Supabase token', /\b(?:sbp_[A-Za-z0-9_]{10,}|sb_secret_[A-Za-z0-9_-]{10,})/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['AWS key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['API secret key', /\bsk-[A-Za-z0-9_-]{20,}/]
]
const ASSIGN = /(api[_-]?key|secret|token|passwd|password)["']?\s*[:=]\s*["']([A-Za-z0-9_\-+/=.]{16,})["']/gi
const PLACEHOLDER = /(your|xxx|example|changeme|placeholder|dummy|sample|test|\.\.\.|<)/i

export interface SecretHit { rule: string; line: number }
// Returns rule names and line numbers only. The matched value is never returned.
export function scanSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = []
  const lines = text.split('\n')
  lines.forEach((ln, i) => {
    for (const [rule, re] of RULES) if (re.test(ln)) hits.push({ rule, line: i + 1 })
    ASSIGN.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = ASSIGN.exec(ln))) if (!PLACEHOLDER.test(m[2])) hits.push({ rule: 'hard-coded ' + m[1].toLowerCase(), line: i + 1 })
  })
  return hits
}

// ---------------------------------------------------------------- change sets
export interface FileIn { path: string; op: 'create' | 'update' | 'delete'; content?: string }
export interface Limits { maxFiles: number; maxFileBytes: number; maxTotalBytes: number }
export const LIMITS: Limits = { maxFiles: 40, maxFileBytes: 200_000, maxTotalBytes: 600_000 }

export function validateFiles(input: unknown, lim: Limits = LIMITS): FileIn[] {
  if (!Array.isArray(input) || !input.length) throw new AgentError('files[] is required', 400, 'bad_request')
  if (input.length > lim.maxFiles) throw new AgentError('Too many files (max ' + lim.maxFiles + ')', 400, 'too_large')
  const seen = new Set<string>()
  const out: FileIn[] = []
  let total = 0
  const secretIssues: string[] = []
  for (const f of input as any[]) {
    const path = validatePath(f && f.path)
    const op = f.op === 'create' || f.op === 'update' || f.op === 'delete' ? f.op : null
    if (!op) throw new AgentError('op must be create, update or delete: ' + path, 400, 'bad_request')
    if (seen.has(path.toLowerCase())) throw new AgentError('Duplicate path: ' + path, 400, 'bad_request')
    seen.add(path.toLowerCase())
    if (op === 'delete') { out.push({ path, op }); continue }
    if (typeof f.content !== 'string') throw new AgentError('content must be a string: ' + path, 400, 'bad_request')
    if (f.content.includes('\0')) throw new AgentError('Binary content not allowed: ' + path, 400, 'bad_request')
    const bytes = Buffer.byteLength(f.content)
    if (bytes > lim.maxFileBytes) throw new AgentError('File too large: ' + path, 400, 'too_large')
    total += bytes
    for (const h of scanSecrets(f.content)) secretIssues.push(`${path}:${h.line} (${h.rule})`)
    out.push({ path, op, content: f.content })
  }
  if (total > lim.maxTotalBytes) throw new AgentError('Change set too large', 400, 'too_large')
  if (secretIssues.length) throw new AgentError('Possible secrets found, nothing was saved: ' + secretIssues.slice(0, 8).join(', '), 422, 'secret_detected')
  return out
}

// ---------------------------------------------------------------- diff (cheap, O(n))
export function diffStats(oldText: string | null, newText: string | null) {
  const a = oldText == null ? [] : oldText.split('\n')
  const b = newText == null ? [] : newText.split('\n')
  let s = 0
  while (s < a.length && s < b.length && a[s] === b[s]) s++
  let ea = a.length, eb = b.length
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb-- }
  const removed = a.slice(s, ea), added = b.slice(s, eb)
  const patch = [...removed.slice(0, 40).map(l => '- ' + l), ...(removed.length > 40 ? ['- ...'] : []), ...added.slice(0, 40).map(l => '+ ' + l), ...(added.length > 40 ? ['+ ...'] : [])].join('\n')
  return { added: added.length, removed: removed.length, start_line: s + 1, patch }
}

// ---------------------------------------------------------------- branches
export function isProtected(branch: string, protectedList: string[]): boolean {
  const b = branch.toLowerCase().replace(/^refs\/heads\//, '')
  return protectedList.includes(b) || /^release/.test(b)
}
export const AGENT_BRANCH = /^agent2\/[a-z0-9][a-z0-9._-]{0,80}$/
export function assertAgentBranch(branch: string, protectedList: string[]) {
  if (!AGENT_BRANCH.test(branch) || isProtected(branch, protectedList) || branch.includes('..') || branch.endsWith('.lock') || branch.endsWith('/'))
    throw new AgentError('Agent 2 only writes to branches named agent2/<name>, never to ' + branch, 403, 'branch_blocked')
}
export function branchFor(title: string, now = new Date()): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'change'
  const ts = now.toISOString().replace(/[-:T]/g, '').slice(2, 12)
  return `agent2/${slug}-${ts}`
}
export function validRepo(repo: unknown): string {
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new AgentError('Bad repo name (use owner/name)', 400, 'bad_request')
  return repo
}

// ---------------------------------------------------------------- shell commands
export type CmdLevel = 'safe' | 'approval' | 'blocked'
export interface CmdClass { level: CmdLevel; reason: string }

export function tokenize(cmd: string): string[] {
  if (typeof cmd !== 'string' || !cmd.trim() || cmd.length > 300) throw new AgentError('Bad command', 400, 'bad_command')
  // No shell is ever used. Metacharacters, quotes, globs and expansions are rejected outright.
  if (/[;&|<>`$\n\r\\(){}*?~#!"'^]/.test(cmd)) throw new AgentError('Command contains shell characters; only a plain program with arguments is allowed', 400, 'bad_command')
  return cmd.trim().split(/\s+/)
}

const SAFE_SCRIPTS = ['lint', 'typecheck', 'type-check', 'test', 'check', 'build', 'format:check']
export const isSafeScript = (s: string) => SAFE_SCRIPTS.includes(s)
const ALWAYS_BLOCKED = ['sudo', 'su', 'doas', 'dd', 'mkfs', 'mount', 'umount', 'chown', 'shutdown', 'reboot', 'ssh', 'scp', 'sftp', 'nc', 'ncat', 'telnet', 'eval', 'source', 'env', 'printenv', 'export', 'set', 'unset', 'sh', 'bash', 'zsh', 'dash', 'ash', 'fish', 'exec', 'xargs', 'nohup', 'crontab', 'kill', 'pkill', 'killall', 'passwd', 'termux-setup-storage']
const GIT_SAFE = ['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'rev-list']
const GIT_BLOCKED = ['push', 'clean', 'config', 'filter-branch', 'filter-repo', 'update-ref', 'gc', 'prune', 'reflog', 'credential', 'daemon', 'submodule', 'worktree']
const READ_BINS = ['cat', 'head', 'tail', 'wc', 'ls', 'grep', 'stat', 'pwd', 'tree']

export function classifyCommand(argv: string[]): CmdClass {
  if (!argv.length) return { level: 'blocked', reason: 'empty' }
  const bin = argv[0]
  if (bin.includes('/')) return { level: 'blocked', reason: 'Call programs by name, not by path' }
  const args = argv.slice(1)
  for (const a of args) {
    if (/AGENT2_|SERVICE_ROLE|\.env\.agent2/i.test(a)) return { level: 'blocked', reason: 'References secrets' }
    if (!a.startsWith('-') && isSecretFile(a)) return { level: 'blocked', reason: 'Secret file: ' + a }
    if (a.startsWith('-c') && bin === 'git') return { level: 'blocked', reason: 'git -c is not allowed' }
  }
  if (ALWAYS_BLOCKED.includes(bin)) return { level: 'blocked', reason: bin + ' is never allowed' }

  if (READ_BINS.includes(bin)) {
    for (const a of args.filter(x => !x.startsWith('-'))) {
      if (bin === 'grep' && a === args.filter(x => !x.startsWith('-'))[0]) continue // the pattern
      try { validatePath(a) } catch (e) { return { level: 'blocked', reason: (e as Error).message } }
    }
    return { level: 'safe', reason: 'read-only' }
  }
  if (bin === 'find') return args.some(a => /^-(exec|execdir|ok|okdir|delete|fprint)/.test(a)) ? { level: 'blocked', reason: 'find with actions' } : { level: 'safe', reason: 'read-only' }

  if (bin === 'git') {
    const sub = args[0] || ''
    if (GIT_BLOCKED.includes(sub)) return { level: 'blocked', reason: 'git ' + sub + ' is not allowed here (use the dedicated Agent 2 action)' }
    if (args.some(a => /^--(exec|upload-pack|receive-pack|config)/.test(a))) return { level: 'blocked', reason: 'git option not allowed' }
    if (GIT_SAFE.includes(sub)) return { level: 'safe', reason: 'read-only git' }
    if (sub === 'branch' && args.slice(1).every(a => ['-a', '-r', '-v', '-vv', '--list', '--show-current'].includes(a))) return { level: 'safe', reason: 'read-only git' }
    if (sub === 'remote' && args.slice(1).every(a => a === '-v')) return { level: 'safe', reason: 'read-only git' }
    if (sub === 'reset' && args.includes('--hard')) return { level: 'approval', reason: 'DISCARDS local changes' }
    return { level: 'approval', reason: 'git ' + sub + ' changes the repository' }
  }
  if (bin === 'node') return args.length === 1 && /^(-v|--version)$/.test(args[0]) ? { level: 'safe', reason: 'version' } : { level: 'approval', reason: 'runs code' }
  if (bin === 'npm') {
    const sub = args[0] || ''
    if (['publish', 'login', 'adduser', 'token', 'config', 'whoami', 'owner', 'access', 'deprecate', 'unpublish'].includes(sub)) return { level: 'blocked', reason: 'npm ' + sub + ' is not allowed' }
    if (/^(-v|--version)$/.test(sub) || sub === 'ls') return { level: 'safe', reason: 'read-only' }
    if (sub === 'test' && args.length === 1) return { level: 'safe', reason: 'check script' }
    if (sub === 'run' && args.length === 2 && isSafeScript(args[1])) return { level: 'safe', reason: 'check script' }
    return { level: 'approval', reason: 'npm ' + sub + ' runs scripts / installs packages' }
  }
  if (bin === 'npx') return args[0] === 'tsc' && args.includes('--noEmit') ? { level: 'safe', reason: 'type check' } : { level: 'approval', reason: 'npx runs a package' }
  if (bin === 'rm') {
    for (const a of args.filter(x => !x.startsWith('-'))) {
      try { validatePath(a) } catch { return { level: 'blocked', reason: 'rm target not a safe relative path: ' + a } }
    }
    return args.some(a => !a.startsWith('-')) ? { level: 'approval', reason: 'DELETES files' } : { level: 'blocked', reason: 'rm needs a target' }
  }
  if (bin === 'chmod' && args.some(a => /^-[a-zA-Z]*R/.test(a) || a === '--recursive' || a === '777')) return { level: 'blocked', reason: 'recursive/world-writable chmod' }
  return { level: 'approval', reason: 'unknown command: shown to you before it runs' }
}

export function minimalEnv(extra: Record<string, string> = {}): Record<string, string> {
  const keep = ['PATH', 'HOME', 'TERM', 'LANG', 'TMPDIR', 'PREFIX', 'SHELL']
  const e: Record<string, string> = {}
  for (const k of keep) if (process.env[k]) e[k] = process.env[k] as string
  return { ...e, CI: '1', GIT_TERMINAL_PROMPT: '0', ...extra }
}
