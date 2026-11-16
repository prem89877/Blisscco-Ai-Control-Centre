import { AgentError } from './util.js'

export interface Config {
  supabaseUrl: string
  serviceKey: string
  githubToken?: string
  githubRepos: string[]
  protectedBranches: string[]
  geminiKey?: string
  geminiModel: string
  workdir: string
  priceIn: number
  priceOut: number
}

const list = (v?: string) => (v || '').split(',').map(s => s.trim()).filter(Boolean)

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const supabaseUrl = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/+$/, '')
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || ''
  if (!supabaseUrl || !serviceKey) throw new AgentError('Server not configured', 500, 'not_configured')
  return {
    supabaseUrl,
    serviceKey,
    githubToken: env.AGENT2_GITHUB_TOKEN,
    githubRepos: list(env.AGENT2_GITHUB_REPOS),
    protectedBranches: (list(env.AGENT2_PROTECTED_BRANCHES).length ? list(env.AGENT2_PROTECTED_BRANCHES) : ['main', 'master', 'production', 'prod']).map(b => b.toLowerCase()),
    geminiKey: env.AGENT2_GEMINI_API_KEY, // dedicated key (own Google AI Studio project), never shared with other agents
    geminiModel: env.AGENT2_GEMINI_MODEL || 'gemini-3.5-flash',
    workdir: env.AGENT2_WORKDIR || process.cwd(),
    priceIn: Number(env.AGENT2_PRICE_IN_PER_M || 0),
    priceOut: Number(env.AGENT2_PRICE_OUT_PER_M || 0)
  }
}

export function secretValues(c: Config): string[] {
  return [c.serviceKey, c.githubToken, c.geminiKey].filter((x): x is string => !!x)
}

export function readiness(c: Config) {
  return {
    supabase_rest: true,
    github: Boolean(c.githubToken && c.githubRepos.length),
    gemini: Boolean(c.geminiKey)
  }
}

export function repoAllowed(c: Config, repo: string): boolean {
  return c.githubRepos.some(r => r.toLowerCase() === repo.toLowerCase())
}
