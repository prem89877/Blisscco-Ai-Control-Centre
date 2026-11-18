import test from 'node:test'
import assert from 'node:assert/strict'
import { GitHub } from './github.js'

test('Agent 3 lists branches and encodes slash-containing branch refs', async () => {
  const original = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: any) => {
    const url = String(input); urls.push(url)
    if (url.endsWith('/repos/o/r')) return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 })
    if (url.includes('/branches?')) return new Response(JSON.stringify([{ name: 'main', commit: { sha: 'a'.repeat(40) } }, { name: 'feature/ui', commit: { sha: 'b'.repeat(40) } }]), { status: 200 })
    if (url.includes('/git/ref/heads/feature/ui')) return new Response(JSON.stringify({ object: { sha: 'b'.repeat(40) } }), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as any
  try {
    const gh = new GitHub({ githubToken: 'mock', githubRepos: ['o/r'] } as any, {})
    const rows = await gh.branches('o/r')
    assert.equal(rows[1].name, 'feature/ui')
    assert.equal(await gh.branchSha('o/r', 'feature/ui'), 'b'.repeat(40))
    assert.ok(urls.some(x => x.includes('/git/ref/heads/feature/ui')))
  } finally { globalThis.fetch = original }
})
