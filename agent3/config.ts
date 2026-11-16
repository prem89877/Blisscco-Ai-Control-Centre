import { AgentError } from './util.js'

export interface ApiEndpoint { name: string; path: string; method: 'GET' | 'POST'; auth: 'none' | 'key' | 'user'; billing_risk?: boolean }

export interface Config {
  supabaseUrl: string
  supabaseRef: string
  serviceKey: string
  anonKey?: string
  supaToken?: string
  githubToken?: string
  githubRepos: string[]
  geminiKey?: string
  geminiModel: string
  targets: string[]            // allow-listed base URLs (https only)
  webPaths: string[]
  protectedPaths: string[]
  endpoints: ApiEndpoint[]
  nonBillablePaths: string[]   // owner-declared endpoints that are safe to call with a valid test key
  testApiKey?: string
  priceIn: number
  priceOut: number
}

const list = (v?: string) => (v || '').split(',').map(s => s.trim()).filter(Boolean)

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const supabaseUrl = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/+$/, '')
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || ''
  if (!supabaseUrl || !serviceKey) throw new AgentError('Server not configured', 500, 'not_configured')
  const m = /^https:\/\/([a-z0-9]+)\.supabase\.co$/i.exec(supabaseUrl)
  let endpoints: ApiEndpoint[] = []
  try { if (env.AGENT3_API_ENDPOINTS) endpoints = JSON.parse(env.AGENT3_API_ENDPOINTS) } catch { /* reported by readiness */ }
  endpoints = Array.isArray(endpoints) ? endpoints.filter(e => e && typeof e.path === 'string' && e.path.startsWith('/')) : []
  return {
    supabaseUrl,
    supabaseRef: env.AGENT3_SUPABASE_REF || (m ? m[1] : ''),
    serviceKey,
    anonKey: env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY,
    supaToken: env.AGENT3_SUPABASE_ACCESS_TOKEN,
    githubToken: env.AGENT3_GITHUB_TOKEN,
    githubRepos: list(env.AGENT3_GITHUB_REPOS),
    geminiKey: env.AGENT3_GEMINI_API_KEY, // dedicated key (own Google AI Studio project), never shared
    geminiModel: env.AGENT3_GEMINI_MODEL || 'gemini-3.5-flash',
    targets: list(env.AGENT3_TARGETS).map(t => t.replace(/\/+$/, '')),
    webPaths: list(env.AGENT3_WEB_PATHS).length ? list(env.AGENT3_WEB_PATHS) : ['/'],
    protectedPaths: list(env.AGENT3_PROTECTED_PATHS),
    endpoints,
    nonBillablePaths: list(env.AGENT3_NONBILLABLE_PATHS),
    testApiKey: env.AGENT3_TEST_API_KEY,
    priceIn: Number(env.AGENT3_PRICE_IN_PER_M || 0),
    priceOut: Number(env.AGENT3_PRICE_OUT_PER_M || 0)
  }
}

export function secretValues(c: Config): string[] {
  return [c.serviceKey, c.supaToken, c.githubToken, c.geminiKey, c.testApiKey].filter((x): x is string => !!x)
}

export function readiness(c: Config) {
  return {
    targets: c.targets.length > 0,
    api_endpoints: c.endpoints.length > 0,
    supabase_rest: true,
    supabase_mgmt: Boolean(c.supaToken && c.supabaseRef),
    anon_probe: Boolean(c.anonKey),
    github: Boolean(c.githubToken && c.githubRepos.length),
    gemini: Boolean(c.geminiKey)
  }
}
