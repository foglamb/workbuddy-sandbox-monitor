import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempDisposableSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { PythonTasks } from '../server/python-tasks.mjs'

function fixture(options = {}) {
  const temp = mkdtempDisposableSync(join(tmpdir(), 'wb-log-limit-'))
  const file = join(temp.path, 'monitor.sqlite')
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys=ON')
  const manager = new PythonTasks(db, file, options)
  const task = manager.save({
    name: '日志上限验证',
    params: { CONV_ID: 'local-conv', UID: 'local-user' },
    credentials: { JWT: 'local-fake-jwt-0123456789' },
  })
  return {
    manager, task, db, file,
    cleanup: async () => { await manager.stopAll(); db.close(); temp.remove() },
  }
}

test('日志行数按上限裁剪，只保留最新', async t => {
  const { manager, task, cleanup } = fixture({ logLines: 100 })
  t.after(cleanup)
  for (let i = 0; i < 250; i++) manager.log(task.id, 'stdout', `第 ${i} 行`)
  const rows = manager.db.prepare('SELECT text FROM python_task_logs WHERE task_id=? ORDER BY seq').all(task.id)
  assert.equal(rows.length, 100, '应只保留 100 行')
  assert.equal(rows.at(-1).text, '第 249 行', '最新一行必须保留')
  assert.equal(rows[0].text, '第 150 行', '最旧的行应被裁掉')
})

test('默认上限 1000 行，可在构造时调整', async t => {
  const small = fixture({ logLines: 5 })
  t.after(small.cleanup)
  for (let i = 0; i < 12; i++) small.manager.log(small.task.id, 'stdout', `L${i}`)
  assert.equal(small.manager.db.prepare('SELECT count(*) AS c FROM python_task_logs').get().c, 5)

  const big = fixture({ logLines: 2000 })
  t.after(big.cleanup)
  big.manager.clearLogs(big.task.id)
  for (let i = 0; i < 1500; i++) big.manager.log(big.task.id, 'stdout', `B${i}`)
  assert.equal(big.manager.db.prepare('SELECT count(*) AS c FROM python_task_logs').get().c, 1500)
})

test('多个任务的日志上限互不影响', async t => {
  const { manager, task, cleanup } = fixture({ logLines: 10 })
  t.after(cleanup)
  const second = manager.save({
    name: '第二份',
    params: { CONV_ID: 'conv-2', UID: 'user-2' },
    credentials: { JWT: 'local-fake-jwt-second-0123' },
  })
  for (let i = 0; i < 30; i++) {
    manager.log(task.id, 'stdout', `A${i}`)
    manager.log(second.id, 'stdout', `B${i}`)
  }
  const count = id => manager.db.prepare('SELECT count(*) AS c FROM python_task_logs WHERE task_id=?').get(id).c
  assert.equal(count(task.id), 10)
  assert.equal(count(second.id), 10)
  assert.equal(manager.db.prepare('SELECT text FROM python_task_logs WHERE task_id=? ORDER BY seq').all(second.id).at(-1).text, 'B29')
})

test('删除单个任务日志会清空数据库行与磁盘文件', async t => {
  const { manager, task, cleanup } = fixture({ logLines: 100 })
  t.after(cleanup)
  // 创建配置本身写入一条系统日志，先清空以获得确定计数
  manager.clearLogs(task.id)
  for (let i = 0; i < 20; i++) manager.log(task.id, 'stdout', `行 ${i}`)
  assert.equal(manager.db.prepare('SELECT count(*) AS c FROM python_task_logs WHERE task_id=?').get(task.id).c, 20)

  const directory = join(manager.directory, task.id)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const logPath = join(directory, 'keepalive-test123.log')
  writeFileSync(logPath, '磁盘日志内容\n'.repeat(10))
  assert.ok(existsSync(logPath))

  const { removed } = manager.clearLogs(task.id)
  assert.equal(removed, 20)
  assert.equal(manager.db.prepare('SELECT count(*) AS c FROM python_task_logs WHERE task_id=?').get(task.id).c, 0)
  assert.equal(existsSync(logPath), false, '磁盘日志文件应被删除')
})

test('删除全部日志覆盖所有任务', async t => {
  const { manager, task, cleanup } = fixture({ logLines: 100 })
  t.after(cleanup)
  const second = manager.save({
    name: '第二份',
    params: { CONV_ID: 'conv-2', UID: 'user-2' },
    credentials: { JWT: 'local-fake-jwt-second-0123' },
  })
  // 创建配置会各写一条系统日志，先清空以获得确定的计数
  manager.clearAllLogs()
  for (let i = 0; i < 10; i++) {
    manager.log(task.id, 'stdout', `A${i}`)
    manager.log(second.id, 'stdout', `B${i}`)
  }
  mkdirSync(join(manager.directory, task.id), { recursive: true, mode: 0o700 })
  mkdirSync(join(manager.directory, second.id), { recursive: true, mode: 0o700 })
  writeFileSync(join(manager.directory, task.id, 'keepalive-a.log'), 'x\n')
  writeFileSync(join(manager.directory, second.id, 'keepalive-b.log'), 'x\n')
  const { removed } = manager.clearAllLogs()
  assert.equal(removed, 20)
  assert.equal(manager.db.prepare('SELECT count(*) AS c FROM python_task_logs').get().c, 0)
  assert.equal(existsSync(join(manager.directory, task.id, 'keepalive-a.log')), false)
  assert.equal(existsSync(join(manager.directory, second.id, 'keepalive-b.log')), false)
})

test('清理日志不会误删非日志文件', async t => {
  const { manager, task, cleanup } = fixture({ logLines: 100 })
  t.after(cleanup)
  const directory = join(manager.directory, task.id)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const state = join(directory, 'state-abc.json')
  const other = join(directory, 'notes.txt')
  writeFileSync(state, '{"JWT":"x"}')
  writeFileSync(other, 'keep me')
  writeFileSync(join(directory, 'keepalive-run1.log'), '日志\n')

  manager.clearLogs(task.id)
  assert.ok(existsSync(state), '状态文件必须保留')
  assert.ok(existsSync(other), '其它文件必须保留')
  assert.equal(existsSync(join(directory, 'keepalive-run1.log')), false)
})

test('磁盘日志超出体积上限时在下次启动前轮转', async t => {
  const { manager, task, cleanup } = fixture({ logLines: 100, logFileBytes: 1024 })
  t.after(cleanup)
  const directory = join(manager.directory, task.id)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  // 直接验证 trimLogFile 行为：超过上限则改名，未超过则原样保留
  const small = join(directory, 'keepalive-small.log')
  writeFileSync(small, 'x'.repeat(100))
  manager.trimLogFile(small)
  assert.ok(existsSync(small), '未超上限不应改动文件')

  const big = join(directory, 'keepalive-big.log')
  writeFileSync(big, 'y'.repeat(4096))
  manager.trimLogFile(big)
  assert.equal(existsSync(big), false, '超上限原文件应被改名')
  const rotated = (await import('node:fs')).readdirSync(directory).filter(name => name.startsWith('keepalive-big.log.'))
  assert.equal(rotated.length, 1, '应留下一个轮转副本')
})

test('trimLogFile 对不存在的文件安静返回', async t => {
  const { manager, task, cleanup } = fixture()
  t.after(cleanup)
  assert.doesNotThrow(() => manager.trimLogFile(join(manager.directory, task.id, 'keepalive-missing.log')))
})

test('清空日志后再次写入仍受上限约束', async t => {
  const { manager, task, cleanup } = fixture({ logLines: 10 })
  t.after(cleanup)
  for (let i = 0; i < 15; i++) manager.log(task.id, 'stdout', `X${i}`)
  manager.clearLogs(task.id)
  for (let i = 0; i < 25; i++) manager.log(task.id, 'stdout', `Y${i}`)
  assert.equal(manager.db.prepare('SELECT count(*) AS c FROM python_task_logs WHERE task_id=?').get(task.id).c, 10)
  assert.equal(manager.db.prepare('SELECT text FROM python_task_logs WHERE task_id=? ORDER BY seq').all(task.id).at(-1).text, 'Y24')
})

test('清理不存在的任务会被拒绝', async t => {
  const { manager, cleanup } = fixture()
  t.after(cleanup)
  assert.throws(() => manager.clearLogs('00000000-0000-4000-8000-000000000000'), error => error.status === 404)
})

test('HTTP 接口：日志删除需鉴权，且返回清理行数', async t => {
  const { createApplication } = await import('../server/http.mjs')
  const { readSettings } = await import('../server/config.mjs')
  const { once } = await import('node:events')
  const token = 'log-clear-admin-token-0123456789ab'
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
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const created = await (await fetch(`${root}/python-tasks`, {
    method: 'POST', headers,
    body: JSON.stringify({ name: '接口验证', params: { CONV_ID: 'c1', UID: 'u1' }, credentials: { JWT: 'local-fake-jwt-0123456789' } }),
  })).json()
  const id = created.task.id
  // 创建配置本身会写入一条系统日志，因此先清空再计数
  app.pythonTasks.clearLogs(id)
  for (let i = 0; i < 5; i++) app.pythonTasks.log(id, 'stdout', `行 ${i}`)

  assert.equal((await fetch(`${root}/python-tasks/${id}/logs`, { method: 'DELETE' })).status, 401)
  assert.equal((await fetch(`${root}/python-logs`, { method: 'DELETE' })).status, 401)
  const one = await (await fetch(`${root}/python-tasks/${id}/logs`, { method: 'DELETE', headers })).json()
  assert.equal(one.removed, 5)
  assert.equal((await fetch(`${root}/python-tasks/${id}/logs`, { method: 'DELETE', headers })).status, 200)
  assert.equal((await (await fetch(`${root}/python-logs`, { method: 'DELETE', headers })).json()).removed, 0)
})

test('WB_LOG_LINES 环境变量控制上限并有范围限制', async () => {
  const { readSettings } = await import('../server/config.mjs')
  assert.equal(readSettings({ WB_LOG_LINES: '500' }).logLines, 500)
  assert.equal(readSettings({}).logLines, 1000)
  assert.equal(readSettings({ WB_LOG_FILE_MB: '8' }).logFileBytes, 8 * 1024 * 1024)
  assert.equal(readSettings({}).logFileBytes, 4 * 1024 * 1024)
  assert.throws(() => readSettings({ WB_LOG_LINES: '50' }), /WB_LOG_LINES/)
  assert.throws(() => readSettings({ WB_LOG_LINES: '9000' }), /WB_LOG_LINES/)
  assert.throws(() => readSettings({ WB_LOG_FILE_MB: '0' }), /WB_LOG_FILE_MB/)
})
