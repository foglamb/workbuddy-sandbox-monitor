import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempDisposableSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const entry = fileURLToPath(new URL('../server/index.mjs', import.meta.url))
const host = '127.0.0.1'
const close = server => new Promise(resolve => server.close(resolve))

async function temporaryPort() {
  const server = createServer().listen(0, host)
  await once(server, 'listening')
  const { port } = server.address()
  await close(server)
  return port
}

function testContext(t, root) {
  const temp = mkdtempDisposableSync(join(tmpdir(), 'wb-platform-lock-'))
  const children = []
  t.after(async () => {
    for (const service of children) await service.stop('SIGKILL')
    temp.remove()
  })
  return {
    data: join(temp.path, root),
    dataFor: name => join(temp.path, name),
    launch(data, port) {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('WB_')))
      Object.assign(env, { WB_HOST: host, WB_DATA_DIR: data, WB_PORT: String(port) })
      const child = spawn(process.execPath, [entry], { env, cwd: temp.path, stdio: ['ignore', 'pipe', 'pipe'] })
      const origin = `http://${host}:${port}`
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', text => { stderr += text })
      const finished = once(child, 'close').then(([code, signal]) => ({ code, signal, stdout, stderr }))
      const ready = new Promise(resolve => child.stdout.on('data', text => {
        stdout += text
        if (stdout.includes(`WorkBuddy 保活平台 ${origin}\n`)) resolve(true)
      }))
      const api = {
        origin,
        finished,
        async waitForReady() {
          const result = await Promise.race([ready, finished])
          assert.equal(result, true, `服务未就绪：${result?.stderr || ''}`)
        },
        async stop(signal = 'SIGTERM') {
          if (child.exitCode === null && child.signalCode === null) child.kill(signal)
          return finished
        },
      }
      children.push(api)
      return api
    },
  }
}

test('同一数据目录仅允许一个实际调度进程，崩溃后可接管且数据保留', { timeout: 12_000 }, async t => {
  const fixture = testContext(t, 'shared')
  const holder = fixture.launch(fixture.data, await temporaryPort())
  await holder.waitForReady()
  const seed = await fetch(`${holder.origin}/api/sandboxes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ name: '重启验证', url: 'https://lock-fixture.example/status', enabled: false }),
  })
  assert.equal(seed.status, 201)
  const { sandbox } = await seed.json()

  const conflict = fixture.launch(fixture.data, await temporaryPort())
  const result = await conflict.finished
  assert.equal(result.code, 1)
  assert.match(result.stderr, /此数据目录已有保活平台运行/)
  assert.doesNotMatch(result.stdout, /WorkBuddy 保活平台/)

  const independent = fixture.launch(fixture.dataFor('independent'), await temporaryPort())
  await independent.waitForReady()
  assert.equal((await independent.stop()).code, 0)

  assert.notEqual((await holder.stop('SIGKILL')).code, 0)
  const recovered = fixture.launch(fixture.data, await temporaryPort())
  await recovered.waitForReady()
  const response = await fetch(`${recovered.origin}/api/sandboxes`, { headers: { Connection: 'close' } })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(body.sandboxes.map(item => item.id), [sandbox.id])
  assert.equal((await recovered.stop()).code, 0)
})

test('端口绑定失败后释放数据目录锁', { timeout: 8_000 }, async t => {
  const fixture = testContext(t, 'bind-failure')
  const blocker = createServer().listen(0, host)
  t.after(() => close(blocker))
  await once(blocker, 'listening')
  const port = blocker.address().port
  const result = await fixture.launch(fixture.data, port).finished
  assert.equal(result.code, 1)
  assert.match(result.stderr, /EADDRINUSE/)
  const fresh = fixture.launch(fixture.data, await temporaryPort())
  await fresh.waitForReady()
  assert.equal((await fresh.stop()).code, 0)
})
