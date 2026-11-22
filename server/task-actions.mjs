import { bindingIdPattern } from './ags.mjs'
import { isRecord } from './config.mjs'
import { AppError, invalid } from './errors.mjs'

const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/

export function validatePauseTargets(input) {
  if (!isRecord(input) || Object.keys(input).length !== 1 || !Array.isArray(input.targets) ||
      input.targets.length < 1 || input.targets.length > 88) {
    throw invalid('请选择 1–88 个要暂停的任务')
  }
  const keys = new Set()
  return input.targets.map(target => {
    if (!isRecord(target) || Object.keys(target).length !== 2 ||
        !['url', 'lease'].includes(target.kind) || typeof target.id !== 'string') {
      throw invalid('每项任务须仅包含 kind 和 id')
    }
    const { kind, id } = target
    if (!(kind === 'url' ? uuidPattern : bindingIdPattern).test(id)) throw invalid('任务标识格式不正确')
    const key = `${kind}:${id}`
    if (keys.has(key)) throw invalid('同一任务不能重复选择')
    keys.add(key)
    return { kind, id }
  })
}

export function pauseTasks(input, { store, leases, scheduler, now }) {
  // Validate the entire request before making the first change.
  const targets = validatePauseTargets(input)
  return targets.map(({ kind, id }) => {
    try {
      if (kind === 'url') {
        const config = JSON.parse(store.row(id).config)
        if (!config.enabled) return { kind, id, status: 'already_paused' }
        store.update(id, { ...config, enabled: false }, now())
        scheduler.cancel(id)
      } else {
        const { policy } = leases.view(id)
        if (!policy.enabled) return { kind, id, status: 'already_paused' }
        // Preserve the latest server-side policy rather than accepting a stale browser copy.
        leases.update(id, { ...policy, enabled: false })
      }
      return { kind, id, status: 'paused' }
    } catch (error) {
      const missing = error instanceof AppError && error.status === 404
      return { kind, id, status: 'failed', code: missing ? 'missing_task' : 'pause_failed',
        message: missing ? '任务不存在，可能已被删除或解除绑定' : '未能确认暂停，请刷新查看任务状态' }
    }
  })
}
