export interface LeasePolicy {
  enabled: boolean
  intervalSec: number
  renewBeforeMinutes: number
  extendMinutes: number
  runForMinutes: number
}

export type LeaseEventKind = 'enabled' | 'paused' | 'observed' | 'requested' | 'accepted' |
  'verified' | 'unverified' | 'expiry_changed' | 'error' | 'auto_paused'

export interface LeaseEvent {
  kind: LeaseEventKind
  at: number
  code?: string
  status?: string
  requestId?: string | null
  expiresAt?: number
  pauseAt?: number
}

export interface Lease {
  id: string
  label: string
  region: string
  policy: LeasePolicy
  observed: { status: string; expiresAt: number | null; persistent: boolean; at: number; requestId: string | null } | null
  pending: { at: number; acknowledged: boolean } | null
  nextAt: number | null
  pauseAt: number | null
  lastVerifiedAt: number | null
  lastError: { phase: 'query' | 'renew'; code: string; at: number; requestId: string | null } | null
  history: readonly LeaseEvent[]
  running: boolean
}

const stateNames = new Map(Object.entries({
  RUNNING: '运行中', NOT_FOUND: '未找到实例', STARTING: '启动中', STOPPING: '停止中', STOPPED: '已停止',
  PAUSING: '暂停中', PAUSED: '已暂停', RESUMING: '恢复中', RESIZING: '调整规格中', FAILED: '运行失败',
  STARTING_FAILED: '启动失败', STOP_FAILED: '停止失败', RESUME_FAILED: '恢复失败', PAUSE_FAILED: '暂停失败',
}))

export function leaseStatus(status?: string) {
  if (!status) return '待查询'
  return stateNames.get(status) ?? '未知状态'
}

const eventNames: Record<LeaseEventKind, string> = {
  enabled: '已保存并启用策略', paused: '已保存为暂停', observed: '查询实例状态', requested: '开始提交续期',
  accepted: '云端受理，待核验', verified: '已核验到期时间延长', unverified: '未核验到期时间延长',
  expiry_changed: '到期时间已变更，无法确认来自本次请求', error: '云端调用未完成',
  auto_paused: '已到定时截止，自动暂停',
}

export function leaseEventText(event: LeaseEvent) {
  const name = eventNames[event.kind]
  return event.status ? `${name} · ${leaseStatus(event.status)}` : event.code ? `${name} · ${event.code}` : name
}

const formatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  timeZoneName: 'short', hourCycle: 'h23',
})

export function leaseTime(at: number | null | undefined) {
  return typeof at === 'number' ? formatter.format(at) : '—'
}
