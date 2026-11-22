import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { BlockList, isIP } from 'node:net'
import { targetUrl } from './config.mjs'
import { AppError } from './errors.mjs'

const reservedV4 = new BlockList()
for (const [address, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) reservedV4.addSubnet(address, bits, 'ipv4')

const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
const reservedV6 = new BlockList()
for (const [address, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  reservedV6.addSubnet(address, bits, 'ipv6')
}

function publicAddress({ address, family }) {
  if (family === 4 && isIP(address) === 4) return !reservedV4.check(address, 'ipv4')
  if (family === 6 && isIP(address) === 6) {
    return globalV6.check(address, 'ipv6') && !reservedV6.check(address, 'ipv6')
  }
  return false
}

function withAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export async function resolveTarget(url, signal, resolveHost = lookup) {
  signal.throwIfAborted()
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const family = isIP(hostname)
  const records = family ? [{ address: hostname, family }]
    : await withAbort(resolveHost(hostname, { all: true, order: 'ipv4first' }), signal)
  if (!records.length || records.some(record => !publicAddress(record))) {
    throw new AppError(400, 'blocked_target', '只允许连接公网健康地址')
  }
  return records[0]
}

const bodyLimit = 32 * 1024

export async function evaluateResponse(response, config) {
  const { statusCode } = response
  try {
    if (statusCode < config.successMin || statusCode > config.successMax) {
      return { statusCode, code: 'http' }
    }
    if (!config.expectedText) return { statusCode, code: 'ok' }

    const encoding = response.headers['content-encoding']
    if (encoding && encoding.toLowerCase() !== 'identity') return { statusCode, code: 'body' }
    const marker = Buffer.from(config.expectedText, 'utf8')
    let remaining = bodyLimit
    let suffix = Buffer.alloc(0)
    for await (const chunk of response.iterator({ destroyOnReturn: false })) {
      const part = chunk.subarray(0, remaining)
      const bytes = Buffer.concat([suffix, part])
      if (bytes.includes(marker)) return { statusCode, code: 'ok' }
      remaining -= part.length
      if (remaining === 0) break
      // Retain just enough bytes to match a marker split between chunks.
      suffix = bytes.subarray(Math.max(0, bytes.length - marker.length + 1))
    }
    return { statusCode, code: 'body' }
  } finally {
    response.destroy()
  }
}

function inspectTarget(url, config, record, signal) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http
    // Reuse the vetted address while keeping the URL hostname for TLS and Host.
    const request = client.request(url, {
      method: config.method, agent: false, family: record.family, autoSelectFamily: false,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [record])
        else callback(null, record.address, record.family)
      },
      signal, rejectUnauthorized: true, maxHeaderSize: 8192,
      headers: {
        'User-Agent': 'WorkBuddy-Sandbox-Monitor/1.0',
        'Accept-Encoding': 'identity',
        Connection: 'close',
      },
    }, response => { evaluateResponse(response, config).then(resolve, reject) })
    request.on('error', reject)
    request.end()
  })
}

function classify(error, timeout) {
  if (timeout.aborted) return 'timeout'
  if (error instanceof AppError) return 'blocked'
  if (['ENOTFOUND', 'EAI_AGAIN', 'ENODATA'].includes(error?.code)) return 'dns'
  if (/CERT|TLS|SSL|SELF_SIGNED/.test(String(error?.code))) return 'tls'
  return 'network'
}

export async function checkSite(config, parentSignal, policy) {
  const start = performance.now()
  const timeout = AbortSignal.timeout(config.timeoutSec * 1000)
  const signal = AbortSignal.any([parentSignal, timeout])
  let statusCode = null
  let code
  try {
    const url = targetUrl(config.url, policy)
    const record = await resolveTarget(url, signal)
    const result = await inspectTarget(url, config, record, signal)
    statusCode = result.statusCode
    code = result.code
  } catch (error) {
    parentSignal.throwIfAborted()
    code = classify(error, timeout)
  }
  return {
    ok: code === 'ok', code, statusCode,
    durationMs: Math.max(0, Math.round(performance.now() - start)),
  }
}
