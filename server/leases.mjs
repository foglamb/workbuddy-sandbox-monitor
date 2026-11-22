import { AgsError } from './ags.mjs'
import { AppError, invalid } from './errors.mjs'

const minute = 60_000
const retryAfter = 5 * minute
const eventLimit = 24
const defaults = Object.freeze({ enabled: false, intervalSec: 120, renewBeforeMinutes: 10, extendMinutes: 60, runForMinutes: 0 })

export function validateLeasePolicy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !Object.hasOwn(defaults, key)) || typeof input.enabled !== 'boolean') {
    throw invalid('请填写有效的实例续期策略')
  }
  const { enabled, intervalSec, renewBeforeMinutes, extendMinutes, runForMinutes = 0 } = input
  const inRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max
  if (!inRange(intervalSec, 60, 1800)) throw invalid('查询间隔须为 60–1800 秒')
  if (!inRange(renewBeforeMinutes, 3, 240)) throw invalid('续期提前量须为 3–240 分钟')
  if (!inRange(extendMinutes, 15, 1440) || extendMinutes < renewBeforeMinutes + 10) {
    throw invalid('续期后时长须为 15–1440 分钟，且至少比提前量多 10 分钟')
  }
  if (intervalSec * 2 > renewBeforeMinutes * 60) throw invalid('查询间隔不得超过续期提前量的一半')
  if (runForMinutes !== 0 && !inRange(runForMinutes, 15, 10_080)) {
    throw invalid('自动续期持续时间须为 0（不限时）或 15–10080 分钟的整数')
  }
  return { enabled, intervalSec, renewBeforeMinutes, extendMinutes, runForMinutes }
}

export class LeaseManager {
  constructor(db, bindings, provider, { now = Date.now } = {}) {
    this.provider = provider
    this.now = now
    this.bindings = new Map(bindings.map(binding => [binding.id, binding]))
    this.states = new Map()
    this.active = new Map()
    this.lastStart = new Map()
    this.timer = null
    this.stopping = false
    db.exec(`CREATE TABLE IF NOT EXISTS runtime_leases (
      id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, snapshot TEXT NOT NULL
    ) STRICT`)
    this.write = db.prepare(`INSERT INTO runtime_leases(id, fingerprint, snapshot) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint, snapshot=excluded.snapshot`)
    const stored = db.prepare('SELECT fingerprint, snapshot FROM runtime_leases WHERE id = ?')
    for (const binding of bindings) {
      const row = stored.get(binding.id)
      if (row?.fingerprint === binding.fingerprint) {
        const snapshot = JSON.parse(row.snapshot)
        const policy = { ...defaults, ...snapshot.policy }
        // Old policies remain unlimited. A missing deadline for a timed policy fails closed.
        const pauseAt = policy.runForMinutes > 0
          ? (Number.isSafeInteger(snapshot.pauseAt) ? snapshot.pauseAt : this.now()) : null
        this.states.set(binding.id, { ...snapshot, policy, pauseAt })
      } else this.save(binding.id, { policy: { ...defaults }, observed: null, pending: null, nextAt: null, pauseAt: null,
        lastAttemptAt: null, lastVerifiedAt: null, lastError: null, failures: 0, history: [] })
      this.enforceDeadline(binding.id)
    }
  }

  state(id) {
    const value = this.states.get(id)
    if (!value) throw new AppError(404, 'missing_lease', '找不到已配置的实例绑定')
    return value
  }

  view(id) {
    const { policy, observed, pending, nextAt, pauseAt, lastVerifiedAt, lastError, history } = this.enforceDeadline(id)
    const { label, region } = this.bindings.get(id)
    return { id, label, region, policy, observed, nextAt, pauseAt, lastVerifiedAt, lastError, history,
      pending: pending && { at: pending.at, acknowledged: Boolean(pending.requestId) }, running: this.active.has(id) }
  }

  list() { return Array.from(this.bindings.keys(), id => this.view(id)) }

  save(id, state, event) {
    if (event) state = { ...state, history: [{ at: this.now(), ...event }, ...state.history].slice(0, eventLimit) }
    this.write.run(id, this.bindings.get(id).fingerprint, JSON.stringify(state))
    this.states.set(id, state)
    return state
  }

  enforceDeadline(id, at = this.now()) {
    const state = this.state(id)
    if (!state.policy.enabled || state.pauseAt === null || at < state.pauseAt) return state
    return this.save(id, { ...state, policy: { ...state.policy, enabled: false }, nextAt: null },
      { kind: 'auto_paused', pauseAt: state.pauseAt })
  }

  nextRun(state, at) {
    if (!state.policy.enabled) return null
    return Math.min(at, state.pauseAt ?? at)
  }

  update(id, input) {
    const now = this.now()
    const state = this.enforceDeadline(id, now)
    const policy = validateLeasePolicy(input)
    // An older open browser tab must not accidentally remove an existing deadline.
    if (!Object.hasOwn(input, 'runForMinutes')) policy.runForMinutes = state.policy.runForMinutes
    const changed = Object.keys(defaults).some(key => policy[key] !== state.policy[key])
    if (!changed) return this.view(id)
    const resetWindow = !state.policy.enabled || state.policy.runForMinutes !== policy.runForMinutes
    const pauseAt = !policy.enabled || policy.runForMinutes === 0 ? null
      : resetWindow ? now + policy.runForMinutes * minute : state.pauseAt
    const nextAt = policy.enabled ? now : null
    this.save(id, { ...state, policy, nextAt, pauseAt }, { kind: policy.enabled ? 'enabled' : 'paused' })
    return this.view(id)
  }

  start() {
    if (this.timer || this.stopping || !this.bindings.size) return
    this.timer = setInterval(() => this.tick(), 1500)
    this.tick()
  }

  async stop() {
    this.stopping = true
    clearInterval(this.timer)
    this.timer = null
    const jobs = [...this.active.values()]
    for (const job of jobs) job.controller.abort()
    await Promise.allSettled(jobs.map(job => job.promise))
  }

  tick() {
    if (this.stopping) return
    const at = this.now()
    // Enforce every deadline even while cloud calls or retry backoffs occupy the queue.
    for (const id of this.states.keys()) this.enforceDeadline(id, at)
    const due = [...this.states.entries()]
      .filter(([id, s]) => s.policy.enabled && s.nextAt !== null && s.nextAt <= at && this.available(id, at))
      .sort((a, b) => a[1].nextAt - b[1].nextAt)
    for (const [id] of due) {
      if (this.stopping || this.active.size >= 2) break
      this.run(id, 'scheduled').catch(() => console.error('实例调度未能完成'))
    }
  }

  available(id, at) { return !this.active.has(id) && at - (this.lastStart.get(id) ?? -Infinity) >= 10_000 }

  async run(id, trigger = 'manual') {
    const at = this.now()
    const state = this.enforceDeadline(id, at)
    if (trigger === 'scheduled' && (!state.policy.enabled || state.nextAt === null || state.nextAt > at)) return this.view(id)
    if (this.stopping || this.active.size >= 2 || !this.available(id, at)) {
      throw new AppError(429, 'lease_busy', '实例正在查询或最近已查，请稍后再试')
    }
    const controller = new AbortController()
    const job = { controller, promise: null }
    this.active.set(id, job)
    this.lastStart.set(id, at)
    job.promise = this.inspect(id, trigger, controller.signal)
    try {
      await job.promise
    } finally {
      this.active.delete(id)
    }
    return this.view(id)
  }

  async inspect(id, trigger, signal) {
    const binding = this.bindings.get(id)
    let phase = 'query'
    try {
      const result = await this.provider.describe(binding, signal)
      signal.throwIfAborted()
      const now = this.now()
      const state = this.enforceDeadline(id, now)
      const observed = { ...result, at: now }
      const next = { ...state, observed, lastError: null, failures: 0 }
      if (trigger === 'scheduled') next.nextAt = this.nextRun(next, now + next.policy.intervalSec * 1000)
      let event = state.observed?.status !== observed.status || trigger === 'manual'
        ? { kind: 'observed', status: observed.status, requestId: observed.requestId } : null
      if (next.pending && observed.status === 'RUNNING' && observed.expiresAt > next.pending.expiresAt) {
        event = { kind: next.pending.requestId ? 'verified' : 'expiry_changed',
          expiresAt: observed.expiresAt, requestId: next.pending.requestId }
        if (next.pending.requestId) next.lastVerifiedAt = now
        next.pending = null
      } else if (next.pending && now - next.pending.at >= retryAfter) {
        event = { kind: 'unverified', requestId: next.pending.requestId }
        next.pending = null
      }
      this.save(id, next, event)
      const { policy } = next
      const remaining = observed.expiresAt === null ? 0 : observed.expiresAt - now
      if (trigger !== 'scheduled' || !policy.enabled || next.pending || observed.status !== 'RUNNING' ||
          observed.persistent || remaining <= 0 || remaining > policy.renewBeforeMinutes * minute ||
          (next.lastAttemptAt !== null && now - next.lastAttemptAt < retryAfter)) return

      phase = 'renew'
      const checkedAt = this.now()
      const ready = this.enforceDeadline(id, checkedAt)
      if (!ready.policy.enabled) return
      const pending = { at: checkedAt, expiresAt: observed.expiresAt, requestId: null }
      this.save(id, { ...ready, pending, lastAttemptAt: checkedAt }, { kind: 'requested' })
      const requestId = await this.provider.extend(binding, ready.policy.extendMinutes, signal)
      signal.throwIfAborted()
      const current = this.enforceDeadline(id)
      this.save(id, { ...current, pending: { ...pending, requestId } }, { kind: 'accepted', requestId })
    } catch (error) {
      if (signal.aborted) return
      if (!(error instanceof AgsError)) throw error
      const state = this.enforceDeadline(id)
      const failures = Math.min(state.failures + 1, 5)
      const nextAt = this.nextRun(state, this.now() + Math.min(30, 2 ** failures) * minute)
      const lastError = { code: error.code, requestId: error.requestId, at: this.now(), phase }
      this.save(id, { ...state, lastError, failures, nextAt }, { kind: 'error', code: error.code, requestId: error.requestId })
    }
  }
}
