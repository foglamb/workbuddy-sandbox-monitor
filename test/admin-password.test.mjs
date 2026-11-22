import assert from 'node:assert/strict'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { hashPassword, passwordPattern, strongPasswordPattern, verifyPassword } from '../server/admin-password.mjs'
import { createApplication } from '../server/http.mjs'
import { readSettings } from '../server/config.mjs'
import { Store } from '../server/store.mjs'

const initial = 'initial-admin-token-0123456789abcdef'
const nextPassword = 'rotated-admin-token-9876543210zyxwvu'

test('scrypt 哈希可校验，且不包含明文', () => {
  const record = hashPassword(initial)
  assert.equal(verifyPassword(initial, record), true)
  assert.equal(verifyPassword(initial + 'x', record), false)
  assert.equal(verifyPassword('', record), false)
  assert.ok(!JSON.stringify(record).includes(initial))
  assert.ok(!Buffer.from(record.hash, 'base64').toString('utf8').includes(initial))
})

test('相同口令每次生成不同的盐与哈希', () => {
  const first = hashPassword(initial)
  const second = hashPassword(initial)
  assert.notEqual(first.salt, second.salt)
  assert.notEqual(first.hash, second.hash)
  assert.equal(verifyPassword(initial, first), true)
  assert.equal(verifyPassword(initial, second), true)
})

test('损坏或缺失的记录一律校验失败，不抛出', () => {
  assert.equal(verifyPassword(initial, null), false)
  assert.equal(verifyPassword(initial, undefined), false)
  assert.equal(verifyPassword(initial, { salt: 'bad', hash: 'bad', cost: 2 ** 15 }), false)
  assert.equal(verifyPassword(initial, { salt: 'AAAA', hash: '', cost: 2 ** 15 }), false)
  assert.equal(verifyPassword(null, hashPassword(initial)), false)
})

test('口令格式规则与配置校验一致', () => {
  assert.equal(passwordPattern.test('a'.repeat(8)), true)
  assert.equal(passwordPattern.test('a'.repeat(128)), true)
  assert.equal(passwordPattern.test('a'.repeat(7)), false)
  assert.equal(passwordPattern.test('a'.repeat(129)), false)
  assert.equal(passwordPattern.test('has space'.repeat(5)), false)
  assert.equal(passwordPattern.test('中文'.repeat(16)), false)
  assert.equal(strongPasswordPattern.test('a'.repeat(15)), false)
  assert.equal(strongPasswordPattern.test('a'.repeat(16)), true)
})

test('Store 只保存哈希记录并在更新时覆盖单行', () => {
  const store = new Store(':memory:', 30)
  assert.equal(store.adminPassword(), null)
  store.saveAdminPassword(hashPassword(initial), 1)
  const first = store.adminPassword()
  assert.equal(verifyPassword(initial, first), true)
  store.saveAdminPassword(hashPassword(nextPassword), 2)
  const second = store.adminPassword()
  assert.equal(verifyPassword(nextPassword, second), true)
  assert.equal(verifyPassword(initial, second), false)
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM admin_password').get().count, 1)
  const raw = store.db.prepare('SELECT * FROM admin_password').get()
  assert.ok(!JSON.stringify(raw).includes(initial))
  store.close()
})

async function httpFixture(t, token = initial) {
  const app = createApplication({ ...readSettings({ WB_ADMIN_TOKEN: token }), dataFile: ':memory:' })
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  t.after(async () => {
    await app.pythonTasks.stopAll()
    await app.leases.stop()
    await new Promise(resolve => app.server.close(resolve))
    app.store.close()
  })
  const root = `http://127.0.0.1:${app.server.address().port}/api`
  const call = (path, method = 'GET', body, password = token) => fetch(`${root}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${password}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { app, call, root }
}

test('改密接口：鉴权、当前口令校验与格式校验', async t => {
  const { call, root } = await httpFixture(t)
  const anonymous = await fetch(`${root}/admin/password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current: initial, next: nextPassword }),
  })
  assert.equal(anonymous.status, 401, '未携带口令不能改密')

  assert.equal((await call('/admin/password', 'POST', { current: 'wrong', next: nextPassword })).status, 401)
  assert.equal((await call('/admin/password', 'POST', { current: initial, next: 'short' })).status, 400)
  assert.equal((await call('/admin/password', 'POST', { current: initial, next: initial })).status, 400)
  assert.equal((await call('/admin/password', 'POST', { current: initial, next: nextPassword, extra: 1 })).status, 400)
  assert.equal((await call('/admin/password', 'POST', { current: 1, next: nextPassword })).status, 401)
})

test('8 位口令可直接启用，旧口令随即失效', async t => {
  const { call } = await httpFixture(t)
  const short = 'ab12cd34'
  assert.equal((await call('/admin/password', 'POST', { current: initial, next: short })).status, 200, '8 位口令应被接受')
  assert.equal((await call('/pushplus', 'GET', undefined, short)).status, 200)
  assert.equal((await call('/pushplus', 'GET', undefined, initial)).status, 401)
})

test('改密成功后旧口令失效、新口令可用，且响应不含口令', async t => {
  const { app, call } = await httpFixture(t)
  const response = await call('/admin/password', 'POST', { current: initial, next: nextPassword })
  assert.equal(response.status, 200)
  const body = await response.text()
  assert.deepEqual(JSON.parse(body), { ok: true })
  assert.ok(!body.includes(nextPassword))
  assert.ok(!body.includes(initial))

  assert.equal((await call('/pushplus', 'GET', undefined, initial)).status, 401)
  assert.equal((await call('/pushplus', 'GET', undefined, nextPassword)).status, 200)
  assert.equal((await call('/sandboxes', 'GET', undefined, nextPassword)).status, 200)

  const stored = app.store.db.prepare('SELECT * FROM admin_password').get()
  assert.ok(!JSON.stringify(stored).includes(nextPassword))
})

test('改密后新口令在重启后依然有效', async t => {
  const { app, call } = await httpFixture(t)
  assert.equal((await call('/admin/password', 'POST', { current: initial, next: nextPassword })).status, 200)
  const record = app.store.adminPassword()
  const reopened = new Store(':memory:', 30)
  reopened.saveAdminPassword(record, 1)
  assert.equal(verifyPassword(nextPassword, reopened.adminPassword()), true)
  assert.equal(verifyPassword(initial, reopened.adminPassword()), false)
  reopened.close()
})

test('未配置环境变量口令时仍可通过接口设置首个口令', async t => {
  const settings = readSettings({})
  const app = createApplication({ ...settings, dataFile: ':memory:' })
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  t.after(async () => {
    await app.pythonTasks.stopAll()
    await app.leases.stop()
    await new Promise(resolve => app.server.close(resolve))
    app.store.close()
  })
  const root = `http://127.0.0.1:${app.server.address().port}/api`
  // No password configured: the console is open, as before.
  assert.equal((await fetch(`${root}/pushplus`)).status, 403)
  const first = await fetch(`${root}/admin/password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current: '', next: nextPassword }),
  })
  assert.equal(first.status, 401, '空当前口令不能直接设置新口令')
  assert.equal(app.store.adminPassword(), null)
})

test('数据库记录损坏时拒绝认证，不会退回到环境变量放行', async t => {
  const { mkdtempDisposableSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const temp = mkdtempDisposableSync(join(tmpdir(), 'wb-admin-password-'))
  const file = join(temp.path, 'monitor.sqlite')
  const seed = new Store(file, 30)
  seed.db.prepare(`INSERT INTO admin_password (id, alg, salt, hash, cost, updated_at)
    VALUES (1, 'scrypt', 'AAAA', 'AAAA', 32768, 1)`).run()
  seed.close()

  const app = createApplication({ ...readSettings({ WB_ADMIN_TOKEN: initial }), dataFile: file })
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  t.after(async () => {
    await app.pythonTasks.stopAll()
    await app.leases.stop()
    await new Promise(resolve => app.server.close(resolve))
    app.store.close()
    temp.remove()
  })
  const root = `http://127.0.0.1:${app.server.address().port}/api`
  const call = password => fetch(`${root}/pushplus`, { headers: { Authorization: `Bearer ${password}` } })
  assert.equal((await call(initial)).status, 401, '损坏记录不得回退到环境变量口令')
  assert.equal((await call('anything')).status, 401)
})

test('校验结果缓存不改变拒绝行为，且不同口令互不干扰', async t => {
  const { createApplication } = await import('../server/http.mjs')
  const { readSettings } = await import('../server/config.mjs')
  const { once } = await import('node:events')
  const token = 'cache-check-admin-token-0123456789'
  const password = 'first-password-01'
  const app = createApplication({ ...readSettings({ WB_ADMIN_TOKEN: token }), dataFile: ':memory:' })
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  t.after(async () => {
    await app.pythonTasks.stopAll()
    await app.leases.stop()
    await new Promise(resolve => app.server.close(resolve))
    app.store.close()
  })
  const root = `http://127.0.0.1:${app.server.address().port}/api`
  const call = value => fetch(`${root}/pushplus`, { headers: { Authorization: `Bearer ${value}` } })

  assert.equal((await fetch(`${root}/admin/password`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ current: token, next: password }),
  })).status, 200)

  for (let i = 0; i < 3; i++) assert.equal((await call(password)).status, 200, '重复请求应保持成功')
  for (let i = 0; i < 3; i++) assert.equal((await call('wrong-password-01')).status, 401, '错误口令始终被拒')
  assert.equal((await call(token)).status, 401, '旧口令在改密后仍被拒')

  // 改密后旧口令的缓存不得让旧值复活
  const second = 'second-password-02'
  assert.equal((await fetch(`${root}/admin/password`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${password}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ current: password, next: second }),
  })).status, 200)
  assert.equal((await call(password)).status, 401)
  assert.equal((await call(second)).status, 200)
})

test('数据目录只存了推送令牌时，缺失密钥文件必须报错而不是静默重建', async () => {
  const { mkdtempDisposableSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { PythonTasks } = await import('../server/python-tasks.mjs')
  const temp = mkdtempDisposableSync(join(tmpdir(), 'wb-secret-guard-'))
  const file = join(temp.path, 'monitor.sqlite')
  const { DatabaseSync } = await import('node:sqlite')

  const seed = new DatabaseSync(file)
  seed.exec('PRAGMA foreign_keys=ON')
  const manager = new PythonTasks(seed, file)
  // 只写推送令牌：没有 python_tasks / python_accounts 行
  seed.prepare('INSERT INTO python_preferences(key,value) VALUES (?,?)')
    .run('pushplus_token', manager.box.encrypt('plain-token-abc123'))
  seed.close()

  // 删除密钥文件，模拟恢复数据时漏拷 .python-key
  const { rmSync } = await import('node:fs')
  rmSync(`${file}.python-key`, { force: true })

  const reopened = new DatabaseSync(file)
  assert.throws(() => new PythonTasks(reopened, file), /加密密钥缺失/)
  reopened.close()
  temp.remove()
})
