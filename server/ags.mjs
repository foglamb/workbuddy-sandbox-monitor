import { createHash, createHmac } from 'node:crypto'
import { invalid } from './errors.mjs'

const host = 'ags.tencentcloudapi.com'
const version = '2025-09-20'
const readAction = 'DescribeSandboxInstances'
const writeAction = 'UpdateSandboxInstance'
const contentType = 'application/json; charset=utf-8'
const authAlgo = 'TC3-HMAC-SHA256'
const authHeaders = 'content-type;host'
const maxResponse = 256 * 1024
export const bindingIdPattern = /^[a-z0-9][a-z0-9_-]{0,39}$/

const hexHash = value => createHash('sha256').update(value, 'utf8').digest('hex')
const mac = (key, value) => createHmac('sha256', key).update(value, 'utf8').digest()

export function readAgsBindings(env, adminToken) {
  const text = env.WB_AGS_BINDINGS?.trim()
  if (!text) return []
  let input
  try {
    input = JSON.parse(text)
  } catch {
    throw invalid('WB_AGS_BINDINGS 须为合法 JSON 数组')
  }
  if (!Array.isArray(input) || input.length > 24) throw invalid('WB_AGS_BINDINGS 须包含 0–24 项绑定')
  if (input.length && !adminToken) throw invalid('启用实例管理需要配置 WB_ADMIN_TOKEN')
  const ids = new Set()
  const instances = new Set()
  return input.map((entry, index) => {
    const error = reason => invalid(`WB_AGS_BINDINGS 第 ${index + 1} 项：${reason}`)
    const fields = ['id', 'label', 'region', 'instanceId', 'credential']
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).some(key => !fields.includes(key))) {
      throw error('仅接受 id、label、region、instanceId、credential')
    }
    const { id, label, region, instanceId, credential = 'TENCENTCLOUD' } = entry
    if (typeof id !== 'string' || !bindingIdPattern.test(id) || ids.has(id)) throw error('id 无效或重复')
    if (typeof label !== 'string' || !label.trim() || label.trim().length > 60 || /[\x00-\x1f]/.test(label)) {
      throw error('label 需为 1–60 字符的单行名称')
    }
    if (typeof region !== 'string' || !/^[a-z]{2}-[a-z][a-z0-9-]{1,30}$/.test(region) ||
        typeof instanceId !== 'string' || !/^[a-zA-Z0-9_-]{8,90}$/.test(instanceId)) {
      throw error('region 或 instanceId 格式不正确')
    }
    if (typeof credential !== 'string' || !/^[A-Z][A-Z0-9_]{2,39}$/.test(credential)) {
      throw error('credential 须为环境变量前缀')
    }
    const secretId = env[`${credential}_SECRET_ID`]
    const secretKey = env[`${credential}_SECRET_KEY`]
    const token = env[`${credential}_TOKEN`] || ''
    if (!secretId || !/^[a-zA-Z0-9]{8,128}$/.test(secretId) ||
        !secretKey || !/^[!-~]{8,256}$/.test(secretKey) || (token && !/^[!-~]{1,4096}$/.test(token))) {
      throw error('服务端缺少该凭据前缀对应的密钥，或凭据格式无效')
    }
    const resource = `${region}\0${instanceId}`
    if (instances.has(resource)) throw error('同地域的同一实例不能重复绑定')
    ids.add(id)
    instances.add(resource)
    return {
      id, label: label.trim(), region, instanceId, secretId, secretKey, token,
      // Retargeting a binding must never silently carry an enabled policy to the new identity.
      fingerprint: hexHash(`${resource}\0${secretId}`),
    }
  })
}

export function signAgsRequest(action, body, binding, epochSeconds) {
  const date = new Date(epochSeconds * 1000).toISOString().slice(0, 10)
  const scope = `${date}/ags/tc3_request`
  const canonical = ['POST', '/', '',
    `content-type:${contentType}\nhost:${host}\n`,
    authHeaders, hexHash(body)].join('\n')
  const toSign = `${authAlgo}\n${epochSeconds}\n${scope}\n${hexHash(canonical)}`
  const dateKey = mac(`TC3${binding.secretKey}`, date)
  const signature = mac(mac(mac(dateKey, 'ags'), 'tc3_request'), toSign).toString('hex')
  return {
    'Content-Type': contentType,
    'X-TC-Action': action,
    'X-TC-Region': binding.region,
    'X-TC-Version': version,
    'X-TC-Timestamp': String(epochSeconds),
    ...(binding.token ? { 'X-TC-Token': binding.token } : {}),
    Authorization: `${authAlgo} Credential=${binding.secretId}/${scope}, SignedHeaders=${authHeaders}, Signature=${signature}`,
  }
}

export class AgsError extends Error {
  constructor(code, requestId) {
    super('腾讯云 API 调用未成功')
    this.code = typeof code === 'string' && /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(code) ? code : 'CloudError'
    this.requestId = cleanRequestId(requestId)
  }
}

function cleanRequestId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,96}$/.test(value) ? value : null
}

async function readJson(response) {
  if (!response.body) throw new AgsError('InvalidCloudResponse')
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxResponse) {
        await reader.cancel()
        throw new AgsError('ResponseTooLarge')
      }
      chunks.push(value)
    }
    try {
      return JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
    } catch {
      throw new AgsError('InvalidCloudResponse')
    }
  } finally {
    reader.releaseLock()
  }
}

const statuses = new Set(['STARTING', 'RUNNING', 'PAUSING', 'PAUSED', 'RESUMING', 'STOPPING',
  'STOPPED', 'FAILED', 'STOP_FAILED', 'STARTING_FAILED', 'RESUME_FAILED', 'PAUSE_FAILED', 'RESIZING'])

function expiryTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

export function createAgsProvider({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  async function call(action, binding, data, signal) {
    const body = JSON.stringify(data)
    const timeout = AbortSignal.timeout(6000)
    const headers = signAgsRequest(action, body, binding, Math.floor(now() / 1000))
    try {
      const response = await fetchImpl(`https://${host}/`, {
        method: 'POST', headers, body, signal: AbortSignal.any([timeout, signal]), redirect: 'error',
      })
      const { Response: result } = (await readJson(response)) || {}
      if (result?.Error) throw new AgsError(result.Error.Code, result.RequestId)
      if (!response.ok) throw new AgsError(`HTTP_${response.status}`, result?.RequestId)
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new AgsError('InvalidCloudResponse')
      return result
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof AgsError) throw error
      throw new AgsError(timeout.aborted ? 'CloudTimeout' : 'CloudNetwork')
    }
  }
  return {
    async describe(binding, signal) {
      const result = await call(readAction, binding, { InstanceIds: [binding.instanceId] }, signal)
      const requestId = cleanRequestId(result.RequestId)
      if (result.InstanceSet != null && !Array.isArray(result.InstanceSet)) {
        throw new AgsError('InvalidCloudResponse', requestId)
      }
      const instance = result.InstanceSet?.find(item => item?.InstanceId === binding.instanceId)
      if (!instance) return { status: 'NOT_FOUND', persistent: false, expiresAt: null, requestId }
      const state = typeof instance.Status === 'string' ? instance.Status.toUpperCase() : ''
      return {
        status: statuses.has(state) ? state : 'UNKNOWN',
        persistent: instance.Persistent === true,
        expiresAt: expiryTime(instance.ExpiresAt),
        requestId,
      }
    },
    async extend(binding, minutes, signal) {
      const result = await call(writeAction, binding, { InstanceId: binding.instanceId, Timeout: `${minutes}m` }, signal)
      const requestId = cleanRequestId(result.RequestId)
      if (!requestId) throw new AgsError('InvalidCloudResponse')
      return requestId
    },
  }
}
