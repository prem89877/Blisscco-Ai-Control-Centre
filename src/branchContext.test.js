import test from 'node:test'
import assert from 'node:assert/strict'
import { scopeParams, reconcileSelection, saveSelection, loadSelection, clearSelection, setActiveRepo, getActiveRepo, GITHUB_ACTIONS } from './branchContext.js'

const mem = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) } }
const SHA1 = 'a'.repeat(40), SHA2 = 'b'.repeat(40)
const LIST = [{ name: 'main', default: true, sha: SHA1 }, { name: 'feature/ui', default: false, sha: SHA2 }]

test('default branch is pre-selected only when nothing was remembered', () => {
  assert.deepEqual(reconcileSelection(LIST, {}).branch, 'main')
  assert.equal(reconcileSelection(LIST, { branch: 'feature/ui', sha: SHA2 }).branch, 'feature/ui')
})
test('manual selection with "/" in the name is remembered per agent+repo', () => {
  const s = mem(); saveSelection('agent2', 'o/r', 'feature/ui', SHA2, s)
  assert.equal(loadSelection('agent2', 'o/r', s).branch, 'feature/ui')
  assert.equal(loadSelection('agent3', 'o/r', s).branch, undefined)
  assert.equal(loadSelection('agent2', 'o/other', s).branch, undefined)
})
test('refresh picks up a moved SHA and flags it', () => {
  const r = reconcileSelection(LIST, { branch: 'feature/ui', sha: 'c'.repeat(40) })
  assert.equal(r.sha, SHA2); assert.equal(r.changed, true)
})
test('deleted branch: nothing selected, error shown, saved value cleared, NO fallback to default', () => {
  const r = reconcileSelection(LIST, { branch: 'gone', sha: SHA1 })
  assert.equal(r.branch, ''); assert.equal(r.clear, true); assert.match(r.error, /no longer exists/)
  const s = mem(); saveSelection('agent1', 'o/r', 'gone', SHA1, s); clearSelection('agent1', 'o/r', s)
  assert.throws(() => scopeParams('agent1', 'github_status', { repo: 'o/r' }, s), /Select a valid GitHub branch/)
})
test('empty branch list gives an empty state and no selection', () => {
  const r = reconcileSelection([], {}); assert.equal(r.branch, ''); assert.match(r.error, /No branches/)
})
test('every GitHub action carries repo + branch + SHA and the server-enforcement flag', () => {
  const s = mem(); setActiveRepo('agent3', 'o/r', s); saveSelection('agent3', 'o/r', 'feature/ui', SHA2, s)
  const p = scopeParams('agent3', 'security_scan', {}, s)
  assert.equal(p.repo, 'o/r'); assert.equal(p.branch, 'feature/ui'); assert.equal(p.branch_sha, SHA2); assert.equal(p.branch_context_required, true)
  assert.equal(getActiveRepo('agent3', s), 'o/r')
})
test('non-GitHub actions are untouched and never blocked by a missing branch', () => {
  const s = mem()
  assert.deepEqual(scopeParams('agent1', 'vercel_status', { project: 'x' }, s), { project: 'x' })
  assert.deepEqual(scopeParams('agent3', 'website_smoke', {}, s), {})
  assert.deepEqual(scopeParams('agent1', 'heartbeat', {}, s), {})
})
test('explicit repo param wins over the active repo and uses ITS saved branch', () => {
  const s = mem(); setActiveRepo('agent1', 'o/a', s); saveSelection('agent1', 'o/a', 'main', SHA1, s); saveSelection('agent1', 'o/b', 'dev', SHA2, s)
  const p = scopeParams('agent1', 'github_status', { repo: 'o/b' }, s)
  assert.equal(p.repo, 'o/b'); assert.equal(p.branch, 'dev'); assert.equal(p.branch_sha, SHA2)
})
test('Agent 2: selected base is sent as base/ref, working branch is never defaulted for promote', () => {
  const s = mem(); setActiveRepo('agent2', 'o/r', s); saveSelection('agent2', 'o/r', 'develop', SHA2, s)
  const c = scopeParams('agent2', 'propose_change', { title: 't' }, s)
  assert.equal(c.base, 'develop'); assert.equal(c.expected_base_sha, SHA2); assert.equal(c.ref, 'develop')
  const pr = scopeParams('agent2', 'request_promote', { branch: 'agent2/x' }, s)
  assert.equal(pr.branch, 'agent2/x'); assert.equal(pr.base, 'develop'); assert.equal(pr.branch_sha, undefined)
  assert.equal(scopeParams('agent2', 'request_promote', { branch: '' }, s).branch, '') // stays empty -> server guard rejects, no silent main
})
test('GitHub action tables exist for all three agents', () => { for (const a of ['agent1', 'agent2', 'agent3']) assert.ok(GITHUB_ACTIONS[a].length) })
