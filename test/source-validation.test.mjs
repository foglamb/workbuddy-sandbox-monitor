import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import test from 'node:test'
import { createApplication } from '../server/http.mjs'
import { readSettings } from '../server/config.mjs'

const token = 'local-navigation-test-token-01234567890'
const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }

async function fixture(t) {
  const app = createApplication({ ...readSettings({ WB_ADMIN_TOKEN: token }), dataFile: ':memory:' })
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  t.after(async () => {
    app.scheduler.stop()
    await app.leases.stop()
    await new Promise(resolve => app.server.close(resolve))
    app.store.close()
  })
  const origin = `http://127.0.0.1:${app.server.address().port}`
  return { origin, request: (path, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    // Native HTTP preserves Fetch Metadata and Host verbatim; fetch rewrites some of these headers.
    const req = httpRequest(`${origin}${path}`, { headers, method }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve(new Response(method === 'HEAD' ? null : Buffer.concat(chunks), {
        status: response.statusCode, headers: response.headers,
      })))
      response.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  }) }
}

test('从其他页面点击首页链接可进入；仍保留页面 CSP 和禁止嵌入', async t => {
  const { request } = await fixture(t)
  const direct = await request('/')
  // A source checkout may not be built yet; navigation must follow the same route as a direct visit.
  assert.ok([200, 503].includes(direct.status))
  for (const path of ['/', '/index.html', '/?from=chat']) {
    const response = await request(path, navigation)
    assert.equal(response.status, direct.status)
    assert.equal(response.headers.get('content-type'), direct.headers.get('content-type'))
    assert.equal(response.headers.get('x-frame-options'), 'DENY')
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  }
  assert.equal((await request('/', navigation, 'HEAD')).status, direct.status)
})

test('跨站接口即使伪装成页面导航且持有口令，也不能通过来源校验', async t => {
  const { request, origin } = await fixture(t)
  for (const [path, method] of [['/api/sandboxes', 'GET'], ['/api/tasks/pause', 'POST'], ['/api/health', 'GET']]) {
    const response = await request(path, { ...navigation, Authorization: `Bearer ${token}` }, method)
    assert.equal(response.status, 403)
    assert.equal((await response.json()).code, 'invalid_origin')
  }
  assert.equal((await request('/api/sandboxes')).status, 401)
  assert.equal((await request('/api/sandboxes', { Authorization: `Bearer ${token}`, Origin: origin })).status, 200)
})

test('跨站 fetch、iframe、POST 和伪造来源或主机仍被拒绝', async t => {
  const { request } = await fixture(t)
  const blocked = [
    [{ ...navigation, 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' }, 'GET'],
    [{ ...navigation, 'Sec-Fetch-Dest': 'iframe' }, 'GET'],
    [navigation, 'POST'],
    [{ ...navigation, Origin: 'https://other.example' }, 'GET'],
    [{ 'Sec-Fetch-Site': 'cross-site' }, 'GET'],
  ]
  for (const [headers, method] of blocked) {
    const response = await request('/', headers, method)
    assert.equal(response.status, 403)
    assert.equal((await response.json()).code, 'invalid_origin')
  }
  const wrongHost = await request('/', { ...navigation, Host: 'untrusted.example' })
  assert.equal(wrongHost.status, 421)
  assert.equal((await wrongHost.json()).code, 'invalid_host')
})
