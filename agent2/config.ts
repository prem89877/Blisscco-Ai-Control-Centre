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

// Configurable, safe limits for the professional developer workflow (env AGENT2_DEV_*). Clamped so a bad value can neither
// disable a limit nor starve the workflow.
export interface DevLimits { maxContextFiles: number; maxContextBytes: number; maxChangeFiles: number; batchSize: number; maxFixRounds: number; historyTurns: number }
const clampN = (raw: string | undefined, def: number, lo: number, hi: number) => { const n = Math.floor(Number(raw)); return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : def }
export function devLimits(env: Record<string, string | undefined> = process.env): DevLimits {
  return {
    maxContextFiles: clampN(env.AGENT2_DEV_MAX_CONTEXT_FILES, 25, 1, 80),
    maxContextBytes: clampN(env.AGENT2_DEV_MAX_CONTEXT_BYTES, 120_000, 10_000, 400_000),
    maxChangeFiles: clampN(env.AGENT2_DEV_MAX_FILES, 40, 1, 120), // hard cap of one proposal; larger work is split into batches
    batchSize: clampN(env.AGENT2_DEV_BATCH_SIZE, 8, 1, 20),
    maxFixRounds: clampN(env.AGENT2_DEV_MAX_FIX_ROUNDS, 2, 0, 5),
    historyTurns: clampN(env.AGENT2_DEV_HISTORY_TURNS, 10, 1, 30)
  }
}
