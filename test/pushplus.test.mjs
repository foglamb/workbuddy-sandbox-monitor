import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { PushPlusService } from '../server/pushplus.mjs'
import { createSecretBox } from '../server/python-secrets.mjs'

function fixture(options = {}) {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE python_preferences(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    return options.reply ?? { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, msg: 'ok' }) }
  }
  const service = new PushPlusService(db, createSecretBox(':memory:', false), { fetchImpl, now: () => 1_700_000_000_000 })
  return { db, service, calls }
}

test('默认关闭且不发送任何请求', async () => {
  const { service, calls } = fixture()
  assert.deepEqual(service.view(), { enabled: false, hasToken: false, topic: '', events: [] })
  assert.deepEqual(await service.notify('started', 't', 'c'), { ok: false, skipped: true })
  assert.equal(calls.length, 0)
})

test('启用前必须提供 Token，Token 加密保存且不出现在视图中', () => {
  const { service, db } = fixture()
  assert.throws(() => service.save({ enabled: true }))
  const saved = service.save({ enabled: true, token: 'abc123', topic: 'team', events: ['started', 'failure'] })
  assert.deepEqual(saved, { enabled: true, hasToken: true, topic: 'team', events: ['started', 'failure'] })
  const stored = db.prepare("SELECT value FROM python_preferences WHERE key='pushplus_token'").get().value
  assert.ok(!stored.includes('abc123'))
  assert.equal(service.token(), 'abc123')
})

test('Token 三态：省略保留、空字符串清除、字符串替换', () => {
  const { service } = fixture()
  service.save({ enabled: false, token: 'first123' })
  service.save({ enabled: false, topic: 'x' })
  assert.equal(service.token(), 'first123')
  service.save({ enabled: false, token: '' })
  assert.equal(service.token(), '')
  assert.equal(service.view().hasToken, false)
  service.save({ enabled: false, token: 'second456' })
  assert.equal(service.token(), 'second456')
})

test('只发送已订阅事件，未订阅事件不产生请求', async () => {
  const { service, calls } = fixture()
  service.save({ enabled: true, token: 'abc123', events: ['failure'] })
  await service.notify('started', 't', 'c')
  await service.notify('stopped', 't', 'c')
  assert.equal(calls.length, 0)
  assert.equal((await service.notify('failure', '标题', '正文')).ok, true)
  assert.equal(calls.length, 1)
})

test('请求体包含 Token、标题、正文与群组，且不携带未知字段', async () => {
  const { service, calls } = fixture()
  service.save({ enabled: true, token: 'abc123', topic: 'grp', events: ['started'] })
  await service.notify('started', '标题A', '正文B')
  const body = calls[0].body
  assert.equal(calls[0].url, 'https://www.pushplus.plus/send')
  assert.deepEqual(Object.keys(body).sort(), ['content', 'template', 'title', 'token', 'topic'])
  assert.equal(body.token, 'abc123')
  assert.equal(body.title, '标题A')
  assert.equal(body.content, '正文B')
})

test('未配置群组时不发送 topic 字段', async () => {
  const { service, calls } = fixture()
  service.save({ enabled: true, token: 'abc123', events: ['started'] })
  await service.notify('started', 't', 'c')
  assert.equal(Object.hasOwn(calls[0].body, 'topic'), false)
})

test('网络异常与上游错误码都不抛出，返回未成功', async () => {
  const failing = new PushPlusService(new DatabaseSync(':memory:'), createSecretBox(':memory:', false), {
    fetchImpl: async () => { throw new Error('offline') },
  })
  failing.db.exec('CREATE TABLE python_preferences(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
  failing.save({ enabled: true, token: 'abc123', events: ['started'] })
  assert.deepEqual(await failing.notify('started', 't', 'c'), { ok: false, reason: 'network' })

  const rejected = fixture({ reply: { ok: true, status: 200, text: async () => JSON.stringify({ code: 903, msg: 'token 无效' }) } })
  rejected.service.save({ enabled: true, token: 'abc123', events: ['started'] })
  assert.deepEqual(await rejected.service.notify('started', 't', 'c'), { ok: false, httpStatus: 200, code: 903 })
})

test('测试消息在缺少 Token 时拒绝发送', async () => {
  const { service, calls } = fixture()
  await assert.rejects(() => service.test(), error => error.status === 400)
  assert.equal(calls.length, 0)
})

test('测试消息成功后返回送达结果', async () => {
  const { service, calls } = fixture()
  service.save({ enabled: true, token: 'abc123', events: ['started'] })
  const result = await service.test()
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.match(calls[0].body.content, /推送通道测试成功/)
})

test('拒绝未知字段与非法事件名，避免静默写入', () => {
  const { service } = fixture()
  assert.throws(() => service.save({ enabled: false, unexpected: 1 }))
  assert.throws(() => service.save({ enabled: false, events: ['not-an-event'] }))
  assert.throws(() => service.save({ enabled: 'yes' }))
  assert.throws(() => service.save({ enabled: false, token: 'has space' }))
})

test('保存配置不影响其它偏好项', () => {
  const { service, db } = fixture()
  db.prepare("INSERT INTO python_preferences(key,value) VALUES ('defaults','{\"X\":1}')").run()
  service.save({ enabled: true, token: 'abc123', events: ['started'] })
  assert.equal(db.prepare("SELECT value FROM python_preferences WHERE key='defaults'").get().value, '{"X":1}')
})

test('HTTP 接口：鉴权、三态保存、测试发送与配置持久化', async t => {
  const { createApplication } = await import('../server/http.mjs')
  const { readSettings } = await import('../server/config.mjs')
  const { once } = await import('node:events')
  const token = 'pushplus-local-admin-only-012345678901'
  const delivered = []
  const app = createApplication({ ...readSettings({ WB_ADMIN_TOKEN: token }), dataFile: ':memory:' }, {
    pushplusFactory: (db, box, options) => new PushPlusService(db, box, {
      ...options,
      fetchImpl: async (url, init) => {
        delivered.push(JSON.parse(init.body))
        return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, msg: 'ok' }) }
      },
    }),
  })
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  t.after(async () => {
    await app.pythonTasks.stopAll()
    await app.leases.stop()
    await new Promise(resolve => app.server.close(resolve))
    app.store.close()
  })
  const root = `http://127.0.0.1:${app.server.address().port}/api`
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  assert.equal((await fetch(`${root}/pushplus`)).status, 401)
  const initial = await (await fetch(`${root}/pushplus`, { headers })).json()
  assert.deepEqual(initial.pushplus, { enabled: false, hasToken: false, topic: '', events: [] })

  assert.equal((await fetch(`${root}/pushplus`, { method: 'PUT', headers, body: JSON.stringify({ unexpected: true }) })).status, 400)
  assert.equal((await fetch(`${root}/pushplus`, { method: 'PUT', headers, body: JSON.stringify({ enabled: true }) })).status, 400)

  const savedResponse = await fetch(`${root}/pushplus`, {
    method: 'PUT', headers,
    body: JSON.stringify({ enabled: true, token: 'token123abc', topic: 'grp', events: ['failure'] }),
  })
  assert.equal(savedResponse.status, 200)
  const savedText = await savedResponse.text()
  assert.ok(!savedText.includes('token123abc'))
  assert.deepEqual(JSON.parse(savedText).pushplus, { enabled: true, hasToken: true, topic: 'grp', events: ['failure'] })

  assert.equal((await fetch(`${root}/pushplus/test`, { method: 'POST', headers })).status, 200)
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].token, 'token123abc')
  assert.equal(delivered[0].topic, 'grp')

  const reloaded = await (await fetch(`${root}/pushplus`, { headers })).json()
  assert.deepEqual(reloaded.pushplus, { enabled: true, hasToken: true, topic: 'grp', events: ['failure'] })
})

test('未订阅事件不会因任务状态变化触发推送', async () => {
  const { service, calls } = fixture()
  service.save({ enabled: true, token: 'abc123', events: [] })
  await service.notify('started', 't', 'c')
  await service.notify('stopped', 't', 'c')
  await service.notify('failure', 't', 'c')
  assert.equal(calls.length, 0)
})

test('真实子进程启动失败时按订阅事件触发推送载荷', async t => {
  const { PythonTasks } = await import('../server/python-tasks.mjs')
  const { mkdtempDisposableSync } = await import('node:fs')
  const { DatabaseSync } = await import('node:sqlite')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const temp = mkdtempDisposableSync(join(tmpdir(), 'wb-pushplus-run-'))
  const file = join(temp.path, 'test.sqlite')
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys=ON')
  const events = []
  // A missing interpreter fails at spawn, so this test never opens a socket.
  const manager = new PythonTasks(db, file, {
    python: 'python3-pushplus-offline-absent',
    onEvent: (event, payload) => events.push({ event, ...payload }),
  })
  t.after(async () => { await manager.stopAll(); db.close(); temp.remove() })

  const task = manager.save({
    name: '推送事件验证',
    params: { CONV_ID: 'local-fake-conversation', UID: 'local-fake-user' },
    credentials: { JWT: 'local-fake-token-0123456789' },
  })
  manager.start(task.id)
  const deadline = Date.now() + 15000
  while (manager.active.size > 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(manager.active.size, 0, '子进程应在时限内退出')
  assert.ok(events.length >= 1, '至少产生一个状态事件')
  assert.ok(events.some(item => item.event === 'started' || item.event === 'failure'))
  for (const item of events) {
    assert.ok(['started', 'stopped', 'failure'].includes(item.event))
    assert.ok(typeof item.title === 'string' && item.title.length > 0)
    assert.ok(!item.content.includes('local-fake-token-0123456789'), '推送载荷不得包含凭据')
  }
})
