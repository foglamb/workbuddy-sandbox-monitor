import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtempDisposableSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { PythonTasks } from '../server/python-tasks.mjs'
import { pythonSchema, validatePythonInput } from '../server/python-config.mjs'
import { createApplication } from '../server/http.mjs'
import { readSettings } from '../server/config.mjs'

const credential = 'local-fake-access-token-0123456789'
const input = { name: '测试 Python 配置', notes: '保留参数', params: {}, credentials: { JWT: credential } }
async function until(check) {
  for (let count = 0; count < 200; count++) { if (check()) return; await delay(20) }
  assert.fail('等待脚本状态超时')
}
function fixture(t) {
  const temp = mkdtempDisposableSync(join(tmpdir(), 'wb-python-test-'))
  const file = join(temp.path, 'test.sqlite')
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys=ON')
  const manager = new PythonTasks(db, file)
  t.after(async () => { await manager.stopAll(); db.close(); temp.remove() })
  return { manager, db, file, temp }
}

test('原脚本运行副本没有内置凭据，参数以明确的类型保存', () => {
  const script = readFileSync(new URL('../server/python/workbuddy.py', import.meta.url), 'utf8')
  assert.doesNotMatch(script, /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}/)
  for (const key of ['JWT', 'RT', 'CONV_ID', 'UID', 'SITE']) assert.ok(script.includes(`${key} = ""`))
  const saved = validatePythonInput(input)
  assert.equal(Object.keys(saved.params).length, pythonSchema.length)
  assert.equal(saved.params.PULSE_ENABLE, true)
  assert.throws(() => validatePythonInput({ ...input, params: { PULSE_ENABLE: 'false' } }))
  assert.throws(() => validatePythonInput({ ...input, params: { PULSE_ENABLE: null } }))
  assert.throws(() => validatePythonInput({ ...input, params: { PULSE_INTERVAL: 0 } }))
  assert.throws(() => validatePythonInput({ ...input, params: { STATE_FILE: '/tmp/example' } }))
})

test('保存/查看参数与凭据三态、加密持久化和日志游标', t => {
  const { manager, db } = fixture(t)
  const task = manager.save(input)
  assert.equal(task.hasJWT, true)
  assert.equal(task.hasRT, false)
  assert.ok(!JSON.stringify(task).includes(credential))
  assert.ok(!db.prepare('SELECT credentials FROM python_tasks').get().credentials.includes(credential))
  assert.equal(manager.reveal(task.id).JWT, credential)
  const firstRevision = manager.row(task.id).revision
  manager.save({ name: '已改名', params: task.params }, task.id)
  assert.equal(manager.reveal(task.id).JWT, credential)
  assert.equal(manager.row(task.id).revision, firstRevision)
  manager.save({ ...input, credentials: { JWT: null, RT: 'different-fake-refresh-01234567' } }, task.id)
  assert.equal(manager.reveal(task.id).JWT, '')
  assert.equal(manager.view(task.id).hasRT, true)
  manager.log(task.id, 'stdout', `unsafe ${credential}`, [credential])
  const logs = manager.logs(task.id, 0)
  assert.ok(!JSON.stringify(logs).includes(credential))
  assert.equal(manager.logs(task.id, logs.nextAfter).logs.length, 0)
  assert.throws(() => manager.logs(task.id, -1))
  manager.remove(task.id)
  assert.deepEqual(manager.list(), [])
})

test('实际启动原 Python 脚本的两个独立进程并读取日志，可单独停止；网络只连接本地测试服务器', { timeout: 12_000 }, async t => {
  const server = createServer((_req, res) => {
    res.writeHead(503, { 'Content-Type': 'text/plain' })
    res.end(`fixture error contains ${credential}`)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const { manager } = fixture(t)
  const params = { BASE: `http://127.0.0.1:${server.address().port}`, CONV_ID: 'fixture-conversation', UID: 'fixture-user',
    PULSE_ENABLE: false, SITE_ENABLE: false, STATE_ENABLE: false, LOG_TO_FILE: false,
    RECONNECT_BASE: 1000, RECONNECT_MAX: 2000 }
  const a = manager.save({ ...input, params })
  const b = manager.save({ ...input, name: '第二份配置', params: { ...params, CONV_ID: 'fixture-two' } })
  assert.throws(() => manager.start(manager.save({ name: '缺少凭据', params: {} }).id), /填写 CONV_ID/)
  const firstRun = manager.start(a.id)
  manager.start(b.id)
  await until(() => manager.view(a.id).status === 'running' && manager.view(b.id).status === 'running')
  assert.notEqual(manager.view(a.id).pid, manager.view(b.id).pid)
  assert.match(manager.view(a.id).runId, /^[a-f0-9-]{36}$/)
  assert.throws(() => manager.start(a.id), /已经在运行/)
  await assert.rejects(manager.stop(a.id, '00000000-0000-4000-8000-000000000000'), error => error.code === 'stale_python_run')
  assert.equal(manager.view(a.id).status, 'running', '过期停止请求不能影响当前运行')
  assert.throws(() => manager.save({ ...input, params }, a.id), /先停止/)
  assert.throws(() => manager.remove(a.id), /先停止/)
  await until(() => manager.logs(a.id, 0).logs.some(row => row.text.includes('session 失败')))
  assert.ok(!JSON.stringify(manager.logs(a.id, 0)).includes(credential))
  assert.equal((await manager.stop(a.id, firstRun.runId)).status, 'stopped')
  const replacement = manager.start(a.id)
  await until(() => manager.view(a.id).status === 'running')
  assert.notEqual(replacement.runId, firstRun.runId)
  await assert.rejects(manager.stop(a.id, firstRun.runId), error => error.code === 'stale_python_run')
  assert.equal(manager.view(a.id).runId, replacement.runId)
  assert.equal(manager.view(a.id).status, 'running', '旧运行停止请求不能停止重新启动的进程')
  assert.equal((await manager.stop(a.id, replacement.runId)).status, 'stopped')
  assert.equal(manager.view(b.id).status, 'running')
  assert.equal((await manager.stop(b.id)).status, 'stopped')
})

test('运行时限到期会停止原进程并清理状态', { timeout: 8_000 }, async t => {
  const server = createServer((_req, res) => { res.writeHead(503); res.end('fixture') })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const { manager } = fixture(t)
  const params = { BASE: `http://127.0.0.1:${server.address().port}`, CONV_ID: 'timed-fixture', UID: 'local-test',
    PULSE_ENABLE: false, SITE_ENABLE: false, STATE_ENABLE: false, LOG_TO_FILE: false,
    RECONNECT_BASE: 1000, RECONNECT_MAX: 2000 }
  const task = manager.save({ ...input, params })
  assert.throws(() => manager.start(task.id, { durationSeconds: 0 }), /运行时限/)
  assert.throws(() => manager.start(task.id, { durationSeconds: 1.5 }), /运行时限/)
  assert.throws(() => manager.start(task.id, { durationSeconds: 2_147_484 }), /运行时限/)
  manager.start(task.id, { durationSeconds: 1 })
  await until(() => manager.view(task.id).status === 'running')
  assert.equal(manager.view(task.id).runDurationSeconds, 1)
  await until(() => manager.view(task.id).status === 'stopped')
  assert.equal(manager.view(task.id).pid, null)
  assert.ok(manager.logs(task.id, 0).logs.some(row => row.text.includes('运行时限 1 秒已到')))
  const early = manager.start(task.id, { durationSeconds: 1 })
  await until(() => manager.view(task.id).status === 'running')
  await manager.stop(task.id, early.runId)
  const replacement = manager.start(task.id)
  await until(() => manager.view(task.id).status === 'running')
  await assert.rejects(manager.stop(task.id, early.runId), error => error.code === 'stale_python_run')
  await delay(1100)
  assert.equal(manager.view(task.id).runId, replacement.runId)
  assert.equal(manager.view(task.id).status, 'running', '提前停止时必须取消旧计时器')
  await manager.stop(task.id, replacement.runId)
})

test('日志和退出状态存储失败时仍完成限时停止及后续手动停止', { timeout: 8_000 }, async t => {
  const server = createServer((_req, res) => { res.writeHead(503); res.end('fixture') })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const { manager, db } = fixture(t)
  const params = { BASE: `http://127.0.0.1:${server.address().port}`, CONV_ID: 'storage-fixture', UID: 'local-test',
    PULSE_ENABLE: false, SITE_ENABLE: false, STATE_ENABLE: false, LOG_TO_FILE: false,
    RECONNECT_BASE: 1000, RECONNECT_MAX: 2000 }
  const task = manager.save({ ...input, params })
  const prepare = db.prepare.bind(db)
  let rejectStart = true
  t.mock.method(db, 'prepare', (sql, ...args) => {
    if (rejectStart && sql.startsWith('UPDATE python_tasks SET last_started=')) {
      rejectStart = false
      throw new Error('模拟启动状态写入失败')
    }
    if (sql.startsWith('INSERT INTO python_task_logs') || sql.startsWith('UPDATE python_tasks SET last_stopped=')) {
      throw Object.assign(new Error('模拟写入失败'), { code: 'SQLITE_FULL' })
    }
    return prepare(sql, ...args)
  })
  const warning = t.mock.method(console, 'error', () => {})
  assert.throws(() => manager.start(task.id, { durationSeconds: 1 }), /模拟启动状态写入失败/)
  assert.equal(manager.active.size, 0)
  manager.start(task.id, { durationSeconds: 1 })
  await until(() => manager.view(task.id).status === 'running')
  await until(() => manager.view(task.id).status === 'stopped')
  assert.equal(manager.active.size, 0)
  assert.equal(manager.view(task.id).pid, null)
  const second = manager.start(task.id)
  await until(() => manager.view(task.id).status === 'running')
  assert.equal((await manager.stop(task.id, second.runId)).status, 'stopped')
  assert.equal(manager.active.size, 0)
  assert.equal(warning.mock.calls.length, 2)
  assert.ok(warning.mock.calls.every(call => call.arguments[0] === '无法保存 Python 进程退出状态；进程已结束。'))
})

test('脚本参数接口要求认证，只有显式查看才返回凭据', async t => {
  const token = 'python-api-local-admin-only-01234567890'
  const app = createApplication({ ...readSettings({ WB_ADMIN_TOKEN: token }), dataFile: ':memory:' })
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  t.after(async () => { await app.pythonTasks.stopAll(); await app.leases.stop(); await new Promise(resolve => app.server.close(resolve)); app.store.close() })
  const root = `http://127.0.0.1:${app.server.address().port}/api`
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  assert.equal((await fetch(root + '/python-tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).status, 401)
  const response = await fetch(root + '/python-tasks', { method: 'POST', headers, body: JSON.stringify(input) })
  assert.equal(response.status, 201)
  const { task } = await response.json()
  assert.equal((await fetch(root + `/python-tasks/${task.id}/start`, { method: 'POST', headers, body: JSON.stringify({ durationSeconds: 0 }) })).status, 400)
  assert.equal((await fetch(root + `/python-tasks/${task.id}/start`, { method: 'POST', headers, body: JSON.stringify({ unexpected: true }) })).status, 400)
  assert.equal((await fetch(root + `/python-tasks/${task.id}/stop`, { method: 'POST', headers, body: JSON.stringify({ runId: 'stale' }) })).status, 400)
  const snapshot = await (await fetch(root + '/sandboxes', { headers })).json()
  assert.equal(snapshot.pythonEnabled, true)
  assert.equal(snapshot.pythonTasks[0].id, task.id)
  assert.ok(!JSON.stringify(snapshot).includes(credential))
  assert.equal((await fetch(root + `/python-tasks/${task.id}/reveal`, { method: 'POST', headers: { ...headers, Origin: 'https://other.example' } })).status, 403)
  const revealed = await (await fetch(root + `/python-tasks/${task.id}/reveal`, { method: 'POST', headers })).json()
  assert.equal(revealed.credentials.JWT, credential)
})
