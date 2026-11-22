import assert from 'node:assert/strict'
import test from 'node:test'

const { clearSession, loadSession, saveSession } = await import('../src/session-store.ts')

function memoryStorage() {
  const map = new Map()
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) },
    get size() { return map.size },
  }
}

function install({ session = memoryStorage(), local = memoryStorage() } = {}) {
  globalThis.sessionStorage = session
  globalThis.localStorage = local
  return { session, local }
}

test('没有缓存时读到空口令', () => {
  install()
  assert.deepEqual(loadSession(), { password: '', remember: false })
})

test('默认存入 sessionStorage，刷新可恢复，关闭标签页即失效', () => {
  const { session, local } = install()
  saveSession('example-token-0001', false)
  assert.equal(loadSession().password, 'example-token-0001')
  assert.equal(loadSession().remember, false)
  assert.equal(session.size, 1, '应存在 sessionStorage')
  assert.equal(local.size, 0, '不应写入 localStorage')
})

test('勾选保持登录时存入 localStorage', () => {
  const { session, local } = install()
  saveSession('example-token-0001', true)
  const restored = loadSession()
  assert.equal(restored.password, 'example-token-0001')
  assert.equal(restored.remember, true, '应记住设备模式')
  assert.equal(local.size, 2, '口令与模式各一条')
  assert.equal(session.size, 0, '不应残留在 sessionStorage')
})

test('从记住设备切回会话模式会清掉本地副本', () => {
  const { session, local } = install()
  saveSession('example-token-0001', true)
  saveSession('example-token-0001', false)
  assert.equal(loadSession().remember, false)
  assert.equal(local.size, 0, 'localStorage 必须清空')
  assert.equal(session.size, 1)
})

test('清除会同时清掉两处', () => {
  install()
  saveSession('example-token-0001', true)
  clearSession()
  assert.deepEqual(loadSession(), { password: '', remember: false })
})

test('存储不可用时安静降级，不抛出', () => {
  globalThis.sessionStorage = undefined
  globalThis.localStorage = undefined
  assert.doesNotThrow(() => saveSession('x', false))
  assert.doesNotThrow(() => saveSession('x', true))
  assert.deepEqual(loadSession(), { password: '', remember: false })
  assert.doesNotThrow(() => clearSession())
})

test('隐私模式下访问抛错时不影响调用方', () => {
  const boom = {
    getItem() { throw new Error('blocked') },
    setItem() { throw new Error('blocked') },
    removeItem() { throw new Error('blocked') },
  }
  install({ session: boom, local: boom })
  assert.doesNotThrow(() => saveSession('x', true))
  assert.deepEqual(loadSession(), { password: '', remember: false })
})

test('配额写满时 setItem 抛错不崩溃', () => {
  const full = {
    getItem: () => null,
    setItem() { throw new Error('QuotaExceededError') },
    removeItem() { throw new Error('QuotaExceededError') },
  }
  install({ session: full, local: full })
  assert.doesNotThrow(() => saveSession('example-token-0001', false))
})

test('设备模式优先于会话模式', () => {
  const { session, local } = install()
  session.setItem('workbuddy.admin.password', 'session-value')
  local.setItem('workbuddy.admin.password', 'device-value')
  assert.equal(loadSession().password, 'device-value')
})

test('localStorage 只写在用户显式勾选的分支里', async () => {
  const source = await (await import('node:fs/promises')).readFile(
    new URL('../src/session-store.ts', import.meta.url), 'utf8')
  const deviceCalls = source.match(/write\(device\(\), valueKey, password\)/g) ?? []
  assert.equal(deviceCalls.length, 1, '只有一处写入设备存储')
  const fn = source.slice(source.indexOf('export function saveSession'))
  assert.match(fn, /if \(remember\) \{[^}]*write\(device\(\)/, '写入设备存储必须在 remember 分支内')
})
