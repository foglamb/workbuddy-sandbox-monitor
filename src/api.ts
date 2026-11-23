import type { Lease, LeasePolicy } from './lease-model'
import type { Check, CheckStats, Sandbox, SandboxConfig } from './model'
import type { PythonAccount, PythonActions, PythonField, PythonSharedActions, PythonTask, PythonValue } from './python-model'
import type { PauseResult, TaskTarget } from './task-model'

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export interface Workspace {
  sandboxes: Sandbox[]
  leases: Lease[]
  pythonTasks: PythonTask[]
  pythonSchema: PythonField[]
  pythonEnabled: boolean
  pythonAccounts: PythonAccount[]
  pythonDefaults: Record<string, PythonValue>
  allowHttp: boolean
  maxSandboxes: number
  serverTime: number
}

export function makeApi(getToken: () => string) {
  async function request<T>(path: string, method = 'GET', data?: unknown, signal?: AbortSignal): Promise<T> {
    const headers = new Headers()
    const token = getToken()
    if (token) headers.set('Authorization', `Bearer ${token}`)
    if (data !== undefined) headers.set('Content-Type', 'application/json')
    const timeout = AbortSignal.timeout(35_000)
    const response = await fetch(`/api${path}`, {
      method, headers, body: data === undefined ? undefined : JSON.stringify(data),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      cache: 'no-store',
    })
    const body = await response.json().catch(() => null)
    if (!response.ok) throw new ApiError(response.status, body?.message ?? `请求失败 (${response.status})`)
    if (body === null) throw new Error('监控服务的响应无效')
    return body as T
  }
  const taskPath = (id: string) => `/python-tasks/${encodeURIComponent(id)}`
  const python: PythonActions = {
    create: input => request('/python-tasks', 'POST', input),
    update: (id, input) => request(taskPath(id), 'PUT', input),
    remove: id => request(taskPath(id), 'DELETE'),
    start: (id, options) => request(`${taskPath(id)}/start`, 'POST', options ?? {}),
    stop: (id, runId) => {
      if (!runId) return Promise.reject(new Error('运行状态已变化，请刷新后重试。'))
      return request(`${taskPath(id)}/stop`, 'POST', { runId })
    },
    reveal: id => request(`${taskPath(id)}/reveal`, 'POST'),
    logs: (id, after, signal) => request(`${taskPath(id)}/logs?after=${encodeURIComponent(after)}`, 'GET', undefined, signal),
    clearLogs: id => request(`${taskPath(id)}/logs`, 'DELETE'),
  }
  const accountPath = (id: string) => `/python-accounts/${encodeURIComponent(id)}`
  const pythonShared: PythonSharedActions = {
    saveDefaults: params => request('/python-defaults', 'PUT', { params }),
    createAccount: input => request('/python-accounts', 'POST', input),
    updateAccount: (id, input) => request(accountPath(id), 'PUT', input),
    removeAccount: id => request(accountPath(id), 'DELETE'),
    revealAccount: id => request(`${accountPath(id)}/reveal`, 'POST'),
    loadPushPlus: () => request('/pushplus'),
    savePushPlus: input => request('/pushplus', 'PUT', input),
    testPushPlus: () => request('/pushplus/test', 'POST', {}),
    changeAdminPassword: (current, next) => request('/admin/password', 'POST', { current, next }),
  }
  return {
    python,
    pythonShared,
    list: (signal?: AbortSignal) => request<Workspace>('/sandboxes', 'GET', undefined, signal),
    add: (config: SandboxConfig) => request<{ sandbox: Sandbox }>('/sandboxes', 'POST', config),
    edit: (id: string, config: SandboxConfig) => request<{ sandbox: Sandbox }>(`/sandboxes/${id}`, 'PUT', config),
    enable: (id: string, enabled: boolean) => request<{ sandbox: Sandbox }>(`/sandboxes/${id}`, 'PATCH', { enabled }),
    remove: (id: string) => request<{ ok: boolean }>(`/sandboxes/${id}`, 'DELETE'),
    check: (id: string) => request<{ result: Check }>(`/sandboxes/${id}/check`, 'POST'),
    history: (id: string, signal: AbortSignal, options: { limit?: number; before?: number } = {}) => {
      const query = new URLSearchParams()
      if (options.limit !== undefined) query.set('limit', String(options.limit))
      if (options.before !== undefined) query.set('before', String(options.before))
      const suffix = query.size ? `?${query}` : ''
      return request<{ checks: Check[]; generation: number }>(`/sandboxes/${id}/checks${suffix}`, 'GET', undefined, signal)
    },
    stats: (id: string, signal: AbortSignal, hours?: number) => request<{ stats: CheckStats }>(
      `/sandboxes/${id}/stats${hours === undefined ? '' : `?hours=${hours}`}`, 'GET', undefined, signal),
    importBackup: (data: unknown) => request<{ count: number }>('/sandboxes/import', 'POST', data),
    updateLease: (id: string, policy: LeasePolicy) => request<{ lease: Lease }>(`/leases/${id}`, 'PUT', policy),
    queryLease: (id: string) => request<{ lease: Lease }>(`/leases/${id}/query`, 'POST'),
    pauseTasks: (targets: TaskTarget[]) => request<{ results: PauseResult[] }>('/tasks/pause', 'POST', { targets }),
  }
}

export function errorMessage(error: unknown) {
  if (error instanceof ApiError) return error.message
  if (error instanceof TypeError) return '无法连接监控服务，请检查服务是否启动'
  if (error instanceof Error && error.name === 'TimeoutError') return '管理请求超时，请稍后重试'
  return error instanceof Error ? error.message : '操作失败，请稍后重试'
}
