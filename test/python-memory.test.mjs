import assert from 'node:assert/strict'
import test from 'node:test'
import { breachSamples, readRss, sampleIntervalMs, watchMemory } from '../server/python-memory.mjs'

const MiB = 1024 * 1024

test('readRss 能读取本进程的常驻内存', () => {
  const rss = readRss(process.pid)
  assert.ok(typeof rss === 'number' && rss > 0, '应读到正数')
  assert.ok(rss < 4096 * MiB, '读数应在合理范围')
})

test('readRss 对无效 pid 返回 null 而不是抛出', () => {
  assert.equal(readRss(0), null)
  assert.equal(readRss(null), null)
  assert.equal(readRss(undefined), null)
  assert.equal(readRss(2 ** 31), null, '不存在的 pid')
})

test('未超上限时永不触发', async () => {
  let fired = 0
  let samples = 0
  const stop = watchMemory(1, 100 * MiB, () => { fired++ }, {
    read: () => { samples++; return 50 * MiB },
    intervalMs: 5,
  })
  await new Promise(r => setTimeout(r, 80))
  stop()
  assert.ok(samples >= breachSamples, '应采到足够样本')
  assert.equal(fired, 0)
})

test('超上限必须连续多次才触发，单次尖峰被忽略', async () => {
  const values = [200 * MiB, 50 * MiB, 200 * MiB, 50 * MiB, 200 * MiB, 50 * MiB]
  let index = 0
  let fired = 0
  const stop = watchMemory(1, 100 * MiB, () => { fired++ }, {
    read: () => values[Math.min(index++, values.length - 1)],
    intervalMs: 3,
  })
  await new Promise(r => setTimeout(r, 40))
  stop()
  assert.equal(fired, 0, '交替高低不应触发')
})

test('连续超限后触发一次且只触发一次', async () => {
  let fired = 0
  const stop = watchMemory(1, 100 * MiB, () => { fired++ }, {
    read: () => 500 * MiB,
    intervalMs: 3,
  })
  await new Promise(r => setTimeout(r, 60))
  stop()
  assert.equal(fired, 1, '只触发一次')
})

test('触发后停止采样', async () => {
  let samples = 0
  let fired = 0
  watchMemory(1, 100 * MiB, () => { fired++ }, { read: () => { samples++; return 500 * MiB }, intervalMs: 3 })
  await new Promise(r => setTimeout(r, 50))
  const captured = samples
  await new Promise(r => setTimeout(r, 40))
  assert.equal(samples, captured, '采样应在触发后停止')
  assert.equal(fired, 1)
})

test('进程消失后自动停止，不触发回调', async () => {
  let fired = 0
  let samples = 0
  const stop = watchMemory(1, 100 * MiB, () => { fired++ }, {
    read: () => { samples++; return null },
    intervalMs: 3,
  })
  await new Promise(r => setTimeout(r, 30))
  stop()
  assert.equal(fired, 0)
  assert.ok(samples >= 1)
})

test('回调抛错不会让看门狗崩溃', async () => {
  await new Promise(resolve => {
    watchMemory(1, 100 * MiB, () => { throw new Error('boom') }, {
      read: () => 500 * MiB, intervalMs: 3,
    })
    setTimeout(resolve, 40)
  })
  assert.ok(true, '没有未捕获异常')
})

test('无效参数直接返回空函数', () => {
  for (const args of [[0, 100 * MiB], [1, 0], [1, -1], [null, 100 * MiB]]) {
    const stop = watchMemory(args[0], args[1], () => { throw new Error('不应触发') })
    assert.equal(typeof stop, 'function')
    stop()
  }
})

test('采样间隔与连击阈值符合文档', () => {
  assert.equal(sampleIntervalMs, 10_000)
  assert.equal(breachSamples, 3)
})
