import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { AgsError } from '../server/ags.mjs'
import { LeaseManager, validateLeasePolicy } from '../server/leases.mjs'

const minute = 60_000
const base = Date.UTC(2026, 10, 1)
const legacy = { enabled: true, intervalSec: 60, renewBeforeMinutes: 6, extendMinutes: 60 }
const timed = { ...legacy, runForMinutes: 15 }
const bindings = ['a', 'b', 'c'].map(id => ({ id, label: id, region: 'ap-guangzhou', fingerprint: `fixture-${id}` }))
const running = expiry => ({ status: 'RUNNING', persistent: false, expiresAt: expiry, requestId: 'mock-query' })

function setup(t, provider) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  let at = base
  const options = { now: () => at }
  const manager = new LeaseManager(db, bindings, provider, options)
  return { db, options, manager, time: minutes => { at = base + minutes * minute } }
}

test('旧请求默认为不限时，定时策略只允许显式有效的分钟数', () => {
  assert.equal(validateLeasePolicy(legacy).runForMinutes, 0)
  for (const runForMinutes of [0, 15, 60, 10_080]) {
    assert.equal(validateLeasePolicy({ ...legacy, runForMinutes }).runForMinutes, runForMinutes)
  }
  for (const runForMinutes of [null, -1, 1, 14, 15.5, '60', 10_081, Infinity]) {
    assert.throws(() => validateLeasePolicy({ ...legacy, runForMinutes }), /持续时间/)
  }
  assert.throws(() => validateLeasePolicy({ ...legacy, pauseAt: base }), /有效的实例续期策略/)
})

test('每个实例独立截止，修改其他参数和重启不延长窗口，再启用才重新计时', async t => {
  let calls = 0
  const provider = { describe: async () => { calls++; return running(base + 120 * minute) }, extend: async () => assert.fail() }
  const { db, options, manager, time } = setup(t, provider)
  const started = manager.update('a', timed)
  manager.update('b', legacy)
  assert.equal(started.pauseAt, base + 15 * minute)
  time(4)
  manager.update('a', { ...legacy, extendMinutes: 90 })
  assert.equal(manager.view('a').policy.runForMinutes, 15)
  assert.equal(manager.view('a').pauseAt, started.pauseAt)
  const restarted = new LeaseManager(db, bindings, provider, options)
  assert.equal(restarted.view('a').pauseAt, started.pauseAt)
  time(15)
  const paused = await restarted.run('a', 'scheduled')
  assert.equal(paused.policy.enabled, false)
  assert.equal(paused.nextAt, null)
  assert.equal(calls, 0)
  assert.equal(paused.history[0].kind, 'auto_paused')
  assert.equal(paused.history[0].pauseAt, started.pauseAt)
  assert.equal(restarted.view('b').policy.enabled, true)
  restarted.view('a')
  assert.equal(restarted.view('a').history.filter(e => e.kind === 'auto_paused').length, 1)
  time(16)
  const resumed = restarted.update('a', { ...paused.policy, enabled: true })
  assert.equal(resumed.pauseAt, base + 31 * minute)
  time(17)
  const reset = restarted.update('a', { ...resumed.policy, runForMinutes: 30 })
  assert.equal(reset.pauseAt, base + 47 * minute)
  assert.equal(restarted.update('a', { ...reset.policy, runForMinutes: 0 }).pauseAt, null)
})

test('云端查询跨过截止时间返回时，不提交续期', async t => {
  let release
  let updates = 0
  const { manager, time } = setup(t, {
    describe: () => new Promise(resolve => { release = resolve }),
    extend: async () => { updates++ },
  })
  manager.update('a', timed)
  const query = manager.run('a', 'scheduled')
  time(15)
  release(running(base + 16 * minute))
  const result = await query
  assert.equal(result.policy.enabled, false)
  assert.equal(result.nextAt, null)
  assert.equal(updates, 0)
  assert.equal(result.history.filter(event => event.kind === 'auto_paused').length, 1)
})

test('云端请求已发出后截止，保留响应但不重新启用策略', async t => {
  let accept
  let updateCount = 0
  const provider = {
    describe: async () => running(base + 5 * minute),
    extend: () => { updateCount++; return new Promise(resolve => { accept = resolve }) },
  }
  const { manager, time } = setup(t, provider)
  manager.update('a', timed)
  const job = manager.run('a', 'scheduled')
  await Promise.resolve()
  assert.equal(updateCount, 1)
  time(15)
  manager.tick()
  assert.equal(manager.view('a').policy.enabled, false)
  accept('accepted-before-deadline')
  const result = await job
  assert.equal(result.policy.enabled, false)
  assert.equal(result.pending.acknowledged, true)
  assert.equal(result.nextAt, null)
  assert.equal(result.history[0].kind, 'accepted')
  assert.equal(result.history.filter(event => event.kind === 'auto_paused').length, 1)
})

test('错误退避也受截止限制，队列有其他任务执行时仍按时暂停', async t => {
  let queryCount = 0
  let rejectWithError = true
  const pending = new Map()
  const { manager, time } = setup(t, {
    describe: binding => {
      queryCount++
      if (rejectWithError) throw new AgsError('CloudTimeout')
      return new Promise(resolve => pending.set(binding.id, resolve))
    },
    extend: async () => assert.fail(),
  })
  manager.update('a', timed)
  time(14)
  const failed = await manager.run('a', 'scheduled')
  assert.equal(failed.nextAt, base + 15 * minute)
  rejectWithError = false
  manager.update('b', legacy)
  manager.update('c', legacy)
  const b = manager.run('b')
  const c = manager.run('c')
  assert.equal(manager.active.size, 2)
  time(15)
  manager.tick()
  assert.equal(manager.view('a').policy.enabled, false)
  assert.equal(queryCount, 3)
  for (const resolve of pending.values()) resolve(running(base + 80 * minute))
  await Promise.all([b, c])
})

test('旧持久化策略保持启用，新策略离线错过截止时先暂停再调度', t => {
  const provider = { describe: async () => assert.fail('升级过程不应查询云端'), extend: async () => assert.fail() }
  const { db, options, manager, time } = setup(t, provider)
  manager.update('a', legacy)
  manager.update('b', timed)
  const row = db.prepare('SELECT snapshot FROM runtime_leases WHERE id = ?').get('a')
  const old = JSON.parse(row.snapshot)
  delete old.policy.runForMinutes
  delete old.pauseAt
  db.prepare('UPDATE runtime_leases SET snapshot = ? WHERE id = ?').run(JSON.stringify(old), 'a')
  time(20)
  const recovered = new LeaseManager(db, bindings, provider, options)
  const a = recovered.view('a')
  assert.equal(a.policy.enabled, true)
  assert.equal(a.policy.runForMinutes, 0)
  assert.equal(a.pauseAt, null)
  const b = recovered.view('b')
  assert.equal(b.policy.enabled, false)
  assert.equal(b.nextAt, null)
  assert.equal(b.history[0].kind, 'auto_paused')
  assert.equal(b.pauseAt, base + 15 * minute)
  assert.equal(new LeaseManager(db, bindings, provider, options).view('b').history.filter(e => e.kind === 'auto_paused').length, 1)
})
