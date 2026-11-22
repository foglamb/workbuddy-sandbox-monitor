import { AppError } from './errors.mjs'

export class Scheduler {
  constructor(store, check, { concurrency, now = Date.now, cooldownMs = 10_000 }) {
    this.store = store
    this.check = check
    this.concurrency = concurrency
    this.now = now
    this.cooldownMs = cooldownMs
    this.active = new Map()
    this.lastStart = new Map()
    this.timer = null
  }

  running = id => this.active.has(id)

  start() {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), 1000)
    this.tick()
  }

  stop() {
    clearInterval(this.timer)
    this.timer = null
    for (const controller of this.active.values()) controller.abort()
  }

  cancel(id) { this.active.get(id)?.abort() }

  forget(id) {
    this.cancel(id)
    this.lastStart.delete(id)
  }

  coolingDown(id, now) {
    return now - (this.lastStart.get(id) ?? -Infinity) < this.cooldownMs
  }

  tick() {
    if (this.active.size >= this.concurrency) return
    const now = this.now()
    for (const { id } of this.store.due(now)) {
      if (this.active.size >= this.concurrency) break
      if (this.running(id) || this.coolingDown(id, now)) continue
      this.run(id, 'scheduled').catch(error => {
        if (!(error instanceof AppError && error.code === 'cancelled')) {
          console.error('计划检查未能保存', error?.code || error?.name)
        }
      })
    }
  }

  async run(id, trigger = 'manual') {
    const now = this.now()
    const row = this.store.row(id)
    if (this.running(id)) throw new AppError(409, 'check_in_progress', '该沙盒正在检查')
    if (this.coolingDown(id, now)) {
      throw new AppError(429, 'check_cooldown', '检查间隔过短，请稍后再试')
    }
    if (this.active.size >= this.concurrency) {
      throw new AppError(429, 'scheduler_busy', '检查队列正忙，请稍后再试')
    }
    const controller = new AbortController()
    this.active.set(id, controller)
    this.lastStart.set(id, now)
    try {
      const result = await this.check(JSON.parse(row.config), controller.signal)
      controller.signal.throwIfAborted()
      return this.store.record(id, row.generation, result, this.now(), trigger)
    } catch (error) {
      if (controller.signal.aborted) throw new AppError(409, 'cancelled', '本次检查已取消')
      throw error
    } finally {
      this.active.delete(id)
    }
  }
}
