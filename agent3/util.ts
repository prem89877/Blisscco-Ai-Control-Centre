import { createHmac } from 'node:crypto'

export class AgentError extends Error {
  taskId?: string
  constructor(message: string, public status = 400, public code = 'bad_request') {
    super(message)
  }
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const PATTERNS: RegExp[] = [
  /sbp_[A-Za-z0-9_]{10,}/g,
  /sb_secret_[A-Za-z0-9_-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /AIza[0-9A-Za-z_-]{25,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi
]
const SECRET_KEYS = /^(value|password|secret|authorization|token|api_?key|apikey)$/i

export function redactString(s: string, secrets: string[] = []): string {
  let out = s
  for (const sec of secrets) if (sec && sec.length >= 8) out = out.split(sec).join('[REDACTED]')
  for (const re of PATTERNS) out = out.replace(re, '[REDACTED]')
  return out
}

export function redact<T>(v: T, secrets: string[] = []): T {
  if (typeof v === 'string') return redactString(v, secrets) as unknown as T
  if (Array.isArray(v)) return v.map(x => redact(x, secrets)) as unknown as T
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      o[k] = SECRET_KEYS.test(k) && typeof x === 'string' ? '[REDACTED]' : redact(x, secrets)
    }
    return o as T
  }
  return v
}

export function clip<T>(v: T, maxChars = 150000): T | { truncated: true; preview: string } {
  const s = JSON.stringify(v)
  if (s === undefined || s.length <= maxChars) return v
  return { truncated: true, preview: s.slice(0, 4000) }
}

// Keyed fingerprint of a secret value. Lets us prove "same value as approved"
// without ever storing the value.
export function fingerprint(key: string, value: string): string {
  return createHmac('sha256', key).update(value).digest('hex').slice(0, 16)
}

export interface HttpResult { status: number; ok: boolean; body: any }

export async function jfetch(url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<HttpResult> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal })
    const text = await r.text()
    let body: any = null
    try { body = text ? JSON.parse(text) : null } catch { body = text }
    return { status: r.status, ok: r.ok, body }
  } catch (e) {
    throw new AgentError('Network error: ' + errMsg(e), 502, 'network')
  } finally {
    clearTimeout(t)
  }
}

export function b64(s: string): string { return Buffer.from(s, 'utf8').toString('base64') }
export function unb64(s: string): string { return Buffer.from(s.replace(/\n/g, ''), 'base64').toString('utf8') }

export interface Probe { status: number; ms: number; headers: Record<string, string>; text: string; error?: string; redirected?: string }
// Raw probe: never follows redirects (so auth redirects are visible), never throws, caps body size.
export async function probe(url: string, init: RequestInit = {}, timeoutMs = 12000, maxBytes = 300_000): Promise<Probe> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    const r = await fetch(url, { redirect: 'manual', ...init, signal: ctl.signal })
    const headers: Record<string, string> = {}
    r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v })
    const text = init.method === 'HEAD' ? '' : (await r.text()).slice(0, maxBytes)
    return { status: r.status, ms: Date.now() - t0, headers, text, redirected: headers.location }
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, headers: {}, text: '', error: errMsg(e) }
  } finally { clearTimeout(t) }
}
