import type { Config } from './config.js'
import { makeCtx, runAction, QUEUEABLE, type Actor } from './agent.js'
import { Store } from './store.js'
import type { ExecFn } from './local.js'
import { errMsg, redact } from './util.js'
import { secretValues } from './config.js'

// Runs tasks that the owner queued from the dashboard. Only the six read-only tests can be queued;
// anything else in the queue is ignored. Each task is claimed atomically, so two workers never run the same one.
export async function workOnce(cfg: Config, actor: Actor = { type: 'system', id: null }, log: (s: string) => void = () => {}, exec?: ExecFn): Promise<number> {
  const store = new Store(cfg)
  let done = 0
  for (const t of await store.queuedTasks()) {
    const pl = t.payload
    if (!pl || pl.runner !== 'termux' || ![...QUEUEABLE, 'local_check', 'local_command'].includes(pl.action)) continue
    if (!(await store.claimTask(t.id))) continue
    log(`running ${pl.action} (${t.id})`)
    const ctx = makeCtx(cfg, actor)
    ctx.adopt = t.id; ctx.worker = true; ctx.exec = exec
    const params = pl.action === 'local_check' ? { presets: pl.presets } : pl.action === 'local_command' ? { approval_id: pl.approval_id } : { target: pl.target, repo: pl.repo || undefined, ...(pl.branch ? { branch: pl.branch, branch_sha: pl.branch_sha || undefined, branch_context_required: true } : {}) }
    try { await runAction(ctx, pl.action, params) }
    catch (e) {
      const cur = await store.getTask(t.id)
      if (cur && cur.status === 'running') {
        const msg = redact(errMsg(e), secretValues(cfg)) as string
        await store.updateTask(t.id, { status: 'failed', error_message: msg, finished_at: new Date().toISOString() })
        await store.log('error', 'agent3_queue_failed', msg, {}, t.id, null)
      }
      log('failed: ' + errMsg(e))
    }
    done++
  }
  return done
}
