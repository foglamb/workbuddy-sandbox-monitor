import type { Lease } from './lease-model'
import type { Sandbox } from './model'

export interface OverviewTarget {
  kind: 'url' | 'lease'
  id: string
}

type Severity = 'urgent' | 'attention' | 'waiting'
type Finding = {
  severity: Severity
  title: string
  detail: string
  expiresAt?: number
  leaseStatus?: string
}

interface OverviewItem extends Finding {
  target: OverviewTarget
  name: string
  context: string
}

const minute = 60_000
const severityOrder: Record<Severity, number> = { urgent: 0, attention: 1, waiting: 2 }
const notRenewable = new Set(['NOT_FOUND', 'STOPPED', 'STOPPING', 'FAILED', 'STOP_FAILED',
  'STARTING_FAILED', 'PAUSED', 'PAUSING', 'PAUSE_FAILED', 'RESUME_FAILED'])

function overdue(nextAt: number | null, running: boolean, now: number) {
  return !running && nextAt !== null && now - nextAt >= minute
}

function siteFinding(item: Sandbox, now: number): Finding | null {
  if (item.status === 'down' || item.status === 'degraded') {
    return {
      severity: item.status === 'down' ? 'urgent' : 'attention',
      title: item.status === 'down' ? '网址连续检查失败' : '网址检查暂时异常',
      detail: `连续失败 ${item.failures} 次，异常阈值 ${item.config.failureThreshold} 次。`,
    }
  }
  if (overdue(item.nextCheckAt, item.running, now)) {
    return { severity: 'attention', title: '网址检查超出计划时间', detail: '尚未开始计划检查；请查看后台进程和检查队列。' }
  }
  if (!item.lastCheck) return { severity: 'waiting', title: '等待首次检查', detail: '尚未取得此网址的检查结果。' }
  return null
}

function leaseFinding(item: Lease, now: number): Finding | null {
  const { observed, pending, lastError } = item
  if (item.pauseAt !== null && item.pauseAt !== undefined && item.pauseAt <= now) {
    return { severity: 'waiting', title: '等待定时暂停', detail: '已到策略截止时间，平台将停止自动续期。' }
  }
  const expiresAt = observed?.persistent ? undefined : observed?.expiresAt ?? undefined
  if (observed && notRenewable.has(observed.status)) {
    return { severity: 'urgent', title: '上次查询显示实例无法续期',
      detail: '平台不会自动启动或恢复实例。', leaseStatus: observed.status }
  }
  if (expiresAt !== undefined && expiresAt <= now) {
    return { severity: 'urgent', title: '上次记录的到期时间已到',
      detail: '请重新查询云端状态；到期记录不等于已确认停止。', expiresAt }
  }
  if (lastError) {
    return {
      severity: 'attention', title: lastError.phase === 'query' ? '实例查询未完成' : '续期请求未确认',
      detail: `云端错误码：${lastError.code}。`, expiresAt,
    }
  }
  if (overdue(item.nextAt, item.running, now)) {
    return { severity: 'attention', title: '实例查询超出计划时间', detail: '尚未开始计划查询；请查看后台进程和检查队列。', expiresAt }
  }
  if (pending) {
    const late = now - pending.at >= 5 * minute
    return {
      severity: late ? 'attention' : 'waiting', title: late ? '续期超过 5 分钟仍未核验' : '续期等待核验',
      detail: pending.acknowledged ? '云端已受理，但还未查到更晚的到期时间。' : '提交结果未确认，以后续查询为准。',
      expiresAt,
    }
  }
  if (!observed) return { severity: 'waiting', title: '等待首次查询', detail: '尚未取得这个实例的云端状态。' }
  if (observed.status !== 'RUNNING') {
    return { severity: observed.status === 'UNKNOWN' ? 'attention' : 'waiting', title: '尚未确认实例运行',
      detail: '仅运行中的限时实例可以自动续期。', leaseStatus: observed.status, expiresAt }
  }
  if (observed.persistent) return null
  if (expiresAt === undefined) {
    return { severity: 'attention', title: '云端未返回到期时间', detail: '没有到期时间时，平台不会提交续期。' }
  }
  const lastOutcome = item.history.find(event => event.kind === 'verified' || event.kind === 'unverified' || event.kind === 'expiry_changed')
  if (lastOutcome?.kind === 'unverified') {
    return { severity: 'attention', title: '最近一次续期未核验', detail: '未查到更晚的到期时间；可查看实例事件。', expiresAt }
  }
  if (expiresAt - now <= item.policy.renewBeforeMinutes * minute) {
    const remaining = Math.ceil((expiresAt - now) / minute)
    return { severity: 'attention', title: '已进入续期窗口', detail: `距上次记录的到期时间约 ${remaining} 分钟。`, expiresAt }
  }
  return null
}

export function buildOverview(sandboxes: readonly Sandbox[], leases: readonly Lease[], serverTime: number) {
  const items: OverviewItem[] = []
  let urlsActive = 0
  let leasesActive = 0
  for (const sandbox of sandboxes) {
    if (!sandbox.config.enabled) continue
    urlsActive++
    const finding = siteFinding(sandbox, serverTime)
    if (finding) items.push({ ...finding, target: { kind: 'url', id: sandbox.id }, name: sandbox.config.name,
      context: sandbox.config.group ? `网址 · ${sandbox.config.group}` : '网址检查' })
  }
  for (const lease of leases) {
    if (!lease.policy.enabled) continue
    leasesActive++
    const finding = leaseFinding(lease, serverTime)
    if (finding) items.push({ ...finding, target: { kind: 'lease', id: lease.id }, name: lease.label,
      context: `实例 · ${lease.region}` })
  }
  items.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] ||
    (a.expiresAt ?? Number.MAX_SAFE_INTEGER) - (b.expiresAt ?? Number.MAX_SAFE_INTEGER))
  const waiting = items.filter(item => item.severity === 'waiting').length
  return { items, urlsActive, leasesActive, waiting, attention: items.length - waiting }
}
