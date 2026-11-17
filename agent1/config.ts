import { AgentError } from './util.js'

export interface SupabaseProject { ref: string; label: string }

export interface Config {
  supabaseUrl: string
  supabaseRef: string
  // Allow-list of Supabase projects SQL may run on (AGENT1_SUPABASE_PROJECTS="test=abc...,prod=xyz..."). The default project is always included.
  supabaseProjects?: SupabaseProject[]
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

const REF_RE = /^[a-z0-9]{8,40}$/

// "label=ref,label2=ref2" (or bare refs). The default project is always first and always allowed.
export function parseProjects(raw: string | undefined, def: string): SupabaseProject[] {
  const out: SupabaseProject[] = []
  const put = (ref: string, label: string, named = true) => {
    const r = ref.trim().toLowerCase()
    const l = label.trim().replace(/[^\w .-]/g, '').slice(0, 40) || r.slice(0, 8)
    if (!REF_RE.test(r)) return
    const hit = out.find(x => x.ref === r)
    if (hit) { if (named && hit.label === 'default') hit.label = l; return }
    out.push({ ref: r, label: l })
  }
  if (def) out.push({ ref: def.trim().toLowerCase(), label: 'default' }) // the configured default is always allowed as-is
  for (const part of (raw || '').split(',')) {
    const t = part.trim(); if (!t) continue
    const i = t.indexOf('=')
    if (i > 0) put(t.slice(i + 1), t.slice(0, i)); else put(t, t.slice(0, 8), false)
  }
  return out
}

export function projectList(c: Config): SupabaseProject[] {
  return c.supabaseProjects && c.supabaseProjects.length ? c.supabaseProjects : (c.supabaseRef ? [{ ref: c.supabaseRef, label: 'default' }] : [])
}

// Only a project on the allow-list can ever be used; an empty value means the default project.
export function resolveProject(c: Config, ref?: string): SupabaseProject {
  const list = projectList(c)
  const want = String(ref || c.supabaseRef || '').trim().toLowerCase()
  const hit = list.find(x => x.ref === want)
  if (!hit) throw new AgentError('Supabase project is not on the allow-list (AGENT1_SUPABASE_PROJECTS)', 403, 'project_not_allowed')
  return hit
}

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
    supabaseProjects: parseProjects(env.AGENT1_SUPABASE_PROJECTS, env.AGENT1_SUPABASE_REF || (m ? m[1] : '')),
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
