import assert from 'node:assert/strict'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { AgsError, createAgsProvider, readAgsBindings, signAgsRequest } from '../server/ags.mjs'
import { readSettings } from '../server/config.mjs'
import { createApplication } from '../server/http.mjs'
import { LeaseManager, validateLeasePolicy } from '../server/leases.mjs'

const config = (id = 'fixture-a', region = 'ap-guangzhou') => ({ id, label: `绑定 ${id}`, region, instanceId: `ins-${id}` })
const token = 'local-test-admin-not-a-real-secret-1234'
const env = {
  WB_ADMIN_TOKEN: token,
  WB_AGS_BINDINGS: JSON.stringify([config(), config('fixture-b', 'ap-shanghai')]),
  TENCENTCLOUD_SECRET_ID: 'AKIDTESTONLY0001',
  TENCENTCLOUD_SECRET_KEY: 'fictional-key-for-verification',
}
const [a, b] = readAgsBindings(env, token)
const policy = { enabled: true, intervalSec: 60, renewBeforeMinutes: 6, extendMinutes: 60 }
const min = 60_000
const base = Date.UTC(2026, 10, 1)
const running = expiresAt => ({ status: 'RUNNING', expiresAt, requestId: 'fixture-read', persistent: false })

function setup(t, provider, bindings = [a, b]) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  let now = base
  const time = { now: () => now }
  return { db, time, clock: value => { now = base + value }, manager: new LeaseManager(db, bindings, provider, time) }
}

test('实例白名单要求管理员口令、拒绝杂项字段和重复目标', () => {
  assert.deepEqual(readAgsBindings({}, ''), [])
  assert.throws(() => readAgsBindings(env, ''), /WB_ADMIN_TOKEN/)
  assert.throws(() => readAgsBindings({ ...env, WB_AGS_BINDINGS: JSON.stringify([{ ...config(), instanceUrl: 'https://fixture.invalid' }]) }, token))
  assert.throws(() => readAgsBindings({ ...env, WB_AGS_BINDINGS: JSON.stringify([config(), { ...config(), id: 'different' }]) }, token), /重复绑定/)
  assert.throws(() => readAgsBindings({ ...env, TENCENTCLOUD_SECRET_KEY: '' }, token), /密钥/)
  assert.throws(() => validateLeasePolicy({ ...policy, intervalSec: 240 }), /提前量的一半/)
  assert.throws(() => validateLeasePolicy({ ...policy, instanceId: a.instanceId }), /有效的实例续期策略/)
})

test('TC3 签名符合官方 Node SDK 的离线向量', () => {
  const vector = signAgsRequest('DescribeSandboxInstances', '{"InstanceIds":["ins-fixture-a"]}', a, 1791234567)
  assert.equal(vector.Authorization.split('Signature=')[1], '9850df3d1c04f1596fdbadf9cf9a92cb7bcc1ca63b86a7cfcbeb70c9a66cfd95')
  assert.equal(vector['X-TC-Version'], '2025-09-20')
})

test('官方客户端固定 HTTPS 端点，仅请求绑定实例并隐藏错误正文', async () => {
  const calls = []
  const client = createAgsProvider({ now: () => base, fetchImpl: async (url, options) => {
    calls.push({ url, ...options })
    if (calls.length === 1) return Response.json({ Response: { InstanceSet: [
      { InstanceId: b.instanceId, Status: 'RUNNING' },
      { InstanceId: a.instanceId, Status: 'Running', Persistent: false, ExpiresAt: '2026-11-01T08:10:00+08:00' },
    ], RequestId: 'describe-test' } })
    if (calls.length === 2) return Response.json({ Response: { RequestId: 'extend-test' } })
    return Response.json({ Response: { Error: { Code: 'UnauthorizedOperation', Message: 'do-not-show-provider-body' }, RequestId: 'denied-test' } })
  } })
  const signal = new AbortController().signal
  assert.deepEqual(await client.describe(a, signal), { ...running(base + 10 * min), requestId: 'describe-test' })
  assert.equal(await client.extend(a, 60, signal), 'extend-test')
  await assert.rejects(() => client.describe(a, signal), error => {
    assert.equal(error.code, 'UnauthorizedOperation')
    assert.equal(error.requestId, 'denied-test')
    assert.doesNotMatch(error.message, /do-not-show-provider-body/)
    return true
  })
  for (const call of calls) {
    assert.equal(call.url, 'https://ags.tencentcloudapi.com/')
    assert.equal(call.redirect, 'error')
    assert.equal(call.method, 'POST')
  }
  assert.deepEqual(JSON.parse(calls[0].body), { InstanceIds: [a.instanceId] })
  assert.deepEqual(JSON.parse(calls[1].body), { InstanceId: a.instanceId, Timeout: '60m' })
})

test('到期窗口、按实例独立调度、延期核验与重建管理器恢复', async t => {
  const expiries = { [a.id]: base + 5 * min, [b.id]: base + 24 * min }
  const writes = []
  const provider = {
    describe: async binding => running(expiries[binding.id]),
    extend: async (binding, minutes) => { writes.push([binding.id, minutes]); return 'accepted-test' },
  }
  const { db, manager, time, clock } = setup(t, provider)
  assert.equal(manager.view(a.id).policy.enabled, false)
  await manager.run(a.id)
  assert.deepEqual(writes, [])
  manager.update(a.id, policy)
  manager.update(b.id, { ...policy, extendMinutes: 90 })
  await manager.run(b.id, 'scheduled')
  assert.deepEqual(writes, [])
  clock(10_000)
  const pending = await manager.run(a.id, 'scheduled')
  assert.deepEqual(writes, [[a.id, 60]])
  assert.equal(pending.lastVerifiedAt, null)
  assert.equal(pending.pending.acknowledged, true)

  const restarted = new LeaseManager(db, [a, b], provider, time)
  assert.equal(restarted.view(a.id).pending.acknowledged, true)
  clock(70_000)
  await restarted.run(a.id, 'scheduled')
  assert.equal(restarted.view(a.id).lastVerifiedAt, null)
  assert.equal(writes.length, 1)
  expiries[a.id] = base + 59 * min
  clock(130_000)
  const confirmed = await restarted.run(a.id, 'scheduled')
  assert.equal(confirmed.pending, null)
  assert.equal(confirmed.lastVerifiedAt, time.now())
  assert.equal(confirmed.history[0].kind, 'verified')
  assert.equal(restarted.view(b.id).policy.extendMinutes, 90)
  assert.equal(writes.length, 1)

  const replacement = readAgsBindings({ ...env, WB_AGS_BINDINGS: JSON.stringify([{ ...config(), instanceId: 'ins-replacement' }]) }, token)
  const retargeted = new LeaseManager(db, replacement, provider, time)
  assert.equal(retargeted.view(a.id).policy.enabled, false)
  assert.equal(retargeted.view(a.id).lastVerifiedAt, null)
})

test('暂停、已停止、常驻、超期及未知到期时间时不写云端', async t => {
  const views = [
    { ...running(base + 4 * min), persistent: true }, { ...running(null), status: 'STOPPED' },
    { ...running(base + 3 * min), status: 'PAUSED' }, running(null), running(base - min),
  ]
  let writes = 0
  const { manager, clock } = setup(t, { describe: async () => views.shift(), extend: async () => { writes++ } })
  manager.update(a.id, policy)
  const count = views.length
  for (let index = 0; index < count; index++) {
    clock(index * min)
    await manager.run(a.id, 'scheduled')
  }
  assert.equal(views.length, 0)
  assert.equal(writes, 0)
  manager.update(a.id, { ...policy, enabled: false })
  assert.equal((await manager.run(a.id, 'scheduled')).nextAt, null)
})

test('更新超时后先查询，至少五分钟才可能再次发送更新', async t => {
  let writes = 0
  const { manager, clock } = setup(t, {
    describe: async () => running(base + 5 * min),
    extend: async () => { writes++; throw new AgsError('CloudTimeout') },
  })
  manager.update(a.id, policy)
  const errored = await manager.run(a.id, 'scheduled')
  assert.equal(errored.lastError.phase, 'renew')
  assert.equal(errored.history[0].kind, 'error')
  assert.equal(errored.pending.acknowledged, false)
  clock(2 * min)
  await manager.run(a.id, 'scheduled')
  assert.equal(writes, 1)
  clock(5 * min)
  const expired = await manager.run(a.id, 'scheduled')
  assert.equal(expired.pending, null)
  assert.equal(expired.history[0].kind, 'unverified')
  assert.equal(writes, 1)
})

test('查询进行中暂停后不会提交续期', async t => {
  let release
  let writes = 0
  const { manager } = setup(t, {
    describe: () => new Promise(resolve => { release = resolve }),
    extend: async () => { writes++ },
  })
  manager.update(a.id, policy)
  const runningJob = manager.run(a.id, 'scheduled')
  manager.update(a.id, { ...policy, enabled: false })
  release(running(base + 3 * min))
  assert.equal((await runningJob).policy.enabled, false)
  assert.equal(writes, 0)
})

test('管理端只接受已授权别名，查询不执行续期且读不到密钥', async t => {
  let queried = 0
  let writes = 0
  const { server, store, leases } = createApplication({ ...readSettings(env), dataFile: ':memory:' }, {
    now: () => base,
    agsProvider: { describe: async () => { queried++; return running(base + 3 * min) }, extend: async () => { writes++ } },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    await leases.stop()
    await new Promise(resolve => server.close(resolve))
    store.close()
  })
  const root = `http://127.0.0.1:${server.address().port}/api`
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const update = (id, config, headers = auth) => fetch(`${root}/leases/${id}`, { method: 'PUT', headers, body: JSON.stringify(config) })
  assert.equal((await update(a.id, policy, { 'Content-Type': 'application/json' })).status, 401)
  assert.equal((await update(a.id, policy, { ...auth, Origin: 'https://another.invalid' })).status, 403)
  assert.equal((await update('wrong-id', policy)).status, 404)
  assert.equal((await update(a.id, policy)).status, 200)
  const response = await fetch(`${root}/leases/${a.id}/query`, { method: 'POST', headers: auth })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).lease.observed.status, 'RUNNING')
  assert.equal(queried, 1)
  assert.equal(writes, 0)
  const serialized = await (await fetch(`${root}/sandboxes`, { headers: auth })).text()
  assert.equal(JSON.parse(serialized).leases.length, 2)
  for (const secret of [a.instanceId, a.secretId, a.secretKey, token]) assert.ok(!serialized.includes(secret))
})
