import { AgentError } from './util.js'

// ---------------------------------------------------------------- targets (authorized environment)
const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i
const PRIVATE_IP = /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1$|fc|fd|fe80)/i

export function parseTarget(raw: string): URL {
  let u: URL
  try { u = new URL(raw) } catch { throw new AgentError('Bad target URL', 400, 'bad_target') }
  if (u.protocol !== 'https:') throw new AgentError('Only https targets are allowed', 400, 'bad_target')
  if (u.username || u.password) throw new AgentError('Credentials in URL are not allowed', 400, 'bad_target')
  if (PRIVATE_HOST.test(u.hostname) || PRIVATE_IP.test(u.hostname) || /^\[/.test(u.hostname)) throw new AgentError('Private/internal hosts are blocked', 403, 'private_host')
  return u
}

// Target must be an exact origin from the AGENT3_TARGETS allow-list. Nothing else is ever contacted.
export function assertAuthorizedTarget(allowed: string[], target: unknown): string {
  if (typeof target !== 'string') throw new AgentError('target is required', 400, 'bad_target')
  const u = parseTarget(target)
  const origin = u.origin.toLowerCase()
  if (!allowed.some(a => { try { return new URL(a).origin.toLowerCase() === origin } catch { return false } }))
    throw new AgentError('Target is not in AGENT3_TARGETS (authorized environments only)', 403, 'unauthorized_target')
  return u.origin
}

export function validPath(p: unknown): string {
  if (typeof p !== 'string' || !p.startsWith('/') || p.startsWith('//') || p.length > 200 || /[\s\\\0]/.test(p) || p.includes('..'))
    throw new AgentError('Bad path: ' + String(p).slice(0, 60), 400, 'bad_path')
  return p
}

// ---------------------------------------------------------------- billing safety
// Paths that can create an impression, click, charge, earning, payout or ledger row.
const BILLING = /(impression|imp\b|click|track|serve|adserve|ad[-_]?request|pixel|postback|convert|conversion|payout|payment|withdraw|billing|invoice|ledger|earning|charge|wallet|checkout|topup|top-up|deposit|refund)/i
export const isBillingRisk = (path: string) => BILLING.test(path)

// A positive (credentialed) call to a billing-risk path is NEVER allowed unless the owner listed that exact
// path in AGENT3_NONBILLABLE_PATHS. Negative tests (no key / invalid key / malformed) are always safe: they cannot bill.
export function assertBillingSafe(path: string, mode: 'negative' | 'positive', nonBillable: string[]) {
  if (!isBillingRisk(path) || mode === 'negative') return
  if (!nonBillable.includes(path)) throw new AgentError('Blocked: ' + path + ' can create billable events. Only no-key / invalid-key tests are allowed on it.', 403, 'billing_blocked')
}

// Only these HTTP methods are ever sent to a target. No PUT/PATCH/DELETE.
export function assertMethod(m: string) {
  if (!['GET', 'HEAD', 'OPTIONS', 'POST'].includes(m)) throw new AgentError('Method not allowed: ' + m, 400, 'bad_method')
}

// ---------------------------------------------------------------- read-only SQL (same guard as Agent 1)
const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do|vacuum|reindex|cluster|refresh|comment|lock|listen|notify|set|reset|execute|prepare|merge|import|into)\b/i
export function assertReadOnlySql(sql: string): void {
  const s = sql.trim().replace(/;\s*$/, '')
  if (/--|\/\*/.test(s)) throw new Error('SQL comments are not allowed')
  if (s.includes(';')) throw new Error('Multiple statements are not allowed')
  if (!/^(select|with)\b/i.test(s)) throw new Error('Only SELECT/WITH queries are allowed')
  if (FORBIDDEN.test(s.replace(/'([^']|'')*'/g, "''"))) throw new Error('Query contains a forbidden keyword')
}

// ---------------------------------------------------------------- secrets in text (names/lines only, never values)
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
export function scanSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = []
  text.split('\n').forEach((ln, i) => {
    for (const [rule, re] of RULES) if (re.test(ln)) hits.push({ rule, line: i + 1 })
    ASSIGN.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = ASSIGN.exec(ln))) if (!PLACEHOLDER.test(m[2])) hits.push({ rule: 'hard-coded ' + m[1].toLowerCase(), line: i + 1 })
  })
  return hits
}

// Decode a JWT payload (no verification) to learn its role, so we can tell a public anon key from a service_role key.
export function jwtRole(token: string): string | null {
  const p = token.split('.')[1]
  if (!p) return null
  try { return JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).role || null } catch { return null }
}

// ---------------------------------------------------------------- misc
export function validRepo(repo: unknown): string {
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new AgentError('Bad repo name (use owner/name)', 400, 'bad_request')
  return repo
}
