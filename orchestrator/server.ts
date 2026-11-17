import { loadOrchConfig } from './config.js'
import { AgentError, errMsg, redactString } from '../agent2/util.js'
import { makeOCtx, runAction } from './workflow.js'
import { OStore } from './store.js'

export interface Req { method?: string; headers: Record<string, string | string[] | undefined>; body?: unknown }
export interface Res { status: number; body: unknown }

export async function handleRequest(req: Req, env: Record<string, string | undefined> = process.env): Promise<Res> {
  if (req.method !== 'POST') return { status: 405, body: { error: 'Method not allowed' } }
  let secrets: string[] = []
  try {
    const cfg = loadOrchConfig(env)
    secrets = cfg.secrets
    const h = req.headers.authorization
    const token = String(Array.isArray(h) ? h[0] : h || '').replace(/^Bearer /, '')
    if (!token) throw new AgentError('Unauthorized', 401, 'unauthorized')
    const userId = await new OStore(cfg).verifyOwner(token) // same owner allow-list as Agent 1 / 2
    let body: any = req.body
    if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }
    const data = await runAction(makeOCtx(cfg, userId), String(body && body.action || ''), (body && body.params) || {})
    return { status: 200, body: { ok: true, ...data } }
  } catch (e) {
    const status = e instanceof AgentError ? e.status : 500
    return { status, body: { error: redactString(status === 500 && !(e instanceof AgentError) ? 'Internal error' : errMsg(e), secrets), code: e instanceof AgentError ? e.code : 'internal', workflow_id: (e as any).workflowId } }
  }
}
