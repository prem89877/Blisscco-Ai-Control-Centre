// Pure analyzers: take evidence in, return findings out. No network here, so they are fully unit-testable.
import { isBillingRisk, scanSecrets, jwtRole } from './guard.js'
import type { Probe } from './util.js'

export type Sev = 'critical' | 'high' | 'medium' | 'low' | 'info'
export interface Finding { id: string; area: 'website' | 'auth' | 'api' | 'database' | 'security' | 'mobile' | 'local'; severity: Sev; title: string; evidence: string; fix: string; target?: string }
const RANK: Record<Sev, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
export const sortFindings = (f: Finding[]) => [...f].sort((a, b) => RANK[a.severity] - RANK[b.severity])
export function countFindings(f: Finding[]) { const c: Record<Sev, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }; for (const x of f) c[x.severity]++; return c }
export const verdict = (f: Finding[]): 'pass' | 'attention' | 'fail' => { const c = countFindings(f); return c.critical || c.high ? 'fail' : c.medium || c.low ? 'attention' : 'pass' }

// ---------------------------------------------------------------- website
export function analyzePage(path: string, p: Probe): Finding[] {
  const out: Finding[] = []
  const add = (sev: Sev, id: string, title: string, evidence: string, fix: string, area: Finding['area'] = 'website') => out.push({ id, area, severity: sev, title, evidence, fix, target: path })
  if (p.status === 0) { add('high', 'web.unreachable', 'Page unreachable', p.error || 'no response', 'Check the deployment and DNS.'); return out }
  if (p.status >= 500) add('critical', 'web.5xx', 'Server error', 'HTTP ' + p.status, 'Check Vercel function logs for this route.')
  else if (p.status === 404) add('medium', 'web.404', 'Page not found', 'HTTP 404', 'Fix the route or remove it from AGENT3_WEB_PATHS.')
  else if (p.status >= 400) add('medium', 'web.4xx', 'Client error on a public page', 'HTTP ' + p.status, 'Confirm this page should be public.')
  if (p.ms > 3000) add('medium', 'web.slow', 'Slow response', p.ms + ' ms (limit 3000)', 'Check cold starts, large payloads, uncached queries.')
  else if (p.ms > 1500) add('low', 'web.slowish', 'Response slower than 1.5 s', p.ms + ' ms', 'Consider caching.')
  const ct = p.headers['content-type'] || ''
  if (p.status < 400 && /html/.test(ct)) {
    if (!/<title>[^<]+<\/title>/i.test(p.text)) add('low', 'web.no_title', 'Missing <title>', 'no title tag', 'Add a page title.')
    const vp = /<meta[^>]+name=["']viewport["'][^>]*>/i.exec(p.text)
    if (!vp) add('high', 'mobile.no_viewport', 'No mobile viewport meta tag', 'meta viewport missing', 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.', 'mobile')
    else if (/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/i.test(vp[0])) add('low', 'mobile.zoom_blocked', 'Pinch-zoom disabled (accessibility)', vp[0].slice(0, 120), 'Remove user-scalable=no / maximum-scale=1.', 'mobile')
    if (/<[^>]+style=["'][^"']*\bwidth\s*:\s*(\d{4,})px/i.test(p.text)) add('medium', 'mobile.fixed_width', 'Fixed pixel width of 1000px or more in inline style', 'inline width >= 1000px', 'Use max-width / relative units.', 'mobile')
    if (/<html(?![^>]*\blang=)/i.test(p.text)) add('low', 'web.no_lang', '<html> has no lang attribute', 'lang missing', 'Add lang="en".')
    if (/(Traceback|at\s+\S+\s+\(\S+:\d+:\d+\)|Cannot read propert|Unhandled Runtime Error|SyntaxError:)/.test(p.text)) add('high', 'web.error_leak', 'Page shows an error trace', 'stack trace text in HTML', 'Handle the error and hide internals.')
  }
  return out
}

const HEADERS: [string, Sev, string][] = [
  ['content-security-policy', 'medium', 'Add a Content-Security-Policy header.'],
  ['x-content-type-options', 'low', 'Add X-Content-Type-Options: nosniff.'],
  ['referrer-policy', 'low', 'Add Referrer-Policy.'],
  ['strict-transport-security', 'medium', 'Add Strict-Transport-Security (Vercel adds it on custom domains; verify).'],
  ['permissions-policy', 'info', 'Add Permissions-Policy.']
]
export function analyzeHeaders(origin: string, h: Record<string, string>): Finding[] {
  const out: Finding[] = []
  for (const [name, sev, fix] of HEADERS) if (!h[name]) out.push({ id: 'sec.header.' + name, area: 'security', severity: sev, title: 'Missing header: ' + name, evidence: origin + ' response has no ' + name, fix, target: origin })
  if (!h['x-frame-options'] && !/frame-ancestors/i.test(h['content-security-policy'] || '')) out.push({ id: 'sec.header.framing', area: 'security', severity: 'medium', title: 'Clickjacking protection missing', evidence: 'no X-Frame-Options and no CSP frame-ancestors', fix: 'Add X-Frame-Options: DENY or CSP frame-ancestors.', target: origin })
  if (h['server'] && /\d+\.\d+/.test(h['server'])) out.push({ id: 'sec.header.server', area: 'security', severity: 'low', title: 'Server header reveals a version', evidence: h['server'], fix: 'Hide version info.', target: origin })
  if (h['x-powered-by']) out.push({ id: 'sec.header.powered', area: 'security', severity: 'low', title: 'X-Powered-By header present', evidence: h['x-powered-by'], fix: 'Remove X-Powered-By.', target: origin })
  const acao = h['access-control-allow-origin']
  if (acao === '*' && h['access-control-allow-credentials'] === 'true') out.push({ id: 'sec.cors.creds', area: 'security', severity: 'high', title: 'CORS: wildcard origin with credentials', evidence: 'ACAO * + credentials true', fix: 'Use an explicit origin allow-list.', target: origin })
  return out
}

// ---------------------------------------------------------------- auth (unauthenticated visitor must NOT get protected content)
export function analyzeProtected(path: string, p: Probe): Finding[] {
  if (p.status === 0) return [{ id: 'auth.unreachable', area: 'auth', severity: 'medium', title: 'Protected path unreachable', evidence: p.error || 'no response', fix: 'Check the route.', target: path }]
  if ([401, 403].includes(p.status)) return []
  if ([301, 302, 303, 307, 308].includes(p.status) && /login|signin|auth|sign-in/i.test(p.redirected || '')) return []
  // SPA fallback returns 200 + same index.html; gating happens client side. Flag it as a note, not a bypass.
  if (p.status === 200) {
    const looksLoginGate = /(sign in|log in|login|password)/i.test(p.text)
    const hasData = /(balance|payout|earnings|revenue|api[_ ]?key)/i.test(p.text)
    if (hasData && !looksLoginGate) return [{ id: 'auth.bypass', area: 'auth', severity: 'critical', title: 'Protected page served to an anonymous visitor', evidence: 'HTTP 200, sensitive wording, no login gate', fix: 'Require auth server-side before rendering.', target: path }]
    return [{ id: 'auth.client_gate', area: 'auth', severity: 'info', title: 'Protected route returns 200 (client-side gate)', evidence: 'HTTP 200 to anonymous request; no sensitive wording found in HTML. Fine for an SPA only if data APIs enforce auth.', fix: 'Make sure every data call behind this page is authorized server-side (RLS / API checks).', target: path }]
  }
  return [{ id: 'auth.unexpected', area: 'auth', severity: 'low', title: 'Unexpected status for protected path', evidence: 'HTTP ' + p.status, fix: 'Expect 401/403 or redirect to login.', target: path }]
}

// ---------------------------------------------------------------- API
const TRACE = /(Traceback|\bat\s+\S+\s+\(\S+:\d+:\d+\)|node_modules|SQLSTATE|PostgresError|ECONNREFUSED|stack"\s*:)/i
export interface ApiCase { name: string; path: string; kind: 'no_key' | 'invalid_key' | 'malformed' | 'valid_key' | 'wrong_method'; probe: Probe }

export function analyzeApiCase(c: ApiCase): Finding[] {
  const out: Finding[] = []
  const add = (sev: Sev, id: string, title: string, evidence: string, fix: string) => out.push({ id, area: 'api', severity: sev, title, evidence, fix, target: c.name + ' ' + c.path + ' [' + c.kind + ']' })
  const p = c.probe
  if (p.status === 0) { add('high', 'api.unreachable', 'Endpoint unreachable', p.error || 'no response', 'Check deployment.'); return out }
  if (p.status >= 500) add(c.kind === 'valid_key' ? 'high' : 'medium', 'api.5xx', 'Server error (' + c.kind + ')', 'HTTP ' + p.status, 'Validate input and return 4xx; never crash on bad requests.')
  if (TRACE.test(p.text)) add('high', 'api.trace_leak', 'Error response leaks internals', 'stack/SQL/path text in body', 'Return generic error messages.')
  if (c.kind === 'no_key' || c.kind === 'invalid_key') {
    if (p.status >= 200 && p.status < 300) add('critical', 'api.auth_bypass', 'Endpoint accepts a request with ' + (c.kind === 'no_key' ? 'no API key' : 'an INVALID API key'), 'HTTP ' + p.status, 'Reject with 401/403 before any processing.')
    else if (![401, 403].includes(p.status) && p.status < 500) add('medium', 'api.auth_status', 'Unexpected status for ' + c.kind, 'HTTP ' + p.status + ' (expected 401/403)', 'Use 401 (no/invalid key) or 403 (not allowed).')
  }
  if (c.kind === 'malformed' && p.status >= 200 && p.status < 300) add('medium', 'api.validation', 'Malformed input accepted', 'HTTP ' + p.status, 'Validate request body/params; return 400/422.')
  if (c.kind === 'wrong_method' && p.status >= 200 && p.status < 300) add('low', 'api.method', 'Endpoint accepts an unsupported method', 'HTTP ' + p.status, 'Return 405.')
  if (p.status > 0 && p.status < 500) {
    const ct = p.headers['content-type'] || ''
    if (p.text && !/json/i.test(ct) && c.kind !== 'wrong_method' && (p.status >= 400 || c.kind === 'valid_key')) add('low', 'api.content_type', 'Non-JSON response', 'content-type: ' + (ct || 'none'), 'Return application/json with an error object.')
    if (/json/i.test(ct) && p.text) { try { JSON.parse(p.text) } catch { add('medium', 'api.bad_json', 'Response claims JSON but does not parse', 'parse error', 'Fix serialization.') } }
  }
  if (p.ms > 3000) add('low', 'api.slow', 'Slow API response', p.ms + ' ms', 'Profile the handler.')
  return out
}

export interface RateEvidence { total: number; statuses: Record<string, number>; first429: number | null; hasRetryAfter: boolean; has5xx: boolean }
export function analyzeRate(path: string, e: RateEvidence): Finding[] {
  const out: Finding[] = []
  const t = path + ' [burst ' + e.total + ']'
  if (e.has5xx) out.push({ id: 'rate.5xx', area: 'api', severity: 'high', title: 'Server errors under burst', evidence: JSON.stringify(e.statuses), fix: 'Add backpressure; return 429 before overload.', target: t })
  if (e.first429 == null) out.push({ id: 'rate.none', area: 'api', severity: 'medium', title: 'No rate limiting detected', evidence: 'No HTTP 429 in ' + e.total + ' rapid requests (' + JSON.stringify(e.statuses) + ')', fix: 'Add per-key/IP rate limits (Vercel WAF rate limit or middleware).', target: t })
  else if (!e.hasRetryAfter) out.push({ id: 'rate.no_retry_after', area: 'api', severity: 'low', title: 'Rate limit works but has no Retry-After header', evidence: 'first 429 at request ' + e.first429, fix: 'Send Retry-After.', target: t })
  return out
}

// ---------------------------------------------------------------- database
export interface TableRow { schema: string; tbl: string; rls: boolean; anon_select: boolean; anon_insert: boolean; anon_update: boolean; anon_delete: boolean; auth_select: boolean; auth_insert: boolean; auth_update: boolean; auth_delete: boolean }
export interface PolicyRow { schema: string; tbl: string; policy: string; cmd: string; roles: string; using_expr: string; check_expr: string }
export const BILLING_TABLE = /(ledger|payout|payment|billing|wallet|invoice|earning|charge|impression|click|transaction|balance)/i

export function analyzeDb(tables: TableRow[], policies: PolicyRow[]): Finding[] {
  const out: Finding[] = []
  const add = (sev: Sev, id: string, title: string, target: string, evidence: string, fix: string) => out.push({ id, area: 'database', severity: sev, title, evidence, fix, target })
  const anonPol = new Map<string, { read: boolean; write: boolean }>()
  const pc = new Map<string, number>()
  for (const p of policies) {
    const id = p.schema + '.' + p.tbl
    pc.set(id, (pc.get(id) || 0) + 1)
    if (/(anon|public)/.test(p.roles)) {
      const a = anonPol.get(id) || { read: false, write: false }
      if (['ALL', 'SELECT'].includes(p.cmd)) a.read = true
      if (['ALL', 'INSERT', 'UPDATE', 'DELETE'].includes(p.cmd)) a.write = true
      anonPol.set(id, a)
    }
    const open = (e: string) => /^\(?\s*true\s*\)?$/i.test((e || '').trim())
    if (/authenticated/.test(p.roles) && ['ALL', 'SELECT', 'UPDATE', 'DELETE'].includes(p.cmd) && open(p.using_expr) && BILLING_TABLE.test(p.tbl))
      add('high', 'db.isolation', 'Data isolation: any logged-in user can ' + p.cmd + ' ALL rows of a billing table', p.schema + '.' + p.tbl + ' / ' + p.policy, 'authenticated + using(true)', 'Scope the policy to the row owner, e.g. using (owner_id = auth.uid()).')
    if (/(anon|public)/.test(p.roles) && (open(p.using_expr) || open(p.check_expr)) && p.cmd !== 'SELECT')
      add(BILLING_TABLE.test(p.tbl) ? 'critical' : 'high', 'db.open_policy', 'Policy lets anonymous users ' + p.cmd + ' with no condition', p.schema + '.' + p.tbl + ' / ' + p.policy, 'using/check = true for anon/public', 'Restrict the policy or move the write behind a server function with validation + rate limit.')
  }
  for (const t of tables) {
    if (t.schema === 'storage') continue
    const id = t.schema + '.' + t.tbl
    const sens = BILLING_TABLE.test(t.tbl)
    const ap = anonPol.get(id) || { read: false, write: false }
    if (!t.rls) add(sens || t.schema === 'ai_control' ? 'critical' : 'high', 'db.rls_off', 'RLS is disabled', id, 'relrowsecurity = false', 'ALTER TABLE ... ENABLE ROW LEVEL SECURITY + add policies.')
    const anonWrite = t.anon_insert || t.anon_update || t.anon_delete
    if (anonWrite && (!t.rls || ap.write)) add(sens ? 'critical' : 'high', 'db.anon_write', 'Anonymous role can write', id, 'anon has write privilege and RLS does not block it', 'Revoke anon write grants or tighten policies.')
    else if (anonWrite) add('low', 'db.anon_grant', 'anon has write GRANT (RLS blocks it today)', id, 'defense-in-depth gap', 'Revoke unused anon grants.')
    if (t.anon_select && sens && (!t.rls || ap.read)) add('critical', 'db.billing_read', 'Anonymous role can read a billing/financial table', id, 'anon SELECT allowed', 'Remove anon read; billing data must be owner-scoped.')
    if (t.auth_delete && sens) add('medium', 'db.auth_delete_billing', 'authenticated role can DELETE billing/financial rows (ledger integrity risk)', id, 'authenticated has DELETE', 'Ledgers should be append-only: revoke UPDATE/DELETE.')
    else if (t.auth_update && sens && /(ledger|transaction)/i.test(t.tbl)) add('medium', 'db.auth_update_ledger', 'authenticated role can UPDATE ledger rows', id, 'authenticated has UPDATE', 'Make ledgers append-only.')
    if (t.rls && !pc.get(id)) add('info', 'db.deny_all', 'RLS on with no policies (deny-all; normal for server-only tables)', id, '0 policies', 'None if intentional.')
  }
  return out
}

export interface AnonProbe { table: string; status: number; rows: number }
export function analyzeAnonProbe(rs: AnonProbe[]): Finding[] {
  return rs.filter(r => r.rows > 0).map(r => ({ id: 'db.anon_leak', area: 'database' as const, severity: (BILLING_TABLE.test(r.table) ? 'critical' : 'high') as Sev, title: 'Anon key can read rows (live proof)', evidence: 'GET /rest/v1/' + r.table + ' with the anon key returned data (row count only; values never stored)', fix: 'Enable RLS / add owner-scoped policies.', target: r.table }))
}

// Billing event integrity (read-only aggregates computed in SQL)
export interface BillingStats { table: string; total: number; orphan_or_null: number; duplicates: number; negative: number }
export function analyzeBilling(s: BillingStats[]): Finding[] {
  const out: Finding[] = []
  for (const b of s) {
    const bad = (sev: Sev, id: string, title: string, n: number, fix: string) => out.push({ id, area: 'database', severity: sev, title, evidence: n + ' of ' + b.total + ' rows', fix, target: b.table })
    if (b.orphan_or_null > 0) bad('high', 'bill.null_ref', 'Billing rows with NULL/missing reference', b.orphan_or_null, 'Add NOT NULL / FK constraints; investigate rows.')
    if (b.duplicates > 0) bad('high', 'bill.duplicates', 'Duplicate billing events (same id/key repeated)', b.duplicates, 'Add a UNIQUE idempotency key; reconcile duplicates.')
    if (b.negative > 0) bad('medium', 'bill.negative', 'Negative amounts present', b.negative, 'Confirm refunds are modeled intentionally; add CHECK constraint otherwise.')
  }
  return out
}

// Schema consistency: expected Phase-1 objects vs reality
export function analyzeSchema(expected: string[], tables: { schema: string; tbl: string }[]): Finding[] {
  const have = new Set(tables.map(t => t.schema + '.' + t.tbl))
  return expected.filter(e => !have.has(e)).map(e => ({ id: 'schema.missing', area: 'database' as const, severity: 'high' as Sev, title: 'Expected table missing', evidence: e + ' not found', fix: 'Re-run 03-DATABASE-SCHEMA.sql / migrations.', target: e }))
}
export const EXPECTED_TABLES = ['ai_control.owners', 'ai_control.agents', 'ai_control.tasks', 'ai_control.approvals', 'ai_control.activity_logs', 'ai_control.api_usage', 'ai_control.system_health', 'ai_control.settings']

// ---------------------------------------------------------------- bundle / repo secrets
export function analyzeBundleText(file: string, text: string, serviceKeyLike: (s: string) => boolean = () => false): Finding[] {
  const out: Finding[] = []
  const seen = new Set<string>()
  for (const h of scanSecrets(text)) {
    if (h.rule === 'JWT') continue // handled below: anon keys are public by design
    const k = h.rule; if (seen.has(k)) continue; seen.add(k)
    out.push({ id: 'sec.secret_exposed', area: 'security', severity: 'critical', title: 'Possible secret exposed to browsers: ' + h.rule, evidence: file + ' line ' + h.line + ' (value hidden)', fix: 'Rotate the key NOW, move it to server-only env vars.', target: file })
  }
  for (const m of text.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g)) {
    const role = jwtRole(m[0])
    if (role === 'service_role' || serviceKeyLike(m[0])) { out.push({ id: 'sec.service_role_exposed', area: 'security', severity: 'critical', title: 'service_role key found in a public file', evidence: file + ' (value hidden)', fix: 'Rotate the Supabase service_role key immediately; never ship it to browsers.', target: file }); break }
  }
  return out
}

// Input validation probes: payload -> what the endpoint did
export const PAYLOADS: { name: string; value: string }[] = [
  { name: 'sql_quote', value: "' OR '1'='1" },
  { name: 'xss_tag', value: '<script>alert(1)</script>' },
  { name: 'path_traversal', value: '../../etc/passwd' },
  { name: 'long_input', value: 'A'.repeat(5000) }
]
export function analyzeInputProbe(path: string, name: string, payload: string, p: Probe): Finding[] {
  const out: Finding[] = []
  const t = path + ' [' + name + ']'
  if (p.status >= 500) out.push({ id: 'input.5xx', area: 'security', severity: 'medium', title: 'Hostile input causes a server error', evidence: 'HTTP ' + p.status, fix: 'Validate and sanitize input; return 400.', target: t })
  if (TRACE.test(p.text)) out.push({ id: 'input.trace', area: 'security', severity: 'high', title: 'Hostile input reveals internal error details', evidence: 'stack/SQL text in response', fix: 'Return generic errors.', target: t })
  if (name === 'xss_tag' && p.text.includes(payload) && /html/i.test(p.headers['content-type'] || '')) out.push({ id: 'input.reflected_xss', area: 'security', severity: 'high', title: 'Input reflected unescaped in HTML', evidence: 'payload echoed in HTML response', fix: 'Escape output / use a framework that auto-escapes.', target: t })
  return out
}

export { isBillingRisk }
