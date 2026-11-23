import { createHash, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { AppError, invalid } from './errors.mjs'
import { bindingIdPattern, createAgsProvider } from './ags.mjs'
import { isRecord, MAX_SANDBOXES, validateConfig } from './config.mjs'
import { LeaseManager } from './leases.mjs'
import { checkSite } from './probe.mjs'
import { Scheduler } from './scheduler.mjs'
import { Store } from './store.mjs'
import { pauseTasks } from './task-actions.mjs'
import { PythonTasks } from './python-tasks.mjs'
import { PushPlusService } from './pushplus.mjs'
import { hashPassword, passwordPattern, verifyPassword } from './admin-password.mjs'
import { pythonSchema } from './python-config.mjs'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const maxBody = 512 * 1024
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
}

function json(res, status, value) {
  res.writeHead(status, {
    ...securityHeaders,
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  })
  res.end(JSON.stringify(value))
}

async function payload(req) {
  if (req.headers['content-type']?.split(';')[0]?.toLowerCase().trim() !== 'application/json') {
    throw new AppError(415, 'json_required', '请发送 JSON 请求')
  }
  if (Number(req.headers['content-length']) > maxBody) {
    throw new AppError(413, 'body_too_large', '配置文件超过 512 KiB')
  }
  const chunks = []
  let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > maxBody) throw new AppError(413, 'body_too_large', '配置文件超过 512 KiB')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw invalid('不能读取请求中的 JSON')
  }
}

async function optionalPayload(req) {
  const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || Boolean(req.headers['transfer-encoding'])
  return hasBody ? payload(req) : {}
}

async function commandPayload(req, allowedKeys) {
  const value = await optionalPayload(req)
  if (!isRecord(value) || Object.keys(value).some(key => !allowedKeys.includes(key))) throw invalid('操作参数无效')
  return value
}

const digest = value => createHash('sha256').update(value).digest()

function assertRequestSource(req, webOrigin, pathname) {
  const port = req.socket.localPort
  const suffix = port === 80 ? '' : `:${port}`
  const localOrigins = ['127.0.0.1', 'localhost', '[::1]'].map(host => `http://${host}${suffix}`)
  const trusted = webOrigin ? [webOrigin, ...localOrigins] : localOrigins
  if (!trusted.some(origin => new URL(origin).host === req.headers.host?.toLowerCase())) {
    throw new AppError(421, 'invalid_host', '访问地址与服务端配置不匹配')
  }
  const pageNavigation = ['GET', 'HEAD'].includes(req.method) &&
    (pathname === '/' || pathname === '/index.html') &&
    req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document'
  if ((req.headers['sec-fetch-site'] === 'cross-site' && !pageNavigation) ||
      (req.headers.origin && !trusted.includes(req.headers.origin))) {
    throw new AppError(403, 'invalid_origin', '请从管理台所在地址发起请求')
  }
}

async function staticFile(req, res, pathname) {
  const asset = /^\/assets\/([a-zA-Z0-9_.-]+\.(?:js|css))$/.exec(pathname)
  const isIndex = pathname === '/' || pathname === '/index.html'
  if (!['GET', 'HEAD'].includes(req.method) || (!isIndex && !asset)) {
    throw new AppError(404, 'not_found', '页面不存在')
  }
  const path = isIndex ? resolve(dist, 'index.html') : resolve(dist, 'assets', asset[1])
  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    if (isIndex) throw new AppError(503, 'unbuilt', '请先运行 npm run build')
    throw new AppError(404, 'not_found', '文件不存在')
  }
  const type = isIndex ? 'text/html' : path.endsWith('.css') ? 'text/css' : 'text/javascript'
  res.writeHead(200, {
    ...securityHeaders,
    'Content-Type': `${type}; charset=utf-8`,
    'Content-Length': bytes.length,
    'Cache-Control': isIndex ? 'no-store' : 'public, max-age=31536000, immutable',
  })
  res.end(req.method === 'HEAD' ? undefined : bytes)
}

export function createApplication(settings, { now = Date.now, probe = checkSite, cooldownMs, agsProvider, pushplusFactory } = {}) {
  const bindings = settings.agsBindings ?? []
  if (bindings.length && !settings.token) throw invalid('启用实例管理需要配置 WB_ADMIN_TOKEN')
  const store = new Store(settings.dataFile, settings.historyLimit)
  const pythonTasks = new PythonTasks(store.db, settings.dataFile, {
    now,
    logLines: settings.logLines,
    logFileBytes: settings.logFileBytes,
    memoryCeilingMb: settings.memoryCeilingMb,
    maxRuns: settings.maxRuns,
    onEvent: (event, payload) => pushplus.notify(event, payload.title, payload.content).catch(() => {}),
  })
  const pushplus = pushplusFactory
    ? pushplusFactory(store.db, pythonTasks.box, { now })
    : new PushPlusService(store.db, pythonTasks.box, { now })
  const leases = new LeaseManager(store.db, bindings, agsProvider ?? createAgsProvider({ now }), { now })
  const scheduler = new Scheduler(store, (config, signal) => probe(config, signal, settings), {
    concurrency: settings.concurrency, now, cooldownMs,
  })
  const tokenHash = settings.token ? digest(settings.token) : null
  let storedPassword = store.adminPassword()
  const authRequired = () => Boolean(tokenHash || storedPassword)

  // A password saved from the console takes precedence over WB_ADMIN_TOKEN,
  // which then only serves as the initial or recovery value.
  function passwordMatches(value) {
    if (typeof value !== 'string' || !value) return false
    if (storedPassword) return verifyPassword(value, storedPassword)
    return tokenHash ? timingSafeEqual(digest(value), tokenHash) : false
  }

  async function handle(req, res) {
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw invalid('无效的请求地址')
    const url = new URL(req.url, 'http://localhost')
    assertRequestSource(req, settings.webOrigin, url.pathname)
    const method = req.method
    const path = url.pathname
    if (!path.startsWith('/api/')) return staticFile(req, res, path)
    if (path === '/api/health' && method === 'GET') return json(res, 200, { ok: true })

    if (authRequired()) {
      const authorization = req.headers.authorization || ''
      if (!authorization.startsWith('Bearer ') || !passwordMatches(authorization.slice(7))) {
        throw new AppError(401, 'unauthorized', '请输入有效的管理口令')
      }
    }

    if (path === '/api/admin/password') {
      if (method !== 'POST') throw new AppError(405, 'method_not_allowed', '操作方式不正确')
      const body = await payload(req)
      if (!isRecord(body) || Object.keys(body).some(key => !['current', 'next'].includes(key))) throw invalid('口令修改参数无效')
      if (typeof body.current !== 'string' || !passwordMatches(body.current)) {
        throw new AppError(401, 'wrong_current_password', '当前口令不正确')
      }
      if (typeof body.next !== 'string' || !passwordPattern.test(body.next)) {
        throw invalid('新口令须为 8–128 位字母、数字、下划线或连字符')
      }
      if (body.next === body.current) throw invalid('新口令不能与当前口令相同')
      const record = hashPassword(body.next)
      store.saveAdminPassword(record, now())
      storedPassword = record
      return json(res, 200, { ok: true })
    }

    if (path === '/api/pushplus') {
      if (!authRequired()) throw new AppError(403, 'pushplus_disabled', '推送需要管理口令')
      if (method === 'GET') return json(res, 200, { pushplus: pushplus.view() })
      if (method === 'PUT') return json(res, 200, { pushplus: pushplus.save(await payload(req)) })
      throw new AppError(405, 'method_not_allowed', '操作方式不正确')
    }
    if (path === '/api/pushplus/test' && method === 'POST') {
      if (!authRequired()) throw new AppError(403, 'pushplus_disabled', '推送需要管理口令')
      return json(res, 200, { result: await pushplus.test() })
    }

    if (path === '/api/python-defaults' || path === '/api/python-accounts' || path.startsWith('/api/python-accounts/')) {
      if (!authRequired()) throw new AppError(403, 'python_disabled', '统一配置需要管理口令')
      if (path === '/api/python-defaults' && method === 'PUT') return json(res, 200, { defaults: pythonTasks.shared.saveDefaults(await payload(req)) })
      if (path === '/api/python-defaults' && method === 'GET') return json(res, 200, { defaults: pythonTasks.shared.defaults() })
      if (path === '/api/python-accounts' && method === 'GET') return json(res, 200, { accounts: pythonTasks.shared.list() })
      if (path === '/api/python-accounts' && method === 'POST') return json(res, 201, {
        account: pythonTasks.shared.save(await payload(req), undefined, id => pythonTasks.effective(pythonTasks.row(id))),
      })
      const match = /^\/api\/python-accounts\/([a-f0-9-]{36})(?:\/(reveal))?$/.exec(path)
      if (!match) throw new AppError(404, 'not_found', '接口不存在')
      const [, id, action] = match
      if (!action && method === 'PUT') return json(res, 200, { account: pythonTasks.shared.save(await payload(req), id) })
      if (!action && method === 'DELETE') { pythonTasks.shared.remove(id); return json(res, 200, { ok: true }) }
      if (action === 'reveal' && method === 'POST') return json(res, 200, { credentials: pythonTasks.shared.reveal(id) })
      throw new AppError(405, 'method_not_allowed', '操作方式不正确')
    }

    if (path === '/api/python-tasks' || path.startsWith('/api/python-tasks/')) {
      if (!authRequired()) throw new AppError(403, 'python_disabled', '先设置平台管理口令，才能保存和运行脚本')
      if (path === '/api/python-tasks' && method === 'POST') return json(res, 201, { task: pythonTasks.save(await payload(req)) })
      if (path === '/api/python-tasks' && method === 'GET') return json(res, 200, { tasks: pythonTasks.list() })
      const match = /^\/api\/python-tasks\/([a-f0-9-]{36})(?:\/(start|stop|reveal|logs))?$/.exec(path)
      if (!match) throw new AppError(404, 'not_found', '接口不存在')
      const [, id, action] = match
      if (!action && method === 'PUT') return json(res, 200, { task: pythonTasks.save(await payload(req), id) })
      if (!action && method === 'DELETE') { pythonTasks.remove(id); return json(res, 200, { ok: true }) }
      if (action === 'start' && method === 'POST') return json(res, 200, { task: pythonTasks.start(id, await commandPayload(req, ['durationSeconds'])) })
      if (action === 'stop' && method === 'POST') return json(res, 200, { task: await pythonTasks.stop(id, (await commandPayload(req, ['runId'])).runId) })
      if (action === 'reveal' && method === 'POST') return json(res, 200, { credentials: pythonTasks.reveal(id) })
      if (action === 'logs' && method === 'GET') return json(res, 200, pythonTasks.logs(id, Number(url.searchParams.get('after') ?? 0)))
      if (action === 'logs' && method === 'DELETE') return json(res, 200, pythonTasks.clearLogs(id))
      throw new AppError(405, 'method_not_allowed', '操作方式不正确')
    }

    if (path === '/api/python-logs' && method === 'DELETE') {
      if (!authRequired()) throw new AppError(403, 'python_disabled', '日志清理需要管理口令')
      return json(res, 200, pythonTasks.clearAllLogs())
    }

    if (path === '/api/tasks/pause' && method === 'POST') {
      const results = pauseTasks(await payload(req), { store, leases, scheduler, now })
      return json(res, 200, { results })
    }

    if (path.startsWith('/api/leases/')) {
      const [, id, action, extra] = path.slice('/api/leases'.length).split('/')
      if (!bindingIdPattern.test(id ?? '') || extra !== undefined) {
        throw new AppError(404, 'not_found', '接口不存在')
      }
      if (method === 'PUT' && action === undefined) return json(res, 200, { lease: leases.update(id, await payload(req)) })
      if (method === 'POST' && action === 'query') return json(res, 200, { lease: await leases.run(id) })
      throw new AppError(405, 'method_not_allowed', '操作方式不正确')
    }

    if (path === '/api/sandboxes' && method === 'GET') {
      return json(res, 200, {
        sandboxes: store.list(scheduler.running), leases: leases.list(),
        pythonTasks: authRequired() ? pythonTasks.list() : [], pythonSchema, pythonEnabled: authRequired(),
        pythonAccounts: authRequired() ? pythonTasks.shared.list() : [], pythonDefaults: pythonTasks.shared.defaults(),
        allowHttp: settings.allowHttp, maxSandboxes: MAX_SANDBOXES, serverTime: now(),
      })
    }
    if (path === '/api/sandboxes' && method === 'POST') {
      const config = validateConfig(await payload(req), settings)
      const [sandbox] = store.createMany([config], now())
      return json(res, 201, { sandbox })
    }
    if (path === '/api/sandboxes/import' && method === 'POST') {
      const body = await payload(req)
      if (!isRecord(body) || body.version !== 1 || !Array.isArray(body.configs) ||
          body.configs.length < 1 || body.configs.length > MAX_SANDBOXES) {
        throw invalid('备份文件须为版本 1，且包含 1–64 项配置')
      }
      const configs = body.configs.map((item, index) => {
        try {
          return validateConfig(item, settings)
        } catch (error) {
          if (error instanceof AppError) throw invalid(`第 ${index + 1} 项配置：${error.message}`)
          throw error
        }
      })
      // Require an explicit start after import.
      const sandboxes = store.createMany(configs.map(config => ({ ...config, enabled: false })), now())
      return json(res, 201, { count: sandboxes.length })
    }

    const match = /^\/api\/sandboxes\/([a-f0-9-]{36})(?:\/(checks|stats|check))?$/.exec(path)
    if (!match) throw new AppError(404, 'not_found', '接口不存在')
    const [, id, action] = match
    if (action === 'checks' && method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? 100)
      // 上限提到 5000，够翻很久；再往前用 before 游标分页，不影响加载速度。
      if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw invalid('记录条数须为 1–5000')
      const before = url.searchParams.get('before')
      const cursor = before === null ? null : Number(before)
      if (cursor !== null && (!Number.isInteger(cursor) || cursor < 1)) throw invalid('before 必须是正整数')
      return json(res, 200, { checks: store.history(id, limit, cursor), generation: store.generationOf(id) })
    }
    if (action === 'stats' && method === 'GET') {
      const hours = url.searchParams.get('hours')
      if (hours !== null && (!/^\d+$/.test(hours) || Number(hours) < 1 || Number(hours) > 24 * 3650)) {
        throw invalid('hours 必须是 1–87600 的整数')
      }
      const since = hours === null ? null : now() - Number(hours) * 3600_000
      return json(res, 200, { stats: store.stats(id, since) })
    }
    if (action === 'check' && method === 'POST') {
      const result = await scheduler.run(id)
      return json(res, 200, { result })
    }
    if (!action && (method === 'PUT' || method === 'PATCH')) {
      const body = await payload(req)
      let config
      if (method === 'PATCH') {
        if (!isRecord(body) || Object.keys(body).length !== 1 || typeof body.enabled !== 'boolean') {
          throw invalid('启停请求仅接受 enabled 布尔值')
        }
        config = { ...JSON.parse(store.row(id).config), enabled: body.enabled }
        if (body.enabled) config = validateConfig(config, settings)
      } else {
        config = validateConfig(body, settings)
      }
      const sandbox = store.update(id, config, now())
      scheduler.cancel(id)
      return json(res, 200, { sandbox })
    }
    if (!action && method === 'DELETE') {
      store.delete(id)
      scheduler.forget(id)
      return json(res, 200, { ok: true })
    }
    throw new AppError(405, 'method_not_allowed', '操作方式不正确')
  }

  const server = createServer({ requestTimeout: 35_000, headersTimeout: 10_000 }, (req, res) => {
    handle(req, res).catch(error => {
      req.resume()
      if (res.destroyed || res.headersSent) return
      if (error instanceof AppError) return json(res, error.status, { code: error.code, message: error.message })
      console.error('管理接口错误', error?.code || error?.name)
      json(res, 500, { code: 'internal', message: '服务暂时无法完成操作' })
    })
  })
  return { server, scheduler, leases, pythonTasks, store, pushplus }
}
