import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { readSettings, validateConfig } from '../server/config.mjs'
import { createApplication } from '../server/http.mjs'
import { pauseTasks, validatePauseTargets } from '../server/task-actions.mjs'
import { collectPauseCandidates, taskKey } from '../src/task-model.ts'

const now = Date.UTC(2026, 10, 1)
const missingId = '00000000-0000-0000-0000-000000000001'
const token = 'batch-pause-local-test-admin-0000000000'
const env = {
  WB_ADMIN_TOKEN: token,
  WB_AGS_BINDINGS: JSON.stringify([
    { id: 'fixture-a', label: '模拟续期 A', region: 'ap-guangzhou', instanceId: 'ins-fixture-a' },
    { id: 'fixture-b', label: '模拟续期 B', region: 'ap-shanghai', instanceId: 'ins-fixture-b' },
  ]),
  TENCENTCLOUD_SECRET_ID: 'AKIDLOCALTESTONLY0000',
  TENCENTCLOUD_SECRET_KEY: 'a-fictional-credential-for-this-test',
}
const policy = { enabled: true, intervalSec: 120, renewBeforeMinutes: 10, extendMinutes: 90, runForMinutes: 30 }

async function setup(t, options = {}) {
  const noCloud = async () => assert.fail('批量暂停不应调用云端')
  const app = createApplication({ ...readSettings(env), dataFile: ':memory:' }, {
    now: () => now, agsProvider: { describe: noCloud, extend: noCloud }, ...options,
  })
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  t.after(async () => {
    app.scheduler.stop()
    await app.leases.stop()
    await new Promise(resolve => app.server.close(resolve))
    app.store.close()
  })
  const url = `http://127.0.0.1:${app.server.address().port}/api/tasks/pause`
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  return {
    ...app,
    async send(body, headers = auth) {
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
      return { status: response.status, body: await response.json() }
    },
  }
}

function seed(app, count = 2) {
  const configs = Array.from({ length: count }, (_, index) => validateConfig({ name: `网址 ${index + 1}`,
    url: `https://fixture-${index}.example/healthz`, expectedText: 'fixture-ready', intervalSec: 120 + index }))
  return app.store.createMany(configs, now)
}

test('请求在写入前整体校验，拒绝重复、未知字段、错误种类和无效数量', () => {
  const target = { kind: 'url', id: missingId }
  const bad = [null, {}, { targets: [] }, { targets: [target, target] },
    { targets: [target], enabled: true }, { targets: [{ ...target, action: 'enable' }] },
    { targets: [{ kind: 'unknown', id: missingId }] }, { targets: [{ kind: 'url', id: 'invalid' }] },
    { targets: Array.from({ length: 89 }, (_, i) => ({ kind: 'lease', id: `fixture-${i}` })) }]
  for (const body of bad) assert.throws(() => validatePauseTargets(body))
  assert.deepEqual(validatePauseTargets({ targets: [target, { kind: 'lease', id: missingId }] }),
    [target, { kind: 'lease', id: missingId }])
})

test('批量暂停逐项返回，未选项不变，保留参数和历史且可安全重复', async t => {
  const app = await setup(t)
  const [a, untouched] = seed(app)
  app.store.record(a.id, 0, { ok: true, code: 'ok', statusCode: 204, durationMs: 3 }, now, 'manual')
  app.leases.update('fixture-a', policy)
  const before = app.store.history(a.id, 10)
  const targets = [
    { kind: 'url', id: missingId }, { kind: 'url', id: a.id },
    { kind: 'lease', id: 'fixture-a' }, { kind: 'lease', id: 'fixture-b' }, { kind: 'lease', id: 'removed-binding' },
  ]
  const result = await app.send({ targets })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.results.map(row => row.status), ['failed', 'paused', 'paused', 'already_paused', 'failed'])
  assert.equal(result.body.results[0].code, 'missing_task')
  const changed = app.store.snapshot(app.store.row(a.id))
  assert.deepEqual(changed.config, { ...a.config, enabled: false })
  assert.equal(changed.nextCheckAt, null)
  assert.deepEqual(app.store.history(a.id, 10), before)
  assert.equal(app.store.snapshot(app.store.row(untouched.id)).config.enabled, true)
  assert.deepEqual(app.leases.view('fixture-a').policy, { ...policy, enabled: false })
  assert.equal(app.leases.view('fixture-a').nextAt, null)
  const leaseEvents = app.leases.view('fixture-a').history.length
  const again = await app.send({ targets: [targets[1], targets[2]] })
  assert.deepEqual(again.body.results.map(row => row.status), ['already_paused', 'already_paused'])
  assert.equal(app.leases.view('fixture-a').history.length, leaseEvents)
})

test('鉴权、请求来源和错误格式不会改变任何任务', async t => {
  const app = await setup(t)
  const [site] = seed(app, 1)
  const targets = [{ kind: 'url', id: site.id }]
  assert.equal((await app.send({ targets }, { 'Content-Type': 'application/json' })).status, 401)
  assert.equal((await app.send({ targets }, { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: 'https://other.example' })).status, 403)
  assert.equal((await app.send({ targets: [...targets, { kind: 'url', id: 'wrong-id' }] })).status, 400)
  assert.equal(app.store.snapshot(app.store.row(site.id)).config.enabled, true)
})

test('请求期间的任务先暂停，网址检查取消且实例查询返回后不会续期', async t => {
  let release
  let writes = 0
  const app = await setup(t, {
    probe: (_config, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    agsProvider: { describe: (_binding, signal) => new Promise((resolve, reject) => {
      release = resolve
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }), extend: async () => { writes++ } },
  })
  const [site] = seed(app, 1)
  app.leases.update('fixture-a', policy)
  const siteJob = app.scheduler.run(site.id).catch(error => error)
  const leaseJob = app.leases.run('fixture-a', 'scheduled')
  const response = await app.send({ targets: [{ kind: 'url', id: site.id }, { kind: 'lease', id: 'fixture-a' }] })
  assert.deepEqual(response.body.results.map(row => row.status), ['paused', 'paused'])
  assert.equal((await siteJob).code, 'cancelled')
  release({ status: 'RUNNING', persistent: false, expiresAt: now + 3 * 60_000, requestId: 'mock-read' })
  assert.equal((await leaseJob).policy.enabled, false)
  assert.equal(writes, 0)
  assert.deepEqual(app.store.history(site.id, 10), [])
})

test('个别处理异常不回显内部细节，也不阻止后续任务暂停', () => {
  const targets = [{ kind: 'lease', id: 'broken' }, { kind: 'lease', id: 'working' }]
  let writes = 0
  const results = pauseTasks({ targets }, { leases: {
    view: id => {
      if (id === 'broken') throw new Error('PRIVATE-DETAILS-MUST-NOT-LEAK')
      return { policy }
    },
    update: () => { writes++ },
  } })
  assert.equal(writes, 1)
  assert.equal(results[0].status, 'failed')
  assert.equal(results[1].status, 'paused')
  assert.ok(!JSON.stringify(results).includes('PRIVATE-DETAILS'))
})

test('弹窗候选只含启用任务，并且网址与实例即使同名同标识也不混淆', () => {
  const candidates = collectPauseCandidates([
    { id: 'same', config: { name: '相同名称', enabled: true, group: '生产' } },
    { id: 'off-url', config: { name: '暂停网址', enabled: false } },
  ], [
    { id: 'same', label: '相同名称', region: 'ap-guangzhou', policy: { enabled: true } },
    { id: 'off-lease', label: '暂停实例', policy: { enabled: false } },
  ])
  assert.deepEqual(candidates.map(item => taskKey(item.target)), ['url:same', 'lease:same'])
  assert.equal(candidates[0].context, '网址检查 · 生产')
})
