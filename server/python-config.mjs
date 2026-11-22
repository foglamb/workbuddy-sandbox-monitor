import { invalid } from './errors.mjs'

const text = (key, label, group, value = '', hint) => ({ key, label, group, type: 'string', default: value, hint })
const num = (key, label, group, value, min, max, step = 1) => ({ key, label, group, type: 'number', default: value, min, max, step })
const bool = (key, label, group, value) => ({ key, label, group, type: 'boolean', default: value })
export const pythonSchema = [
  text('BASE', '平台地址 BASE', '平台与会话', 'https://copilot.tencent.com'),
  text('CONV_ID', '会话 ID CONV_ID', '平台与会话'),
  text('UID', '用户 ID UID', '平台与会话'),
  num('HEARTBEAT_TIMEOUT', '心跳超时（秒）', '连接与重连', 10, 1, 3600),
  num('IDLE_RECYCLE', '主动轮换（秒，0 关闭）', '连接与重连', 0, 0, 86400),
  num('RECONNECT_BASE', '重连基数（毫秒）', '连接与重连', 300, 100, 60000),
  num('RECONNECT_MAX', '重连上限（毫秒）', '连接与重连', 3000, 100, 300000),
  bool('RECONNECT_JITTER', '重连抖动', '连接与重连', true),
  num('CONNECT_TIMEOUT', '建连超时（秒）', '连接与重连', 30, 1, 120),
  num('READ_TIMEOUT', '单次读取超时（秒）', '连接与重连', 2, 1, 120),
  bool('TCP_KEEPALIVE', 'TCP keepalive', 'TCP 保活', true),
  num('TCP_KEEPIDLE', 'TCP 空闲（秒）', 'TCP 保活', 10, 1, 3600),
  num('TCP_KEEPINTVL', 'TCP 探活间隔（秒）', 'TCP 保活', 5, 1, 3600),
  num('TCP_KEEPCNT', 'TCP 探活次数', 'TCP 保活', 3, 1, 30),
  bool('PULSE_ENABLE', '会话脉冲', '会话与令牌', true),
  num('PULSE_INTERVAL', '脉冲间隔（秒）', '会话与令牌', 30, 1, 86400),
  num('RENEW_THRESHOLD', '令牌续期阈值（秒）', '会话与令牌', 604800, 0, 2592000),
  text('SITE', '业务网址 SITE', '业务探测'),
  bool('SITE_ENABLE', '启用业务探测', '业务探测', false),
  num('SITE_CHECK_INT', '探测间隔（秒）', '业务探测', 30, 1, 86400),
  num('SITE_FAIL_LIMIT', '连续探测失败阈值', '业务探测', 2, 1, 100),
  bool('STATE_ENABLE', '令牌状态落盘', '状态与日志', true),
  bool('LOG_TO_FILE', '脚本日志落盘', '状态与日志', true),
]
export const pythonCommonKeys = pythonSchema.map(field => field.key).filter(key => !['BASE', 'UID', 'CONV_ID', 'SITE', 'SITE_ENABLE'].includes(key))
const fields = new Map(pythonSchema.map(field => [field.key, field]))
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function validatePythonInput(input, inherited = {}) {
  if (!record(input) || Object.keys(input).some(key => !['name', 'notes', 'params', 'credentials', 'accountId'].includes(key))) throw invalid('脚本配置格式不正确')
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 60) throw invalid('配置名称须为 1–60 字符')
  if (input.notes !== undefined && (typeof input.notes !== 'string' || input.notes.length > 400)) throw invalid('备注不能超过 400 字符')
  if (!record(input.params) || Object.keys(input.params).some(key => !fields.has(key))) throw invalid('脚本参数包含未知字段')
  const params = {}
  for (const field of pythonSchema) {
    const value = Object.hasOwn(input.params, field.key) ? input.params[field.key] : inherited[field.key] ?? field.default
    if (typeof value !== field.type) throw invalid(`${field.label} 的类型不正确`)
    if (field.type === 'number' && (!Number.isInteger(value) || value < field.min || value > field.max)) throw invalid(`${field.label} 须在 ${field.min}–${field.max} 之间`)
    if (field.type === 'string' && (value.length > 1024 || /[\x00-\x1f]/.test(value))) throw invalid(`${field.label} 太长或包含控制字符`)
    params[field.key] = field.type === 'string' ? value.trim() : value
  }
  for (const key of ['BASE', 'SITE']) {
    if (!params[key] && key === 'SITE') continue
    let url
    try { url = new URL(params[key]) } catch { throw invalid(`${key} 须为完整 HTTP(S) 地址`) }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw invalid(`${key} 地址格式不正确`)
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    if (host === 'api.zxcbug.com' || host.endsWith('.api.zxcbug.com')) throw invalid('不能使用此目标域名')
    if (key === 'BASE' && (url.search || url.hash || url.pathname !== '/')) throw invalid('BASE 只填写协议、主机和端口')
    params[key] = key === 'BASE' ? url.origin : url.href
  }
  if (params.CONV_ID && !/^[a-zA-Z0-9_-]{1,100}$/.test(params.CONV_ID)) throw invalid('会话 ID 格式不正确')
  if (params.UID && !/^[a-zA-Z0-9_-]{1,100}$/.test(params.UID)) throw invalid('用户 ID 格式不正确')
  if (params.RECONNECT_MAX < params.RECONNECT_BASE) throw invalid('重连上限不能小于基数')
  if (params.SITE_ENABLE && !params.SITE) throw invalid('启用业务探测时必须填写 SITE')
  if (input.accountId !== undefined && input.accountId !== null && (typeof input.accountId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.accountId))) throw invalid('共享账号标识无效')
  const credentials = input.credentials ?? {}
  if (!record(credentials) || Object.keys(credentials).some(key => !['JWT', 'RT'].includes(key))) throw invalid('凭据格式不正确')
  for (const value of Object.values(credentials)) {
    if (value !== null && (typeof value !== 'string' || value.trim().length < 16 || value.length > 16384 || /\s/.test(value.trim()))) throw invalid('令牌须为 16–16384 字符且不能包含空白；清除请使用清除选项')
  }
  return { name: input.name.trim(), notes: (input.notes || '').trim(), params, credentials,
    ...(input.accountId !== undefined ? { accountId: input.accountId } : {}) }
}
