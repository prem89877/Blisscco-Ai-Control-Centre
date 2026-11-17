import test from 'node:test'
import assert from 'node:assert/strict'
import { parseProjects, projectList, resolveProject, type Config } from './config.js'

const DEF = 'abcdefghijklmnopqrst'
const TEST = 'tttttttttttttttttttt'
const PROD = 'pppppppppppppppppppp'
const cfg = (list?: string, ref = DEF) => ({ supabaseRef: ref, supabaseProjects: parseProjects(list, ref) }) as unknown as Config

test('projects: default is always first and allowed; labels and bare refs parse', () => {
  const l = parseProjects(`test=${TEST}, prod=${PROD}, bad=XX, ${DEF}`, DEF)
  assert.deepEqual(l.map(x => x.label), ['default', 'test', 'prod'])
  assert.equal(l[0].ref, DEF)
  assert.equal(parseProjects(`mine=${DEF}`, DEF)[0].label, 'mine')
  assert.deepEqual(parseProjects('', DEF), [{ ref: DEF, label: 'default' }])
})

test('projects: only allow-listed refs can be used; empty means the default', () => {
  const c = cfg(`test=${TEST}`)
  assert.equal(resolveProject(c).ref, DEF)
  assert.equal(resolveProject(c, TEST).label, 'test')
  assert.equal(resolveProject(c, TEST.toUpperCase()).ref, TEST)
  assert.throws(() => resolveProject(c, PROD), (e: any) => e.code === 'project_not_allowed')
  assert.throws(() => resolveProject(c, 'zzzzzzzzzzzzzzzzzzzz'), (e: any) => e.code === 'project_not_allowed')
  assert.throws(() => resolveProject({ supabaseRef: '' } as unknown as Config), (e: any) => e.code === 'project_not_allowed')
})

test('projects: a config without a list still works with the single default (older callers)', () => {
  const c = { supabaseRef: 'abcdref' } as unknown as Config
  assert.deepEqual(projectList(c), [{ ref: 'abcdref', label: 'default' }])
  assert.equal(resolveProject(c).ref, 'abcdref')
})
