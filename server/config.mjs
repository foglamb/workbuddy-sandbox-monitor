import { resolve } from 'node:path'
import { readAgsBindings } from './ags.mjs'
import { AppError, invalid } from './errors.mjs'

// Kept for the import endpoint's sanity bound only; no longer a product cap.
export const MAX_SANDBOXES = 10_000
export const DEFAULTS = Object.freeze({
  name: '', url: '', group: '', notes: '', expectedText: '',
  method: 'GET', intervalSec: 120, timeoutSec: 8, failureThreshold: 3,
  successMin: 200, successMax: 299, enabled: true,
})

// Hosts that are never valid monitoring targets.
//
//   built-in — a sandbox platform's own API host. It returns JSON, not an
//              application deployment, so a health check there is always a
//              misconfiguration. Built-ins cannot be removed by configuration.
//   operator — anything listed in WB_DENIED_DOMAINS is added on top and is
//              matched for the host itself and every subdomain.
//
// Operators who must protect their own infrastructure list it here rather than
// hard-coding it, so the published project carries no site-specific values.
const builtInDeniedDomains = ['copilot.tencent.com']

export function deniedDomainsFor(env) {
  const extra = (env.WB_DENIED_DOMAINS || '').split(',')
    .map(item => item.trim().toLowerCase().replace(/^\./, ''))
    .filter(item => item && /^[a-z0-9.-]+$/.test(item))
  return [...new Set([...builtInDeniedDomains, ...extra])]
}
const loopback = new Set(['127.0.0.1', '::1'])

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function numberIn(value, min, max, label, fallback) {
  const number = value ?? fallback
  if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max) {
    throw invalid(`${label}须为 ${min}–${max} 之间的整数`)
  }
  return number
}

function textIn(value, max, label, fallback = '', required = false) {
  const text = value === undefined ? fallback : value
  if (typeof text !== 'string' || text.trim().length > max || (required && !text.trim())) {
    throw invalid(`${label}${required ? '必填，且' : ''}长度不得超过 ${max} 字符`)
  }
  return text.trim()
}

function asUrl(text, message) {
  try {
    return new URL(text)
  } catch {
    throw invalid(message)
  }
}

export function targetUrl(text, { allowedOrigins = new Set(), deniedDomains = builtInDeniedDomains } = {}) {
  const value = asUrl(text, '请输入完整的部署网址')
  const host = value.hostname.toLowerCase().replace(/\.$/, '')
  // Plain HTTP is allowed: many deployments (and this platform's own test
  // instance) are reached over an internal network where TLS is not provisioned.
  // The protocol check only rejects anything that is not HTTP(S).
  if (!['http:', 'https:'].includes(value.protocol)) {
    throw invalid('部署网址须使用 HTTP 或 HTTPS')
  }
  if (value.username || value.password || value.href.includes('?') || value.href.includes('#')) {
    throw invalid('请填写公开健康地址，去掉登录凭据、查询参数和片段')
  }
  if (deniedDomains.some(domain => host === domain || host.endsWith(`.${domain}`))) {
    throw new AppError(400, 'blocked_target', '请填写应用部署网址，使用应用自己的健康检查路径')
  }
  if (allowedOrigins.size && !allowedOrigins.has(value.origin)) {
    throw new AppError(400, 'blocked_target', '部署网址不在服务端允许的来源列表中')
  }
  return value
}

export function validateConfig(input, policy) {
  if (!isRecord(input)) throw invalid('沙盒配置须为 JSON 对象')
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(DEFAULTS, key)) throw invalid('配置中含有未知字段')
  }
  const config = { ...DEFAULTS, ...input }
  if (config.method !== 'GET' && config.method !== 'HEAD') throw invalid('请求方式仅支持 GET、HEAD')
  if (typeof config.enabled !== 'boolean') throw invalid('启用状态须为布尔值')
  const successMin = numberIn(config.successMin, 200, 499, '成功状态码下限')
  const successMax = numberIn(config.successMax, successMin, 499, '成功状态码上限')
  const expectedText = textIn(config.expectedText, 128, '预期响应文本')
  if (expectedText && config.method !== 'GET') throw invalid('响应内容校验需要使用 GET')
  const url = targetUrl(textIn(config.url, 768, '网址', '', true), policy).href
  if (url.length > 768) throw invalid('网址编码后的长度不得超过 768 字符')
  return {
    name: textIn(config.name, 60, '名称', '', true),
    url,
    group: textIn(config.group, 40, '分组'),
    notes: textIn(config.notes, 400, '备注'),
    expectedText,
    method: config.method,
    intervalSec: numberIn(config.intervalSec, 60, 86_400, '检查间隔'),
    timeoutSec: numberIn(config.timeoutSec, 2, 30, '超时'),
    failureThreshold: numberIn(config.failureThreshold, 1, 10, '异常阈值'),
    successMin,
    successMax,
    enabled: config.enabled,
  }
}

function readOrigin(text, label) {
  const url = asUrl(text, `${label} 须为有效的 HTTP(S) 来源`)
  if (!['http:', 'https:'].includes(url.protocol) || url.href !== `${url.origin}/`) {
    throw invalid(`${label} 只接受协议、主机和端口`)
  }
  return url.origin
}

function envInt(name, env, min, max, fallback) {
  if (env[name] === undefined || env[name] === '') return fallback
  if (!/^\d+$/.test(env[name])) throw invalid(`${name} 必须是整数`)
  return numberIn(Number(env[name]), min, max, name)
}

export function readSettings(env = process.env) {
  const host = env.WB_HOST || '127.0.0.1'
  const token = env.WB_ADMIN_TOKEN || ''
  const port = envInt('WB_PORT', env, 1, 65535, 8788)
  const webOrigin = env.WB_WEB_ORIGIN ? readOrigin(env.WB_WEB_ORIGIN, 'WB_WEB_ORIGIN') : ''
  if (token && !/^[a-zA-Z0-9_-]{8,128}$/.test(token)) {
    throw invalid('WB_ADMIN_TOKEN 须为 8–128 位字母、数字、下划线或连字符')
  }
  if (!loopback.has(host) && (!token || !webOrigin)) {
    throw invalid('非回环监听需要配置 WB_ADMIN_TOKEN 和 WB_WEB_ORIGIN')
  }
  if (webOrigin) {
    const publicUrl = new URL(webOrigin)
    const localOrigin = ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname)
    // HTTPS is recommended but not required: an internal deployment behind a
    // trusted network is a legitimate setup. The admin token remains mandatory.
    if (!localOrigin && !token) {
      throw invalid('外部访问需要配置 WB_ADMIN_TOKEN')
    }
  }
  // Kept for API compatibility; HTTP targets are always permitted now.
  const allowHttp = true
  const deniedDomains = deniedDomainsFor(env)
  const allowedOrigins = new Set((env.WB_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
    .map(origin => targetUrl(readOrigin(origin, 'WB_ALLOWED_ORIGINS')).origin))
  const dataFile = resolve(env.WB_DATA_DIR || 'data', 'monitor.sqlite')
  const concurrency = envInt('WB_CONCURRENCY', env, 1, 8, 4)
  // 0 = 永久保留全部检查记录。默认保留：网址的可用性趋势需要长期数据才能
  // 判断"到底是偶发抖动还是持续劣化"，裁剪掉就等于把现场删了。
  const historyLimit = envInt('WB_HISTORY_LIMIT', env, 0, 1_000_000, 0)
  const logLines = envInt('WB_LOG_LINES', env, 100, 5000, 1000)
  const logFileBytes = envInt('WB_LOG_FILE_MB', env, 1, 64, 4) * 1024 * 1024
  const memoryCeilingMb = envInt('WB_MEMORY_CEILING_MB', env, 128, 8192, 512)
  const maxRuns = envInt('WB_MAX_RUNS', env, 0, 512, 0)
  const agsBindings = readAgsBindings(env, token)
  return { host, token, port, webOrigin, dataFile, allowHttp, allowedOrigins, deniedDomains, concurrency, historyLimit, logLines, logFileBytes, memoryCeilingMb, maxRuns, agsBindings }
}
