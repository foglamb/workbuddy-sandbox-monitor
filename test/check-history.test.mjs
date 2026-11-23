import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Store } from '../server/store.mjs'
import { readSettings } from '../server/config.mjs'

const base = {
  name: 'Alpha', url: 'https://alpha.example/health', group: 'G', notes: '',
  expectedText: '', method: 'GET', intervalSec: 60, timeoutSec: 8, failureThreshold: 3,
  successMin: 200, successMax: 299, enabled: true,
}

const ok = (durationMs = 20) => ({ ok: true, code: 'ok', statusCode: 200, durationMs })
const bad = (code = 'network', durationMs = 5000) => ({ ok: false, code, statusCode: null, durationMs })

function fresh(historyLimit = 0) {
  const temp = mkdtempSync(join(tmpdir(), 'wb-hist-'))
  const path = join(temp, 'state.sqlite')
  return { store: new Store(path, historyLimit), path, temp }
}

test('默认不裁剪：记录数量超过任意小的上限也全部保留', () => {
  const { store, temp } = fresh(0)
  try {
    const [item] = store.createMany([base], 1000)
    for (let i = 1; i <= 500; i++) store.record(item.id, 0, ok(10 + i), i * 1000, 'scheduled')
    assert.equal(store.history(item.id, 10_000).length, 500)
    assert.equal(store.stats(item.id).total, 500)
  } finally {
    store.close()
    rmSync(temp, { recursive: true, force: true })
  }
})

test('显式设置上限时仍按上限裁剪，并保留最新记录', () => {
  const { store, temp } = fresh(3)
  try {
    const [item] = store.createMany([base], 1000)
    for (let i = 1; i <= 6; i++) store.record(item.id, 0, ok(), i * 1000, 'scheduled')
    const kept = store.history(item.id, 100)
    assert.equal(kept.length, 3)
    assert.deepEqual(kept.map(check => check.at), [6000, 5000, 4000])
  } finally {
    store.close()
    rmSync(temp, { recursive: true, force: true })
  }
})

test('改动地址后旧记录仍可读取，并区分配置代次', () => {
  const { store, temp } = fresh(0)
  try {
    const [item] = store.createMany([base], 1000)
    store.record(item.id, 0, ok(), 1000, 'manual')
    store.record(item.id, 0, bad('timeout'), 2000, 'scheduled')
    // 改地址会推进 generation
    store.update(item.id, { ...base, url: 'https://beta.example/health' }, 3000)
    store.record(item.id, store.generationOf(item.id), bad('dns'), 4000, 'scheduled')

    const rows = store.history(item.id, 100)
    assert.equal(rows.length, 3, '旧配置下的两条必须仍然在读得到的范围内')
    assert.deepEqual(rows.map(row => row.latest), [true, false, false])
    assert.equal(store.generationOf(item.id), 1)
  } finally {
    store.close()
    rmSync(temp, { recursive: true, force: true })
  }
})

test('游标分页不重叠、不丢记录', () => {
  const { store, temp } = fresh(0)
  try {
    const [item] = store.createMany([base], 1000)
    for (let i = 1; i <= 25; i++) store.record(item.id, 0, ok(), i * 1000, 'scheduled')
    const first = store.history(item.id, 10)
    const second = store.history(item.id, 10, first.at(-1).id)
    const third = store.history(item.id, 10, second.at(-1).id)
    const ids = [...first, ...second, ...third].map(row => row.id)
    assert.equal(new Set(ids).size, 25, '三次翻页合计应正好 25 条且无重复')
    assert.equal(third.length, 5)
  } finally {
    store.close()
    rmSync(temp, { recursive: true, force: true })
  }
})

test('统计给出可用率、耗时分布与失败原因构成', () => {
  const { store, temp } = fresh(0)
  try {
    const [item] = store.createMany([base], 1000)
    for (let i = 1; i <= 7; i++) store.record(item.id, 0, ok(100), i * 1000, 'scheduled')
    store.record(item.id, 0, bad('timeout', 8000), 8000, 'scheduled')
    store.record(item.id, 0, bad('timeout', 8000), 9000, 'scheduled')
    store.record(item.id, 0, bad('dns', 10), 10_000, 'scheduled')

    const stats = store.stats(item.id)
    assert.equal(stats.total, 10)
    assert.equal(stats.ok, 7)
    assert.equal(stats.failed, 3)
    assert.equal(stats.availability, 0.7)
    assert.equal(stats.durationMs.min, 10)
    assert.equal(stats.durationMs.max, 8000)
    assert.equal(stats.firstAt, 1000)
    assert.equal(stats.lastAt, 10_000)
    // node:sqlite 的行是 null 原型对象，逐字段断言避免原型差异干扰
    const timeoutRow = stats.byCode.find(row => row.code === 'timeout')
    assert.equal(timeoutRow.count, 2)
    const okRow = stats.byCode.find(row => row.code === 'ok')
    assert.equal(okRow.count, 7)
  } finally {
    store.close()
    rmSync(temp, { recursive: true, force: true })
  }
})

test('统计支持时间窗口，空记录时不给除零结果', () => {
  const { store, temp } = fresh(0)
  try {
    const [item] = store.createMany([base], 1000)
    store.record(item.id, 0, ok(), 1000, 'scheduled')
    store.record(item.id, 0, bad('timeout'), 100_000, 'scheduled')
    const recent = store.stats(item.id, 50_000)
    assert.equal(recent.total, 1)
    assert.equal(recent.ok, 0)
    assert.equal(recent.availability, 0)

    const [empty] = store.createMany([{ ...base, name: 'Empty' }], 2000)
    const none = store.stats(empty.id)
    assert.equal(none.total, 0)
    assert.equal(none.availability, null, '没有记录时不能算出可用率')
    assert.equal(none.durationMs, null)
  } finally {
    store.close()
    rmSync(temp, { recursive: true, force: true })
  }
})

test('WB_HISTORY_LIMIT 默认 0，且允许设成 0 表示永久保留', () => {
  assert.equal(readSettings({}).historyLimit, 0)
  assert.equal(readSettings({ WB_HISTORY_LIMIT: '0' }).historyLimit, 0)
  assert.equal(readSettings({ WB_HISTORY_LIMIT: '1200' }).historyLimit, 1200)
  assert.throws(() => readSettings({ WB_HISTORY_LIMIT: '-1' }), /WB_HISTORY_LIMIT/)
  assert.throws(() => readSettings({ WB_HISTORY_LIMIT: 'abc' }), /WB_HISTORY_LIMIT/)
})

test('删除网址时其检查记录一并移除，不留孤儿行', () => {
  const { store, temp } = fresh(0)
  try {
    const [item] = store.createMany([base], 1000)
    store.record(item.id, 0, ok(), 1000, 'manual')
    store.delete(item.id)
    const rows = store.db.prepare('SELECT count(*) AS count FROM checks').get()
    assert.equal(rows.count, 0)
  } finally {
    store.close()
    rmSync(temp, { recursive: true, force: true })
  }
})
