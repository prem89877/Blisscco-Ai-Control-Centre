import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { repoAllowed, secretValues } from './config.js'
import { AgentError, b64, errMsg, redactString } from './util.js'
import { assertAgentBranch, branchFor, classifyCommand, isSafeScript, minimalEnv, scanSecrets, sha256, tokenize, validateFiles, validatePath, type FileIn } from './guard.js'
import { claim, loadApproved, monitor, now, recordAi, release, withTask, type Ctx, type Out } from './agent.js'
import { review } from './gemini.js'

// Termux-only actions: real git + shell on the device. This file is never imported by the Vercel function.
export const LOCAL_ACTIONS = ['local_inspect', 'local_apply', 'local_checks', 'exec', 'apply_command', 'local_commit', 'request_push', 'apply_push', 'local_rollback'] as const

interface RunRes { code: number; out: string; ms: number; timedOut: boolean }
const OUT_CAP = 200_000

function run(cmd: string, args: string[], o: { cwd: string; timeoutMs?: number; env?: Record<string, string> }): Promise<RunRes> {
  return new Promise(res => {
    const t0 = Date.now()
    let out = ''
    let timedOut = false
    // No shell, ever: arguments are passed as an array, so nothing can be injected.
    const ch = spawn(cmd, args, { cwd: o.cwd, env: minimalEnv(o.env), shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    const add = (b: Buffer) => { if (out.length < OUT_CAP) out += b.toString('utf8') }
    ch.stdout.on('data', add); ch.stderr.on('data', add)
    const timer = setTimeout(() => { timedOut = true; ch.kill('SIGKILL') }, o.timeoutMs || 120_000)
    ch.on('error', e => { clearTimeout(timer); res({ code: 127, out: out + String(e.message), ms: Date.now() - t0, timedOut }) })
    ch.on('close', code => { clearTimeout(timer); res({ code: code ?? 1, out, ms: Date.now() - t0, timedOut }) })
  })
}

const tail = (ctx: Ctx, s: string, n = 30) => redactString(s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trimEnd().split('\n').slice(-n).join('\n'), secretValues(ctx.cfg)).slice(-4000)

async function git(root: string, args: string[], timeoutMs = 60_000): Promise<RunRes> { return run('git', args, { cwd: root, timeoutMs }) }
async function gitOk(root: string, args: string[]): Promise<string> {
  const r = await git(root, args)
  if (r.code !== 0) throw new AgentError(`git ${args[0]} failed: ${r.out.trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`, 409, 'git_failed')
  return r.out.trim()
}

async function repoRoot(ctx: Ctx): Promise<string> {
  const r = await git(resolve(ctx.cfg.workdir), ['rev-parse', '--show-toplevel'])
  if (r.code !== 0) throw new AgentError('AGENT2_WORKDIR is not a git repository: ' + ctx.cfg.workdir, 400, 'not_git')
  const root = realpathSync(r.out.trim())
  const ex = join(root, '.git', 'info', 'exclude')
  try { if (existsSync(dirname(ex)) && !(existsSync(ex) && readFileSync(ex, 'utf8').includes('.agent2/'))) appendFileSync(ex, '\n.agent2/\n') } catch { /* optional */ }
  return root
}

// Resolves a repo-relative path and proves it stays inside the repo (also against symlinks).
function safeJoin(root: string, rel: string): string {
  const p = validatePath(rel)
  const full = resolve(root, p)
  if (!full.startsWith(root + sep)) throw new AgentError('Path escapes the repository: ' + p, 403, 'bad_path')
  let probe = dirname(full)
  while (!existsSync(probe) && probe.length > root.length) probe = dirname(probe)
  const real = realpathSync(probe)
  if (real !== root && !real.startsWith(root + sep)) throw new AgentError('Path escapes the repository via a link: ' + p, 403, 'bad_path')
  if (existsSync(full) && lstatSync(full).isSymbolicLink()) throw new AgentError('Refusing to write through a symlink: ' + p, 403, 'bad_path')
  return full
}

const manifestPath = (root: string, branch: string) => join(root, '.agent2', 'changes', branch.replace(/\//g, '__') + '.json')
function readManifest(root: string, branch: string): any {
  const f = manifestPath(root, branch)
  if (!existsSync(f)) throw new AgentError('No Agent 2 change record for ' + branch + ' (it was not created by local-apply)', 404, 'no_record')
  return JSON.parse(readFileSync(f, 'utf8'))
}
function writeManifest(root: string, m: any) {
  const f = manifestPath(root, m.branch)
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, JSON.stringify(m, null, 2))
}

const curBranch = async (root: string) => gitOk(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
const curSha = async (root: string) => gitOk(root, ['rev-parse', 'HEAD'])
const dirty = async (root: string) => {
  const r = await git(root, ['status', '--porcelain']) // not trimmed: the first column can be a space
  if (r.code !== 0) throw new AgentError('git status failed', 409, 'git_failed')
  return r.out.split('\n').filter(Boolean).map(l => l.slice(3).replace(/^"|"$/g, ''))
}

export function parseGithubRepo(url: string): string | null {
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m ? m[1] + '/' + m[2] : null
}
async function originRepo(ctx: Ctx, root: string): Promise<string> {
  const url = await gitOk(root, ['config', '--get', 'remote.origin.url']).catch(() => '') // raw value, not rewritten by insteadOf
  const repo = parseGithubRepo(url)
  if (!repo) throw new AgentError('origin is not a GitHub repository', 400, 'bad_remote')
  if (!repoAllowed(ctx.cfg, repo)) throw new AgentError('Repo is not in AGENT2_GITHUB_REPOS: ' + repo, 403, 'repo_not_allowed')
  return repo
}

// ---------------------------------------------------------------- inspect
async function localInspect(ctx: Ctx, p: any): Promise<Out> {
  const root = await repoRoot(ctx)
  if (p.path) {
    const full = safeJoin(root, String(p.path))
    if (!existsSync(full)) throw new AgentError('Not found: ' + p.path, 404, 'not_found')
    const text = readFileSync(full, 'utf8')
    return { result: { path: p.path, bytes: Buffer.byteLength(text), content: redactString(text.slice(0, 60_000), secretValues(ctx.cfg)), truncated: text.length > 60_000 } }
  }
  const files = (await gitOk(root, ['ls-files'])).split('\n').filter(Boolean)
  const top = new Map<string, number>()
  for (const f of files) { const k = f.includes('/') ? f.split('/')[0] + '/' : f; top.set(k, (top.get(k) || 0) + 1) }
  const changes = existsSync(join(root, '.agent2', 'changes')) ? (await run('ls', [join(root, '.agent2', 'changes')], { cwd: root })).out.split('\n').filter(Boolean) : []
  return { result: { root: root.split(sep).pop(), branch: await curBranch(root), head: (await curSha(root)).slice(0, 7), uncommitted: (await dirty(root)).slice(0, 100), file_count: files.length, top_level: [...top.entries()].map(([name, n]) => ({ name, files: n })).slice(0, 80), agent2_changes: changes, recent: (await gitOk(root, ['log', '--oneline', '-5'])).split('\n') } }
}

// ---------------------------------------------------------------- apply a change set on a new local branch
async function localApply(ctx: Ctx, p: any): Promise<any> {
  const title = String((p.changes && p.changes.title) || p.title || '').trim().slice(0, 120)
  if (!title) throw new AgentError('title is required', 400)
  const files: FileIn[] = validateFiles((p.changes && p.changes.files) || p.files)
  return withTask(ctx, 'local_apply', 'Local change: ' + title, { title, paths: files.map(f => f.path) }, async () => {
    const root = await repoRoot(ctx)
    const d = await dirty(root)
    if (d.length) throw new AgentError('Working tree has uncommitted changes (' + d.slice(0, 5).join(', ') + '). Commit or stash them first: Agent 2 will not mix its work with yours.', 409, 'dirty_tree')
    const tracked = new Set((await gitOk(root, ['ls-files'])).split('\n'))
    for (const f of files) {
      const full = safeJoin(root, f.path)
      if (f.op === 'create' && (existsSync(full) || tracked.has(f.path))) throw new AgentError(`${f.path} already exists. Use op "update" so nothing is overwritten by accident.`, 409, 'exists')
      if (f.op !== 'create' && !tracked.has(f.path)) throw new AgentError(`${f.path} is not a tracked file in this repo`, 404, 'not_found')
    }
    const baseBranch = await curBranch(root)
    const baseSha = await curSha(root)
    const branch = branchFor(title)
    assertAgentBranch(branch, ctx.cfg.protectedBranches)
    await gitOk(root, ['checkout', '-b', branch])
    const written: string[] = []
    try {
      for (const f of files) {
        const full = safeJoin(root, f.path)
        if (f.op === 'delete') unlinkSync(full)
        else { mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, f.content as string) }
        written.push(f.path)
      }
    } catch (e) {
      // undo everything this call did
      await git(root, ['checkout', '--', ...written.filter(w => tracked.has(w))])
      for (const w of written) if (!tracked.has(w)) { try { unlinkSync(join(root, w)) } catch { /* ignore */ } }
      await git(root, ['checkout', baseBranch]); await git(root, ['branch', '-D', branch])
      throw e
    }
    writeManifest(root, { id: sha256(branch + baseSha).slice(0, 12), branch, base_branch: baseBranch, base_sha: baseSha, title, created_at: now(), pushed: false, commit_sha: null, files: files.map(f => ({ path: f.path, op: f.op })) })
    const stat = await gitOk(root, ['diff', '--stat'])
    const diff = (await git(root, ['diff'])).out
    return { result: { branch, base: `${baseBranch}@${baseSha.slice(0, 7)}`, changed_files: files.map(f => ({ path: f.path, op: f.op })), stat, diff: tail(ctx, diff, 200), next: 'npm run agent2 -- checks   then   npm run agent2 -- commit --message="..."', production_touched: false, rollback: 'npm run agent2 -- local-rollback' } }
  })
}

// ---------------------------------------------------------------- checks (lint / types / tests)
async function localChecks(ctx: Ctx, p: any): Promise<any> {
  return withTask(ctx, 'local_checks', 'Run lint, type check and tests', { only: p.only || null }, async () => {
    const root = await repoRoot(ctx)
    const branch = await curBranch(root)
    const pkgFile = join(root, 'package.json')
    const pkg = existsSync(pkgFile) ? JSON.parse(readFileSync(pkgFile, 'utf8')) : {}
    const scripts: Record<string, string> = pkg.scripts || {}
    // package.json scripts are code. If this branch changed them, running them needs your explicit OK.
    if (/^agent2\//.test(branch)) {
      let m: any = null
      try { m = readManifest(root, branch) } catch { /* not an Agent 2 branch record */ }
      if (m) {
        const changed = (await git(root, ['diff', m.base_sha, '--', 'package.json', '.npmrc'])).out.trim()
        if (changed && p.ack !== 'RUN-CHANGED-SCRIPTS') throw new AgentError('package.json changed on this branch, so its scripts are new code. Review the diff, then re-run with --ack=RUN-CHANGED-SCRIPTS', 403, 'scripts_changed')
      }
    }
    const only: string[] | null = p.only ? String(p.only).split(',').map(s => s.trim()) : null
    const plan: { name: string; cmd: string; args: string[] }[] = []
    const skipped: string[] = []
    for (const n of ['lint', 'typecheck', 'type-check', 'test', 'build']) {
      if (only && !only.includes(n)) continue
      if (scripts[n] && isSafeScript(n)) plan.push({ name: n, cmd: 'npm', args: n === 'test' ? ['test'] : ['run', n] })
    }
    const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
    const hasTypeScript = existsSync(join(root, 'tsconfig.json'))
    if (!scripts.typecheck && !scripts['type-check'] && hasTypeScript && existsSync(tsc) && (!only || only.includes('typecheck'))) plan.push({ name: 'typecheck', cmd: 'node', args: [tsc, '--noEmit'] })
    for (const n of ['lint', 'typecheck', 'test']) if (!plan.some(x => x.name === n || (n === 'typecheck' && x.name === 'type-check')) && (!only || only.includes(n))) skipped.push(n + ' (no script found)')
    // JSON files changed on this branch must still parse
    const checks: any[] = []
    if (/^agent2\//.test(branch)) {
      try {
        const m = readManifest(root, branch)
        for (const f of m.files.filter((x: any) => x.op !== 'delete' && x.path.endsWith('.json'))) {
          let ok = true, msg = ''
          try { JSON.parse(readFileSync(join(root, f.path), 'utf8')) } catch (e) { ok = false; msg = errMsg(e) }
          checks.push({ name: 'json:' + f.path, ok, code: ok ? 0 : 1, ms: 0, tail: msg })
        }
      } catch { /* none */ }
    }
    if (!existsSync(join(root, 'node_modules')) && plan.length) skipped.push('node_modules missing: run `npm install` first (needs your approval via exec)')
    else for (const c of plan) {
      const r = await run(c.cmd, c.args, { cwd: root, timeoutMs: 300_000 })
      checks.push({ name: c.name, cmd: [c.cmd, ...c.args].join(' ').replace(root, '.'), ok: r.code === 0 && !r.timedOut, code: r.code, ms: r.ms, timed_out: r.timedOut || undefined, tail: tail(ctx, r.out) })
    }
    const passed = checks.length > 0 && checks.every(c => c.ok)
    const result = { branch, passed, checks, skipped, note: checks.length ? undefined : 'No checks could run. Nothing was verified.' }
    return { result }
  })
}

// ---------------------------------------------------------------- arbitrary command: safe -> runs, risky -> approval, dangerous -> blocked
async function execCommand(ctx: Ctx, p: any): Promise<any> {
  const argv = tokenize(String(p.command || ''))
  const cls = classifyCommand(argv)
  const cmd = argv.join(' ')
  if (cls.level === 'blocked') {
    await ctx.store.log('warn', 'agent2_command_blocked', cmd.slice(0, 200), { reason: cls.reason }, null, ctx.actor.id)
    throw new AgentError('Blocked: ' + cls.reason, 403, 'command_blocked')
  }
  if (cls.level === 'safe') {
    return withTask(ctx, 'exec', 'Run: ' + cmd.slice(0, 80), { command: cmd, level: 'safe' }, async () => {
      const root = await repoRoot(ctx)
      const r = await run(argv[0], argv.slice(1), { cwd: root, timeoutMs: 120_000 })
      return { result: { command: cmd, level: 'safe', exit_code: r.code, ms: r.ms, output: tail(ctx, r.out, 80) } }
    })
  }
  return withTask(ctx, 'exec', 'Command needs approval: ' + cmd.slice(0, 80), { command: cmd, level: 'approval' }, async taskId => {
    const ap = await ctx.store.createApproval({ task_id: taskId, title: 'Run command: ' + cmd.slice(0, 100), details: { kind: 'command', argv, cmd, cmd_hash: sha256(argv.join('\0')), reason: cls.reason, cwd: 'repo root', note: 'Runs exactly this program with these arguments (no shell) inside the repo folder, with no secrets in its environment. 2 minute limit.' } })
    await ctx.store.log('warn', 'agent2_approval_requested', 'Command: ' + cmd.slice(0, 100), { approval_id: ap.id }, taskId, ctx.actor.id)
    return { status: 'awaiting_approval', result: { approval_id: ap.id, command: cmd, why: cls.reason, next: 'Approve in the Approvals tab, then: npm run agent2 -- apply-command --approval=' + ap.id } }
  })
}

async function applyCommand(ctx: Ctx, p: any): Promise<any> {
  const { ap, d } = await loadApproved(ctx, p.approval_id, 'command')
  const argv: string[] = d.argv
  if (!Array.isArray(argv) || sha256(argv.join('\0')) !== d.cmd_hash) throw new AgentError('Approved command was altered; request again', 409, 'content_mismatch')
  if (classifyCommand(argv).level === 'blocked') throw new AgentError('Command is blocked by policy', 403, 'command_blocked')
  return withTask(ctx, 'apply_command', 'Apply: ' + ap.title, { approval_id: ap.id }, async () => {
    await claim(ctx, ap, d)
    try {
      const root = await repoRoot(ctx)
      const r = await run(argv[0], argv.slice(1), { cwd: root, timeoutMs: 120_000 })
      await ctx.store.patchApproval(ap.id, { details: { ...d, executed_at: now(), executed_by: ctx.actor.id, exit_code: r.code } })
      await ctx.store.log(r.code === 0 ? 'success' : 'warn', 'agent2_command_run', d.cmd, { approval_id: ap.id, exit_code: r.code }, null, ctx.actor.id)
      return { result: { command: d.cmd, exit_code: r.code, ms: r.ms, timed_out: r.timedOut || undefined, output: tail(ctx, r.out, 80) } }
    } catch (e) { await release(ctx, ap, d, e); throw e }
  })
}

// ---------------------------------------------------------------- commit (only the files of this change, secrets scanned)
async function localCommit(ctx: Ctx, p: any): Promise<any> {
  const message = String(p.message || '').trim().slice(0, 300)
  if (!message) throw new AgentError('--message is required', 400)
  return withTask(ctx, 'local_commit', 'Commit: ' + message.slice(0, 80), {}, async () => {
    const root = await repoRoot(ctx)
    const branch = await curBranch(root)
    assertAgentBranch(branch, ctx.cfg.protectedBranches)
    const m = readManifest(root, branch)
    const paths: string[] = m.files.map((f: any) => f.path)
    await gitOk(root, ['add', '--', ...paths])
    const staged = (await gitOk(root, ['diff', '--cached', '--name-only'])).split('\n').filter(Boolean)
    const unstage = () => git(root, ['reset', '-q', '--', ...paths])
    const extra = staged.filter(s => !paths.includes(s))
    if (extra.length) { await unstage(); throw new AgentError('Other files were already staged (' + extra.slice(0, 5).join(', ') + '). Unstage them first; nothing was committed.', 409, 'extra_staged') }
    if (!staged.length) throw new AgentError('Nothing to commit', 400, 'no_change')
    const diff = (await git(root, ['diff', '--cached', '-U0'])).out
    const hits = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).flatMap((l, i) => scanSecrets(l).map(h => `${h.rule} (added line ${i + 1})`))
    if (hits.length) { await unstage(); throw new AgentError('Possible secrets in the staged change; nothing was committed: ' + hits.slice(0, 6).join(', '), 422, 'secret_detected') }
    const hasName = (await git(root, ['config', 'user.name'])).out.trim()
    const ident = hasName ? [] : ['-c', 'user.name=Blisscco Agent 2', '-c', 'user.email=agent2@users.noreply.github.com']
    await gitOk(root, [...ident, 'commit', '-q', '-m', message])
    const sha = await curSha(root)
    writeManifest(root, { ...m, commit_sha: sha })
    return { result: { branch, commit: sha.slice(0, 7), files: staged, next: 'npm run agent2 -- request-push' } }
  })
}

// ---------------------------------------------------------------- push (approval gated, agent branches only)
async function requestPush(ctx: Ctx, p: any): Promise<any> {
  return withTask(ctx, 'request_push', 'Request push', {}, async taskId => {
    const root = await repoRoot(ctx)
    const branch = String(p.branch || await curBranch(root))
    assertAgentBranch(branch, ctx.cfg.protectedBranches)
    const m = readManifest(root, branch)
    if ((await dirty(root)).some(f => m.files.some((x: any) => x.path === f))) throw new AgentError('Uncommitted changes in this change set. Run commit first.', 409, 'dirty_tree')
    const head = await gitOk(root, ['rev-parse', 'refs/heads/' + branch])
    if (head === m.base_sha) throw new AgentError('Branch has no new commits to push', 400, 'no_change')
    const repo = await originRepo(ctx, root)
    const stat = await gitOk(root, ['diff', '--stat', `${m.base_sha}..${head}`])
    const patch = (await git(root, ['diff', `${m.base_sha}..${head}`])).out
    const ai = await review(ctx.cfg, { title: m.title, files: m.files, patch: patch.slice(0, 9000) })
    await recordAi(ctx, 'request_push_review', ai)
    const title = `Push ${branch} to ${repo}`
    const ap = await ctx.store.createApproval({ task_id: taskId, title, details: { kind: 'git_push', repo, branch, head_sha: head, base_branch: m.base_branch, base_sha: m.base_sha, files: m.files, diffstat: stat.slice(-1500), ai_review: ai.text, production: false, note: 'Pushes this branch only (no force). ' + m.base_branch + ' is not touched; Vercel will build a preview.' } })
    await ctx.store.log('warn', 'agent2_approval_requested', title, { approval_id: ap.id }, taskId, ctx.actor.id)
    return { status: 'awaiting_approval', result: { approval_id: ap.id, repo, branch, commit: head.slice(0, 7), diffstat: stat, ai_review: ai.text, ai_note: ai.text ? undefined : ai.error, next: 'Approve in the Approvals tab, then: npm run agent2 -- apply-push --approval=' + ap.id } }
  })
}

async function applyPush(ctx: Ctx, p: any): Promise<any> {
  const { ap, d } = await loadApproved(ctx, p.approval_id, 'git_push')
  assertAgentBranch(d.branch, ctx.cfg.protectedBranches)
  if (!ctx.cfg.githubToken) throw new AgentError('AGENT2_GITHUB_TOKEN is not set', 503, 'not_configured')
  return withTask(ctx, 'apply_push', 'Apply: ' + ap.title, { approval_id: ap.id, branch: d.branch }, async () => {
    const root = await repoRoot(ctx)
    const repo = await originRepo(ctx, root)
    if (repo.toLowerCase() !== String(d.repo).toLowerCase()) throw new AgentError('origin changed since approval', 409, 'origin_changed')
    const head = await gitOk(root, ['rev-parse', 'refs/heads/' + d.branch])
    if (head !== d.head_sha) throw new AgentError('Branch changed after approval; request the push again', 409, 'head_moved')
    await claim(ctx, ap, d)
    try {
      // Token travels in the child's environment only (never in argv or the remote URL), and push is never forced.
      const header = 'AUTHORIZATION: basic ' + b64('x-access-token:' + ctx.cfg.githubToken)
      const r = await run('git', ['push', `https://github.com/${d.repo}.git`, `refs/heads/${d.branch}:refs/heads/${d.branch}`], { cwd: root, timeoutMs: 120_000, env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: header } })
      if (r.code !== 0) throw new AgentError('git push failed: ' + tail(ctx, r.out, 4).replace(/\n/g, ' | '), 502, 'push_failed')
      try { const m = readManifest(root, d.branch); writeManifest(root, { ...m, pushed: true }) } catch { /* ignore */ }
      await ctx.store.patchApproval(ap.id, { details: { ...d, executed_at: now(), executed_by: ctx.actor.id } })
      await ctx.store.log('success', 'agent2_branch_pushed', `${d.repo} ${d.branch}`, { approval_id: ap.id, commit: head }, null, ctx.actor.id)
      await new Promise(r2 => setTimeout(r2, Number(p.wait_ms ?? 6000)))
      const mon = await monitor(ctx, d.repo, d.branch).catch(() => null)
      return { result: { pushed: true, repo: d.repo, branch: d.branch, commit: head.slice(0, 7), compare_url: `https://github.com/${d.repo}/compare/${d.base_branch}...${d.branch}`, ci: mon ? mon.overall : 'unknown', ci_runs: mon ? mon.runs : [], deployments: mon ? mon.deployments : [], deployment_trigger: mon && (mon.runs.length || mon.deployments.length) ? 'triggered (see ci_runs / deployments)' : 'not seen yet; run: npm run agent2 -- monitor --repo=' + d.repo + ' --branch=' + d.branch, production_touched: false, rollback: 'npm run agent2 -- request-rollback --repo=' + d.repo + ' --branch=' + d.branch } }
    } catch (e) { await release(ctx, ap, d, e); throw e }
  })
}

// ---------------------------------------------------------------- local rollback
async function localRollback(ctx: Ctx, p: any): Promise<any> {
  return withTask(ctx, 'local_rollback', 'Local rollback', {}, async () => {
    const root = await repoRoot(ctx)
    const here = await curBranch(root)
    const branch = String(p.branch || here)
    assertAgentBranch(branch, ctx.cfg.protectedBranches)
    const m = readManifest(root, branch)
    const paths: string[] = m.files.map((f: any) => f.path)
    const other = (await dirty(root)).filter(f => !paths.includes(f))
    if (other.length) throw new AgentError('You have other uncommitted changes (' + other.slice(0, 5).join(', ') + '); rollback would not be safe. Commit or stash them first.', 409, 'dirty_tree')
    if (here === branch) {
      const tracked = new Set((await gitOk(root, ['ls-files'])).split('\n'))
      const restorable = paths.filter(x => tracked.has(x))
      if (restorable.length) await git(root, ['checkout', '--', ...restorable])
      for (const x of paths) if (!tracked.has(x)) { const f = safeJoin(root, x); if (existsSync(f)) unlinkSync(f) }
    }
    await gitOk(root, ['checkout', m.base_branch])
    await gitOk(root, ['branch', '-D', branch])
    try { unlinkSync(manifestPath(root, branch)) } catch { /* ignore */ }
    return { result: { rolled_back: true, branch_deleted: branch, now_on: m.base_branch, note: m.pushed ? 'This branch was pushed. Remove it on GitHub with: request-rollback --repo=<owner/name> --branch=' + branch : undefined } }
  })
}

export async function runLocal(ctx: Ctx, action: string, params: any = {}): Promise<any> {
  if (!(LOCAL_ACTIONS as readonly string[]).includes(action)) throw new AgentError('Unknown local action', 400, 'unknown_action')
  switch (action as typeof LOCAL_ACTIONS[number]) {
    case 'local_inspect': return withTask(ctx, action, 'Inspect local repository', { path: params.path || null }, () => localInspect(ctx, params))
    case 'local_apply': return localApply(ctx, params)
    case 'local_checks': return localChecks(ctx, params)
    case 'exec': return execCommand(ctx, params)
    case 'apply_command': return applyCommand(ctx, params)
    case 'local_commit': return localCommit(ctx, params)
    case 'request_push': return requestPush(ctx, params)
    case 'apply_push': return applyPush(ctx, params)
    case 'local_rollback': return localRollback(ctx, params)
  }
}

