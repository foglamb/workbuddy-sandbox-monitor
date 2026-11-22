import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { readSettings, targetUrl, validateConfig } from '../server/config.mjs'
import { createApplication } from '../server/http.mjs'
import { checkSite, resolveTarget } from '../server/probe.mjs'
import { Store } from '../server/store.mjs'

const healthy = { ok: true, code: 'ok', statusCode: 204, durationMs: 12 }
const unhealthy = { ok: false, code: 'http', statusCode: 503, durationMs: 15 }

async function harness(t, overrides = {}, options = {}) {
  const app = createApplication({ ...readSettings({}), dataFile: ':memory:', ...overrides }, {
    probe: async () => healthy, ...options,
  })
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  t.after(async () => {
    app.scheduler.stop()
    await new Promise(resolve => app.server.close(resolve))
    app.store.close()
  })
  const base = `http://127.0.0.1:${app.server.address().port}/api/sandboxes`
  async function api(path = '', method = 'GET', data, headers) {
    const response = await fetch(`${base}${path}`, {
      method, headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: data === undefined ? undefined : JSON.stringify(data),
    })
    return { status: response.status, ...(await response.json()) }
  }
  return { ...app, api }
}

const alpha = { name: 'Alpha', url: 'https://alpha.example/healthz', group: '生产', intervalSec: 60, failureThreshold: 2 }
const beta = { name: 'Beta', url: 'https://beta.example/healthz', group: '测试', intervalSec: 90 }

test('沙盒按各自间隔调度，失败阈值和恢复互不影响，可暂停和手动检查', async t => {
  let now = 100_000
  let alphaResult = unhealthy
  const { api, scheduler } = await harness(t, {}, {
    now: () => now, cooldownMs: 0,
    probe: async config => config.name === 'Alpha' ? alphaResult : healthy,
  })
  const created = await api('', 'POST', alpha)
  const second = await api('', 'POST', beta)
  assert.equal(created.status, 201)
  assert.equal(second.status, 201)
  const { sandbox: a } = created
  const { sandbox: b } = second

  scheduler.tick()
  await setImmediate()
  let { sandboxes: [first, next], serverTime } = await api()
  assert.equal(serverTime, now)
  assert.equal(first.status, 'degraded')
  assert.equal(first.nextCheckAt, 160_000)
  assert.equal(next.status, 'up')
  assert.equal(next.nextCheckAt, 190_000)

  now += 60_000
  scheduler.tick()
  await setImmediate()
  ;({ sandboxes: [first, next] } = await api())
  assert.equal(first.status, 'down')
  assert.equal(next.lastCheck.at, 100_000)
  assert.equal((await api(`/${a.id}/checks`)).checks.length, 2)
  assert.equal((await api(`/${b.id}/checks`)).checks.length, 1)

  assert.equal((await api(`/${a.id}`, 'PATCH', { enabled: false })).sandbox.status, 'paused')
  now += 4_000
  alphaResult = healthy
  assert.equal((await api(`/${a.id}/check`, 'POST')).result.code, 'ok')
  ;({ sandboxes: [first] } = await api())
  assert.equal(first.failures, 0)
  assert.equal(first.nextCheckAt, null)
  assert.equal(first.status, 'paused')

  assert.equal((await api(`/${a.id}`, 'PATCH', { enabled: true })).sandbox.status, 'up')
  assert.equal((await api(`/${a.id}`, 'PUT', { ...alpha, url: 'https://changed.example/health' })).sandbox.lastCheck, null)
  assert.deepEqual((await api(`/${a.id}/checks`)).checks, [])
  assert.equal((await api(`/${b.id}`, 'DELETE')).status, 200)
  assert.equal((await api(`/${b.id}/checks`)).status, 404)
})

test('修改运行中的配置会取消旧检查，且单项检查不重叠', async t => {
  let unblock
  const started = new Promise(resolve => { unblock = resolve })
  const { api, scheduler } = await harness(t, {}, {
    probe: (_config, signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      unblock()
    }),
  })
  const { sandbox } = await api('', 'POST', alpha)
  const pending = api(`/${sandbox.id}/check`, 'POST')
  await started
  assert.equal((await api(`/${sandbox.id}/check`, 'POST')).status, 409)
  assert.equal((await api(`/${sandbox.id}`, 'PATCH', { enabled: false })).status, 200)
  assert.equal((await pending).code, 'cancelled')
  assert.equal(scheduler.running(sandbox.id), false)
  assert.deepEqual((await api(`/${sandbox.id}/checks`)).checks, [])
})

test('管理口令、请求来源、导入原子性及暂停状态', async t => {
  const token = 'only-for-local-test-89b712345678901234'
  const auth = { Authorization: `Bearer ${token}` }
  const { api } = await harness(t, { token })
  assert.equal((await api()).status, 401)
  assert.equal((await api('', 'POST', alpha, { ...auth, Origin: 'https://another.example' })).status, 403)
  assert.equal((await api('/import', 'POST', { version: 1, configs: [alpha, { ...beta, intervalSec: 20 }] }, auth)).status, 400)
  assert.deepEqual((await api('', 'GET', undefined, auth)).sandboxes, [])
  assert.equal((await api('/import', 'POST', { version: 1, configs: [alpha, beta] }, auth)).count, 2)
  assert.deepEqual((await api('', 'GET', undefined, auth)).sandboxes.map(item => item.status), ['paused', 'paused'])
})

test('SQLite 重开后保留配置与记录，历史保留上限生效', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'wb-db-'))
  const path = join(temp, 'state.sqlite')
  let store = new Store(path, 2)
  const [item] = store.createMany([{ ...alpha, enabled: true }], 1000)
  for (let i = 1; i <= 3; i++) store.record(item.id, 0, healthy, i * 1000, 'scheduled')
  store.close()
  store = new Store(path, 2)
  try {
    assert.equal(store.list()[0].config.name, 'Alpha')
    assert.equal(store.list()[0].nextCheckAt, 63_000)
    assert.deepEqual(store.history(item.id, 10).map(check => check.at), [3000, 2000])
  } finally {
    store.close()
  }
})

test('检查目标必须是公开健康地址，对 DNS 结果也做校验', async () => {
  assert.throws(() => targetUrl('https://logs.example/health?key=example'))
  // HTTP 部署地址现在是允许的（内网常见），不再要求 HTTPS
  assert.equal(targetUrl('http://status.example/').href, 'http://status.example/')
  assert.equal(targetUrl('https://status.example/').href, 'https://status.example/')
  assert.throws(() => targetUrl('ftp://status.example/'))
  assert.throws(() => targetUrl('https://unlisted.example/', { allowedOrigins: new Set(['https://allowed.example']) }))
  const signal = new AbortController().signal
  const check = await checkSite({ ...alpha, url: 'https://127.0.0.1/', timeoutSec: 2 }, signal, {})
  assert.equal(check.code, 'blocked')
  const testUrl = new URL('https://status.example/')
  await assert.rejects(resolveTarget(testUrl, signal, async () => [
    { address: '8.8.8.8', family: 4 }, { address: 'fc00::2', family: 6 },
  ]), { code: 'blocked_target' })
  assert.deepEqual(await resolveTarget(testUrl, signal, async () => [
    { address: '8.8.8.8', family: 4 },
  ]), { address: '8.8.8.8', family: 4 })
})

test('旧沙盒配置保留结果，变更响应匹配规则后按新规则检查', async t => {
  const { api, store } = await harness(t, {}, {
    cooldownMs: 0,
    probe: async config => config.expectedText
      ? { ok: false, code: 'body', statusCode: 200, durationMs: 5 }
      : healthy,
  })
  const now = Date.now()
  const [old] = store.createMany([{ ...alpha, enabled: true }], now)
  store.record(old.id, 0, healthy, now, 'scheduled')
  const path = `/${old.id}`
  const { sandbox: renamed } = await api(path, 'PUT', { ...old.config, name: '已改名' })
  assert.equal(renamed.config.expectedText, '')
  assert.equal(renamed.lastCheck.code, 'ok')
  assert.equal((await api(path, 'PUT', { ...renamed.config, method: 'HEAD', expectedText: 'app-ready' })).status, 400)
  const { sandbox: updated } = await api(path, 'PUT', { ...renamed.config, expectedText: 'app-ready' })
  assert.equal(updated.status, 'pending')
  assert.equal(updated.lastCheck, null)
  const { result } = await api(`${path}/check`, 'POST')
  assert.equal(result.code, 'body')
  assert.equal(result.statusCode, 200)
  const { sandboxes: [current] } = await api()
  assert.equal(current.status, 'degraded')
  assert.equal(current.failures, 1)
})

test('HTTP 部署地址被接受，非法协议仍被拒绝', () => {
  assert.equal(targetUrl('http://10.0.0.5:8080/').href, 'http://10.0.0.5:8080/')
  assert.equal(targetUrl('http://internal.example/healthz').href, 'http://internal.example/healthz')
  assert.equal(targetUrl('https://example.com/').href, 'https://example.com/')
  for (const bad of ['ftp://example.com/', 'file:///etc/passwd', 'ws://example.com/', 'example.com']) {
    assert.throws(() => targetUrl(bad), `${bad} 应被拒绝`)
  }
})

test('非回环监听只要求管理口令，不再强制 HTTPS', () => {
  const origin = 'http://10.0.0.5:8789'
  assert.doesNotThrow(() => readSettings({ WB_HOST: '0.0.0.0', WB_ADMIN_TOKEN: 'http-plain-token-1234', WB_WEB_ORIGIN: origin }))
  assert.throws(() => readSettings({ WB_HOST: '0.0.0.0', WB_WEB_ORIGIN: origin }), /WB_ADMIN_TOKEN/)
  // 仍然是合法 URL 才能通过
  assert.throws(() => readSettings({ WB_HOST: '0.0.0.0', WB_ADMIN_TOKEN: 'http-plain-token-1234', WB_WEB_ORIGIN: '10.0.0.5:8789' }))
})

test('禁用域名可由 WB_DENIED_DOMAINS 扩展，内置项不可移除', () => {
  const base = readSettings({})
  assert.ok(base.deniedDomains.includes('copilot.tencent.com'), '内置项始终生效')
  assert.doesNotThrow(() => validateConfig({ name: 'x', url: 'https://example.com/' }, base))

  const extended = readSettings({ WB_DENIED_DOMAINS: 'internal.corp, .secret.test,bad host!' })
  assert.ok(extended.deniedDomains.includes('internal.corp'))
  assert.ok(extended.deniedDomains.includes('secret.test'), '前导点会被规范化')
  assert.ok(!extended.deniedDomains.includes('bad host!'), '非法项被忽略')
  for (const url of ['https://internal.corp/', 'https://a.internal.corp/', 'https://secret.test/']) {
    assert.throws(() => validateConfig({ name: 'x', url }, extended), error => error.code === 'blocked_target', `${url} 应被拒绝`)
  }
  assert.doesNotThrow(() => validateConfig({ name: 'x', url: 'https://example.com/' }, extended))
})
