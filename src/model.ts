export type SandboxStatus = 'pending' | 'up' | 'degraded' | 'down' | 'paused'
export type CheckCode = 'ok' | 'http' | 'body' | 'timeout' | 'dns' | 'tls' | 'network' | 'blocked'

export interface SandboxConfig {
  name: string
  url: string
  group: string
  notes: string
  expectedText: string
  method: 'GET' | 'HEAD'
  intervalSec: number
  timeoutSec: number
  failureThreshold: number
  successMin: number
  successMax: number
  enabled: boolean
}

export interface Check {
  id: number
  at: number
  trigger: 'manual' | 'scheduled'
  ok: boolean
  code: CheckCode
  statusCode: number | null
  durationMs: number
}

export interface Sandbox {
  id: string
  config: SandboxConfig
  status: SandboxStatus
  failures: number
  lastCheck: Check | null
  nextCheckAt: number | null
  running: boolean
}

export const defaultConfig: SandboxConfig = {
  name: '', url: '', group: '', notes: '', expectedText: '', method: 'GET',
  intervalSec: 120, timeoutSec: 8, failureThreshold: 3,
  successMin: 200, successMax: 299, enabled: true,
}

export const statusLabel: Record<SandboxStatus, string> = {
  pending: '待检查', up: '正常', degraded: '暂时异常', down: '不可用', paused: '已暂停',
}

const checkLabel: Record<CheckCode, string> = {
  ok: '正常', http: '状态码不符', body: '响应内容不符', timeout: '超时', dns: '域名解析失败',
  tls: 'TLS 错误', network: '连接失败', blocked: '地址不符合监控规则',
}

export function checkText(check: Check) {
  if (check.statusCode === null) return checkLabel[check.code]
  const prefix = `HTTP ${check.statusCode}`
  return check.code === 'body' ? `${prefix} · ${checkLabel.body}` : prefix
}

const dateTime = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})

export function displayTime(value: number | null | undefined) {
  return typeof value === 'number' ? dateTime.format(value) : '—'
}

export function displayInterval(seconds: number) {
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`
  return `${seconds} 秒`
}
