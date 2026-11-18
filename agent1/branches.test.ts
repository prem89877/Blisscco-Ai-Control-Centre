import test from 'node:test'
import assert from 'node:assert/strict'
import { GitHub } from './github.js'

test('Agent 1 retrieves paginated branches and identifies default branch', async () => {
  const original = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: any) => {
    const url = String(input); urls.push(url)
    if (url.endsWith('/repos/o/r')) return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 })
    if (url.includes('/branches?per_page=100&page=1')) return new Response(JSON.stringify([{ name: 'main', commit: { sha: 'a'.repeat(40) } }, { name: 'feature/ui', commit: { sha: 'b'.repeat(40) } }]), { status: 200 })
    return new Response('[]', { status: 200 })
  }) as any
  try {
    const gh = new GitHub({ githubToken: 'mock' } as any, {})
    const rows = await gh.branches('o/r')
    assert.equal(rows.length, 2)
    assert.equal(rows[0].default, true)
    assert.equal(rows[1].name, 'feature/ui')
    assert.ok(urls.some(x => x.includes('page=1')))
  } finally { globalThis.fetch = original }
})
