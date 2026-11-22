import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { evaluateResponse } from '../server/probe.mjs'

function reply(parts, statusCode = 200, headers = {}) {
  return Object.assign(Readable.from(parts.map(part => Buffer.from(part))), { statusCode, headers })
}

const config = { successMin: 200, successMax: 299, expectedText: '沙盒就绪' }

test('HTTP 200 占位页判为内容不符，匹配跨分块的 UTF-8 标记', async () => {
  const ready = Buffer.from('服务状态：沙盒就绪')
  const parts = [ready.subarray(0, ready.length - 2), ready.subarray(ready.length - 2)]
  const response = reply(parts)
  assert.deepEqual(await evaluateResponse(response, config), { statusCode: 200, code: 'ok' })
  assert.equal(response.destroyed, true)
  assert.deepEqual(await evaluateResponse(reply(['站点暂不可用']), config), { statusCode: 200, code: 'body' })
  assert.deepEqual(await evaluateResponse(reply(parts, 503), config), { statusCode: 503, code: 'http' })
})

test('匹配检查遵守正文读取上限，未配置文本时保持状态码判定', async () => {
  const limit = 32 * 1024
  const markerBytes = Buffer.byteLength(config.expectedText)
  assert.equal((await evaluateResponse(reply([Buffer.alloc(limit - markerBytes), config.expectedText]), config)).code, 'ok')
  assert.equal((await evaluateResponse(reply([Buffer.alloc(limit - markerBytes + 1), config.expectedText]), config)).code, 'body')
  assert.equal((await evaluateResponse(reply([config.expectedText], 200, { 'content-encoding': 'gzip' }), config)).code, 'body')
  assert.equal((await evaluateResponse(reply([], 204), { ...config, expectedText: '' })).code, 'ok')
})
