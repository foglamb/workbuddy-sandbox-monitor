import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtempDisposableSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { PythonTasks } from '../server/python-tasks.mjs'

const secret = 'shared-account-fixture-access-01234567'
function fixture(t) {
  const directory = mkdtempDisposableSync(join(tmpdir(), 'wb-shared-test-'))
  const file = join(directory.path, 'test.sqlite')
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys=ON')
  const manager = new PythonTasks(db, file)
  t.after(async () => { await manager.stopAll(); db.close(); directory.remove() })
  return { db, manager, file }
}
function account(manager, base = 'https://fixture.example') {
  return manager.shared.save({ name: '共用账号', base, uid: 'fixture-user', credentials: { JWT: secret } })
}

test('共享账号、全局继承与单沙盒覆盖分开保存，旧独立配置不受默认值变更影响', t => {
  const { manager, db } = fixture(t)
  const legacy = manager.save({ name: '旧独立配置', params: { HEARTBEAT_TIMEOUT: 22 } })
  const profile = account(manager)
  manager.shared.saveDefaults({ params: { HEARTBEAT_TIMEOUT: 60, RECONNECT_MAX: 10000, RECONNECT_BASE: 5000 } })
  const a = manager.save({ name: '继承默认', accountId: profile.id, params: { CONV_ID: 'a' } })
  const b = manager.save({ name: '单独覆盖', accountId: profile.id, params: { CONV_ID: 'b', HEARTBEAT_TIMEOUT: 25 } })
  assert.equal(a.params.UID, 'fixture-user')
  assert.equal(a.params.HEARTBEAT_TIMEOUT, 60)
  assert.equal(b.params.HEARTBEAT_TIMEOUT, 25)
  assert.deepEqual(a.overrideKeys, ['CONV_ID'])
  assert.equal(a.accountName, '共用账号')
  assert.equal(manager.reveal(a.id).JWT, secret)
  const stored = JSON.parse(manager.row(a.id).config)
  assert.deepEqual(stored.params, { CONV_ID: 'a' })
  const profileRecord = db.prepare('SELECT credentials FROM python_accounts WHERE id=?').get(profile.id)
  assert.ok(!profileRecord.credentials.includes(secret))
  assert.ok(!JSON.stringify(manager.shared.list()).includes(secret))
  manager.shared.saveDefaults({ params: { HEARTBEAT_TIMEOUT: 90 } })
  assert.equal(manager.view(a.id).params.HEARTBEAT_TIMEOUT, 90)
  assert.equal(manager.view(b.id).params.HEARTBEAT_TIMEOUT, 25)
  assert.equal(manager.view(legacy.id).params.HEARTBEAT_TIMEOUT, 22)
  assert.throws(() => manager.shared.saveDefaults({ params: { UID: 'wrong-layer' } }))
  assert.throws(() => manager.save({ name: '违规覆盖', accountId: profile.id, params: { UID: 'other' } }), /统一设置/)
  assert.throws(() => manager.save({ name: '违规凭据', accountId: profile.id, params: {}, credentials: { JWT: secret } }), /统一设置/)
  assert.throws(() => manager.shared.remove(profile.id), /仍有沙盒/)
})

test('从旧配置提取共享账号不修改原配置，可查看和单独替换账号凭据', t => {
  const { manager, db, file } = fixture(t)
  const old = manager.save({ name: '已有配置', params: { BASE: 'https://fixture.example', UID: 'existing-user', CONV_ID: 'old' }, credentials: { JWT: secret } })
  const profile = manager.shared.save({ name: '从旧配置提取', sourceTaskId: old.id }, undefined, id => manager.effective(manager.row(id)))
  assert.equal(profile.uid, 'existing-user')
  assert.equal(manager.shared.reveal(profile.id).JWT, secret)
  assert.equal(manager.view(old.id).accountId, null)
  manager.shared.save({ name: '已更新账号', uid: 'next-user', credentials: { RT: 'shared-fixture-refresh-01234567' } }, profile.id)
  assert.equal(manager.shared.reveal(profile.id).JWT, secret)
  assert.equal(manager.shared.view(profile.id).uid, 'next-user')
  const reopened = new PythonTasks(db, file)
  assert.equal(reopened.shared.reveal(profile.id).RT, 'shared-fixture-refresh-01234567')
  assert.equal(reopened.view(old.id).params.UID, 'existing-user')
  manager.shared.remove(profile.id)
  assert.deepEqual(manager.shared.list(), [])
})

test('修改共享默认或账号不会改变当前运行进程，停止重启后才使用新值', { timeout: 12_000 }, async t => {
  const requests = []
  const stub = createServer((req, res) => { requests.push(req.headers['x-user-id']); res.writeHead(503); res.end('local-only') })
  stub.listen(0, '127.0.0.1')
  await once(stub, 'listening')
  t.after(() => new Promise(resolve => stub.close(resolve)))
  const { manager } = fixture(t)
  const profile = account(manager, `http://127.0.0.1:${stub.address().port}`)
  manager.shared.saveDefaults({ params: { PULSE_ENABLE: false, STATE_ENABLE: false, LOG_TO_FILE: false, HEARTBEAT_TIMEOUT: 12 } })
  const task = manager.save({ name: '运行快照', accountId: profile.id, params: { CONV_ID: 'fixture-session' } })
  manager.start(task.id)
  for (let n = 0; n < 200 && !requests.length; n++) await delay(20)
  assert.ok(requests.length > 0)
  const pid = manager.view(task.id).pid
  manager.shared.saveDefaults({ params: { HEARTBEAT_TIMEOUT: 80 } })
  manager.shared.save({ name: '共用账号', uid: 'next-user' }, profile.id)
  const pending = manager.view(task.id)
  assert.equal(pending.pid, pid)
  assert.equal(pending.runningParams.HEARTBEAT_TIMEOUT, 12)
  assert.equal(pending.runningParams.UID, 'fixture-user')
  assert.equal(pending.params.HEARTBEAT_TIMEOUT, 80)
  assert.equal(pending.params.UID, 'next-user')
  await manager.stop(task.id)
  requests.length = 0
  manager.start(task.id)
  for (let n = 0; n < 200 && !requests.length; n++) await delay(20)
  assert.ok(requests.length > 0)
  assert.ok(requests.every(uid => uid === 'next-user'))
  assert.equal(manager.view(task.id).runningParams.HEARTBEAT_TIMEOUT, 80)
  await manager.stop(task.id)
})
