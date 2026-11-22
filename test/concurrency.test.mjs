import assert from 'node:assert/strict'
import { mkdtempDisposableSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { PythonTasks } from '../server/python-tasks.mjs'

function fixture(options = {}) {
  const temp = mkdtempDisposableSync(join(tmpdir(), 'wb-concurrency-'))
  const file = join(temp.path, 'monitor.sqlite')
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys=ON')
  const manager = new PythonTasks(db, file, options)
  return { manager, db, file, cleanup: async () => { await manager.stopAll(); db.close(); temp.remove() } }
}

function makeTask(manager, index) {
  return manager.save({
    name: `并发 ${index}`,
    params: { CONV_ID: `conv-${index}`, UID: `user-${index}` },
    credentials: { JWT: `local-fake-jwt-${index}-0123456789` },
  })
}

test('默认不限制并发数量', async t => {
  const { manager, cleanup } = fixture()
  t.after(cleanup)
  assert.equal(manager.runAllowance(), Number.POSITIVE_INFINITY)
})

test('不限制时不会因为内存读数而拒绝启动', async t => {
  // 默认 freeMemory 恒为无限，任何内存读数都不参与判定
  const { manager, cleanup } = fixture()
  t.after(cleanup)
  for (let i = 0; i < 40; i++) makeTask(manager, i)
  assert.equal(manager.runAllowance(), Number.POSITIVE_INFINITY)
})

test('WB_MAX_RUNS 可设固定上限以限制同时运行数量', async t => {
  const { manager, cleanup } = fixture({ maxRuns: 12 })
  t.after(cleanup)
  assert.equal(manager.runAllowance(), 12)
  assert.ok(manager.runAllowance() > 4, '不再被旧的 4 份上限约束')
})

test('显式启用内存推算模式时按每次运行预算折算', async t => {
  const perRun = (512 + 8) * 1024 * 1024
  let free = perRun * 10
  const { manager, cleanup } = fixture({ maxRuns: 0, memoryCeilingMb: 512, freeMemory: () => free })
  t.after(cleanup)
  // 每次运行按 内存上限 + 8 MiB 计
  assert.equal(manager.runAllowance(), 10)
  free = perRun * 40
  assert.equal(manager.runAllowance(), 40)
})

test('内存紧张时至少允许一份，不会把平台锁死', async t => {
  const perRun = (512 + 8) * 1024 * 1024
  for (const free of [0, 1, perRun - 1]) {
    const { manager, cleanup } = fixture({ maxRuns: 0, memoryCeilingMb: 512, freeMemory: () => free })
    assert.equal(manager.runAllowance(), 1, `可用 ${free} 字节时应至少允许 1 份`)
    await cleanup()
  }
})

test('配置数量上限提升到 200', async t => {
  const { manager, cleanup } = fixture()
  t.after(cleanup)
  for (let i = 0; i < 200; i++) makeTask(manager, i)
  assert.equal(manager.list().length, 200)
  assert.throws(() => makeTask(manager, 200), /最多保存 200 份脚本配置/)
})

test('每个进程都有内存看门狗上限', async t => {
  const { manager, cleanup } = fixture({ memoryCeilingMb: 512 })
  t.after(cleanup)
  assert.equal(manager.memoryCeilingBytes, 512 * 1024 * 1024)
})

test('WB_MEMORY_CEILING_MB 与 WB_MAX_RUNS 的环境变量范围', async () => {
  const { readSettings } = await import('../server/config.mjs')
  assert.equal(readSettings({}).memoryCeilingMb, 512)
  assert.equal(readSettings({}).maxRuns, 0)
  assert.equal(readSettings({ WB_MAX_RUNS: '16' }).maxRuns, 16)
  assert.equal(readSettings({ WB_MEMORY_CEILING_MB: '1024' }).memoryCeilingMb, 1024)
  assert.throws(() => readSettings({ WB_MEMORY_CEILING_MB: '64' }), /WB_MEMORY_CEILING_MB/)
  assert.throws(() => readSettings({ WB_MAX_RUNS: '-1' }), /WB_MAX_RUNS/)
  assert.throws(() => readSettings({ WB_MAX_RUNS: '9999' }), /WB_MAX_RUNS/)
})
