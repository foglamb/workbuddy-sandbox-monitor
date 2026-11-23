import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { readSettings } from '../server/config.mjs'
import { createApplication } from '../server/http.mjs'

const token = 'example-token-0001'
const healthy = { ok: true, code: 'ok', statusCode: 200, durationMs: 12 }
const site = { name: 'Alpha', url: 'https://alpha.example/healthz', group: '生产', intervalSec: 60 }

async function harness(t, options = {}) {
  const app = createApplication({ ...readSettings({ WB_ADMIN_TOKEN: token }), dataFile: ':memory:' }, {
    probe: async () => healthy, cooldownMs: 0, ...options,
  })
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  t.after(async () => {
    app.scheduler.stop()
    await new Promise(resolve => app.server.close(resolve))
    app.store.close()
  })
  const base = `http://127.0.0.1:${app.server.address().port}/api/sandboxes`
  const api = async (path = '', method = 'GET', data) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(data === undefined || method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
      },
      body: data === undefined || method === 'GET' ? undefined : JSON.stringify(data),
    })
    return { status: response.status, ...(await response.json()) }
  }
  return { ...app, api }
}

test('检查记录接口默认返回 100 条，并带上配置代次', async t => {
  const { api, store } = await harness(t)
  const { sandbox } = await api('', 'POST', site)
  const id = sandbox.id
  for (let i = 1; i <= 150; i++) store.record(id, 0, healthy, i * 1000, 'scheduled')
  const page = await api(`/${id}/checks`)
  assert.equal(page.checks.length, 100)
  assert.equal(page.generation, 0)
  assert.equal(page.checks[0].latest, true)
})

test('检查记录接口支持 before 游标翻到更早的记录', async t => {
  const { api, store } = await harness(t)
  const { sandbox } = await api('', 'POST', site)
  const id = sandbox.id
  for (let i = 1; i <= 30; i++) store.record(id, 0, healthy, i * 1000, 'scheduled')
  const first = await api(`/${id}/checks?limit=10`)
  const older = await api(`/${id}/checks?limit=10&before=${first.checks.at(-1).id}`)
  assert.equal(older.checks.length, 10)
  assert.ok(older.checks[0].at < first.checks.at(-1).at)
  const ids = new Set([...first.checks, ...older.checks].map(row => row.id))
  assert.equal(ids.size, 20, '两页之间不能有重复记录')
})

test('检查记录接口拒绝越界与非法游标', async t => {
  const { api } = await harness(t)
  const { sandbox } = await api('', 'POST', site)
  const id = sandbox.id
  assert.equal((await api(`/${id}/checks?limit=0`)).status, 400)
  assert.equal((await api(`/${id}/checks?limit=5001`)).status, 400)
  assert.equal((await api(`/${id}/checks?before=0`)).status, 400)
  assert.equal((await api(`/${id}/checks?before=abc`)).status, 400)
})

test('统计接口给出可用率与失败构成，缺省统计全部历史', async t => {
  const { api, store } = await harness(t)
  const { sandbox } = await api('', 'POST', site)
  const id = sandbox.id
  for (let i = 1; i <= 8; i++) store.record(id, 0, healthy, i * 1000, 'scheduled')
  store.record(id, 0, { ok: false, code: 'timeout', statusCode: null, durationMs: 8000 }, 9000, 'scheduled')
  store.record(id, 0, { ok: false, code: 'timeout', statusCode: null, durationMs: 8000 }, 10_000, 'scheduled')

  const { stats } = await api(`/${id}/stats`)
  assert.equal(stats.total, 10)
  assert.equal(stats.ok, 8)
  assert.equal(stats.failed, 2)
  assert.equal(stats.availability, 0.8)
  assert.equal(stats.byCode.find(row => row.code === 'timeout').count, 2)
})

test('统计接口的 hours 只统计窗口内，非法值被拒绝', async t => {
  const { api, store } = await harness(t, { now: () => 200 * 3600_000 })
  const { sandbox } = await api('', 'POST', site)
  const id = sandbox.id
  store.record(id, 0, healthy, 1000, 'scheduled')
  store.record(id, 0, { ok: false, code: 'dns', statusCode: null, durationMs: 5 }, 199 * 3600_000, 'scheduled')

  const windowed = await api(`/${id}/stats?hours=2`)
  assert.equal(windowed.stats.total, 1, '两小时窗口只应包含较新的那条')
  assert.equal(windowed.stats.failed, 1)
  assert.equal((await api(`/${id}/stats?hours=0`)).status, 400)
  assert.equal((await api(`/${id}/stats?hours=abc`)).status, 400)
})

test('改动地址后统计仍包含旧记录，且旧记录标为非最新', async t => {
  const { api, store } = await harness(t)
  const { sandbox } = await api('', 'POST', site)
  const id = sandbox.id
  store.record(id, 0, healthy, 1000, 'manual')
  store.update(id, { ...site, url: 'https://beta.example/healthz', enabled: true }, 2000)
  store.record(id, store.generationOf(id), { ok: false, code: 'dns', statusCode: null, durationMs: 4 }, 3000, 'scheduled')

  const { stats } = await api(`/${id}/stats`)
  assert.equal(stats.total, 2, '换过地址也要能看到换之前的记录')
  const { checks } = await api(`/${id}/checks`)
  assert.equal(checks.length, 2)
  assert.equal(checks[0].latest, true)
  assert.equal(checks[1].latest, false)
})
