import assert from 'node:assert/strict'
import test from 'node:test'
import { buildOverview } from '../src/overview.ts'

const now = Date.UTC(2026, 10, 20, 4)
const minute = 60_000
const site = (id, options = {}) => ({
  id, status: 'up', failures: 0, running: false, nextCheckAt: now + minute,
  lastCheck: { at: now - minute, ok: true, code: 'ok' },
  ...options, config: { enabled: true, name: id, group: '测试', failureThreshold: 3, ...options.config },
})
const instance = (id, options = {}) => ({
  id, label: id, region: 'ap-guangzhou', running: false, nextAt: now + minute,
  observed: { status: 'RUNNING', persistent: false, expiresAt: now + 120 * minute },
  pending: null, history: [], lastError: null,
  ...options, policy: { enabled: true, renewBeforeMinutes: 10, ...options.policy },
})
const byId = (report, id) => report.items.find(item => item.target.id === id)

test('总览按严重度排序，忽略暂停，并区分相同标识的网址和实例', () => {
  const report = buildOverview([
    site('shared', { status: 'down', failures: 3 }),
    site('warn', { status: 'degraded', failures: 1 }),
    site('healthy'),
    site('disabled-url', { status: 'down', config: { enabled: false } }),
  ], [
    instance('shared', { observed: null }),
    instance('expired', { observed: { status: 'RUNNING', expiresAt: now - minute } }),
    instance('disabled-lease', { observed: { status: 'FAILED' }, policy: { enabled: false } }),
  ], now)
  assert.deepEqual(report.items.map(item => [item.target.kind, item.target.id, item.severity]), [
    ['lease', 'expired', 'urgent'], ['url', 'shared', 'urgent'], ['url', 'warn', 'attention'], ['lease', 'shared', 'waiting'],
  ])
  assert.equal(report.urlsActive, 3)
  assert.equal(report.leasesActive, 2)
  assert.equal(report.attention, 3)
  assert.equal(report.waiting, 1)
  assert.match(byId(report, 'expired').detail, /不等于已确认停止/)
})

test('超过计划时间独立标记，不把排队和正在执行误判成拒绝或停机', () => {
  const report = buildOverview([
    site('late-url', { nextCheckAt: now - minute }),
    site('busy-url', { nextCheckAt: now - 5 * minute, running: true }),
    site('within-grace', { nextCheckAt: now - minute + 1 }),
    site('first-url', { status: 'pending', lastCheck: null }),
  ], [
    instance('late-instance', { nextAt: now - minute }),
    instance('busy-instance', { nextAt: now - minute, running: true }),
  ], now)
  assert.deepEqual(report.items.map(item => item.target.id), ['late-instance', 'late-url', 'first-url'])
  assert.match(byId(report, 'late-url').detail, /检查队列/)
  assert.equal(byId(report, 'first-url').severity, 'waiting')
})

test('总览按可续期状态、到期窗口和历史核验结果区分提醒', () => {
  const current = expiresAt => ({ status: 'RUNNING', expiresAt, persistent: false })
  const report = buildOverview([], [
    instance('persistent', { observed: { ...current(null), persistent: true } }),
    instance('missing-expiry', { observed: current(null) }),
    instance('near-expiry', { observed: current(now + 10 * minute) }),
    instance('outside-window', { observed: current(now + 10 * minute + 1) }),
    instance('halted', { observed: { ...current(now + 2 * minute), status: 'PAUSED' } }),
    instance('waiting', { pending: { at: now - minute, acknowledged: true } }),
    instance('pending-too-long', { pending: { at: now - 5 * minute, acknowledged: false } }),
    instance('unverified', { history: [{ kind: 'unverified' }] }),
    instance('verified', { history: [{ kind: 'verified' }, { kind: 'unverified' }] }),
    instance('query-failed', { lastError: { phase: 'query', code: 'CloudTimeout' } }),
  ], now)
  assert.equal(report.items.length, 7)
  assert.equal(report.items[0].target.id, 'halted')
  assert.equal(byId(report, 'halted').leaseStatus, 'PAUSED')
  assert.equal(byId(report, 'near-expiry').title, '已进入续期窗口')
  assert.equal(byId(report, 'pending-too-long').severity, 'attention')
  assert.equal(byId(report, 'waiting').severity, 'waiting')
  assert.equal(byId(report, 'unverified').title, '最近一次续期未核验')
  assert.equal(byId(report, 'missing-expiry').title, '云端未返回到期时间')
  assert.match(byId(report, 'query-failed').detail, /CloudTimeout/)
  assert.ok(!byId(report, 'verified'))
})
