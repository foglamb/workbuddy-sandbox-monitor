import type { Lease } from './lease-model'
import type { Sandbox } from './model'

export interface TaskTarget {
  kind: 'url' | 'lease'
  id: string
}

export interface PauseCandidate {
  target: TaskTarget
  name: string
  context: string
}

export type PauseResult = TaskTarget & (
  { status: 'paused' | 'already_paused' } |
  { status: 'failed'; code: 'missing_task' | 'pause_failed'; message: string }
)

export const taskKey = (target: TaskTarget) => `${target.kind}:${target.id}`

export function collectPauseCandidates(sandboxes: readonly Sandbox[], leases: readonly Lease[]): PauseCandidate[] {
  return [
    ...sandboxes.filter(item => item.config.enabled).map(item => ({
      target: { kind: 'url' as const, id: item.id }, name: item.config.name,
      context: item.config.group ? `网址检查 · ${item.config.group}` : '网址检查',
    })),
    ...leases.filter(item => item.policy.enabled).map(item => ({
      target: { kind: 'lease' as const, id: item.id }, name: item.label, context: `实例续期 · ${item.region}`,
    })),
  ]
}
