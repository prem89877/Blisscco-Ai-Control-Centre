import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectZip } from './zip.js'

test('ZIP extracts a small UTF-8 code file and hashes it', () => {
  const r=inspectZip('UEsDBBQAAAAIAEMScV1D44UwGgAAABgAAAALAAAAc3JjL2RlbW8udHNLrSjILypRSM7PKy5RyM9WsFUoKSpNteYCAFBLAQIUAxQAAAAIAEMScV1D44UwGgAAABgAAAALAAAAAAAAAAAAAACAAQAAAABzcmMvZGVtby50c1BLBQYAAAAAAQABADkAAABDAAAAAAA=')
  assert.equal(r.entries.length,1)
  assert.equal(r.entries[0].path,'src/demo.ts')
  assert.equal(r.entries[0].content,'export const ok = true;\n')
  assert.match(r.entries[0].sha256,/^[a-f0-9]{64}$/)
})
test('ZIP traversal is rejected', () => {
  assert.throws(()=>inspectZip('UEsDBBQAAAAIAEMScV37OSuCBQAAAAMAAAALAAAALi4vZXZpbC50eHRLSkwBAFBLAQIUAxQAAAAIAEMScV37OSuCBQAAAAMAAAALAAAAAAAAAAAAAACAAQAAAAAuLi9ldmlsLnR4dFBLBQYAAAAAAQABADkAAAAuAAAAAAA='),/Unsafe path|Path must be relative/)
})
test('ZIP secret scan blocks credentials', () => {
  assert.throws(()=>inspectZip('UEsDBBQAAAAIAEMScV1vD1ueJQAAAC8AAAANAAAAc3JjL2NvbmZpZy50c0vOzysuUUgsyIzPTq1UsFVQKs7WNTQyNjE1M7ewNEBlKVlzAQBQSwECFAMUAAAACABDEnFdbw9bniUAAAAvAAAADQAAAAAAAAAAAAAAgAEAAAAAc3JjL2NvbmZpZy50c1BLBQYAAAAAAQABADsAAABQAAAAAAA='),/Secret scan blocked/)
})

test('duplicate ZIP paths are rejected', () => {
  assert.throws(()=>inspectZip('UEsDBBQAAAAIALAScV2379yDAwAAAAEAAAAIAAAAc3JjL2EudHMzBABQSwMEFAAAAAgAsBJxXQ2+1RoDAAAAAQAAAAgAAABzcmMvYS50czMCAFBLAQIUAxQAAAAIALAScV2379yDAwAAAAEAAAAIAAAAAAAAAAAAAACAAQAAAABzcmMvYS50c1BLAQIUAxQAAAAIALAScV0NvtUaAwAAAAEAAAAIAAAAAAAAAAAAAACAASkAAABzcmMvYS50c1BLBQYAAAAAAgACAGwAAABSAAAAAAA='),/Duplicate ZIP path/)
})
test('unsupported file types are rejected', () => {
  assert.throws(()=>inspectZip('UEsDBBQAAAAIALAScV1v8c3NBgAAAAQAAAAJAAAAaW1hZ2UucG5nS0vMTgUAUEsBAhQDFAAAAAgAsBJxXW/xzc0GAAAABAAAAAkAAAAAAAAAAAAAAIABAAAAAGltYWdlLnBuZ1BLBQYAAAAAAQABADcAAAAtAAAAAAA='),/Unsupported file type/)
})
