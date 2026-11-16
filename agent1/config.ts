import { AgentError } from './util.js'

export interface Config {
  supabaseUrl: string
  supabaseRef: string
  serviceKey: string
  anonKey?: string
  vercelToken?: string
  vercelTeamId?: string
  vercelProjects: string[]
  supaToken?: string
  githubToken?: string
  githubRepos: string[]
  geminiKey?: string
  geminiModel: string
  requiredEnv: Record<string, string[]>
  priceIn: number
  priceOut: number
}

const list = (v?: string) => (v || '').split(',').map(s => s.trim()).filter(Boolean)

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const supabaseUrl = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/+$/, '')
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || ''
  if (!supabaseUrl || !serviceKey) throw new AgentError('Server not configured', 500, 'not_configured')
  const m = /^https:\/\/([a-z0-9]+)\.supabase\.co$/i.exec(supabaseUrl)
  let requiredEnv: Record<string, string[]> = {}
  try { if (env.AGENT1_REQUIRED_ENV) requiredEnv = JSON.parse(env.AGENT1_REQUIRED_ENV) } catch { /* ignored: reported by readiness */ }
  return {
    supabaseUrl,
    supabaseRef: env.AGENT1_SUPABASE_REF || (m ? m[1] : ''),
    serviceKey,
    anonKey: env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY,
    vercelToken: env.AGENT1_VERCEL_TOKEN,
    vercelTeamId: env.AGENT1_VERCEL_TEAM_ID,
    vercelProjects: list(env.AGENT1_VERCEL_PROJECTS),
    supaToken: env.AGENT1_SUPABASE_ACCESS_TOKEN,
    githubToken: env.AGENT1_GITHUB_TOKEN,
    githubRepos: list(env.AGENT1_GITHUB_REPOS),
    geminiKey: env.AGENT1_GEMINI_API_KEY, // dedicated key, never shared with other agents
    geminiModel: env.AGENT1_GEMINI_MODEL || 'gemini-3.5-flash',
    requiredEnv,
    priceIn: Number(env.AGENT1_PRICE_IN_PER_M || 0),
    priceOut: Number(env.AGENT1_PRICE_OUT_PER_M || 0)
  }
}

export function secretValues(c: Config): string[] {
  return [c.serviceKey, c.vercelToken, c.supaToken, c.githubToken, c.geminiKey].filter((x): x is string => !!x)
}

export function readiness(c: Config) {
  return {
    supabase_rest: true,
    supabase_mgmt: Boolean(c.supaToken && c.supabaseRef),
    vercel: Boolean(c.vercelToken),
    github: Boolean(c.githubToken && c.githubRepos.length),
    gemini: Boolean(c.geminiKey),
    anon_probe: Boolean(c.anonKey)
  }
}
