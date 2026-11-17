import { loadConfig as loadA1, secretValues as secretsA1, readiness as readyA1, type Config as C1 } from '../agent1/config.js'
import { loadConfig as loadA2, secretValues as secretsA2, readiness as readyA2, type Config as C2 } from '../agent2/config.js'

// The Orchestrator has NO credentials of its own. It reuses the existing Agent 1 and Agent 2
// configuration (same env vars, same allow-lists, same protected branches). Agent 3 is never loaded.
export interface OrchConfig {
  c1: C1
  c2: C2
  supabaseUrl: string
  serviceKey: string
  secrets: string[]
}

export function loadOrchConfig(env: Record<string, string | undefined> = process.env): OrchConfig {
  const c1 = loadA1(env)
  const c2 = loadA2(env)
  const secrets = [...new Set([...secretsA1(c1), ...secretsA2(c2)])]
  return { c1, c2, supabaseUrl: c2.supabaseUrl, serviceKey: c2.serviceKey, secrets }
}

export function orchReadiness(c: OrchConfig) {
  return { agent1: readyA1(c.c1), agent2: readyA2(c.c2) }
}
