export type PythonValue = string | number | boolean
export interface PythonField {
  key: string
  label: string
  group: string
  type: 'string' | 'number' | 'boolean'
  default: PythonValue
  min?: number
  max?: number
  step?: number
  hint?: string
}
export interface PythonTaskInput {
  name: string
  notes: string
  params: Record<string, PythonValue>
  credentials?: { JWT?: string | null; RT?: string | null }
  accountId?: string | null
}
export interface PythonAccount {
  id: string
  name: string
  base: string
  uid: string
  hasJWT: boolean
  hasRT: boolean
  inUse: number
}
export interface PythonAccountInput {
  name: string
  base?: string
  uid?: string
  sourceTaskId?: string
  credentials?: { JWT?: string | null; RT?: string | null }
}
export interface PushPlusConfig {
  enabled: boolean
  hasToken: boolean
  topic: string
  events: readonly string[]
}
export interface PushPlusInput {
  enabled?: boolean
  token?: string | null
  topic?: string
  events?: readonly string[]
}
export interface PythonSharedActions {
  saveDefaults: (params: Record<string, PythonValue>) => Promise<{ defaults: Record<string, PythonValue> }>
  createAccount: (input: PythonAccountInput) => Promise<{ account: PythonAccount }>
  updateAccount: (id: string, input: PythonAccountInput) => Promise<{ account: PythonAccount }>
  removeAccount: (id: string) => Promise<{ ok: boolean }>
  revealAccount: (id: string) => Promise<{ credentials: { JWT: string; RT: string } }>
  loadPushPlus: () => Promise<{ pushplus: PushPlusConfig }>
  savePushPlus: (input: PushPlusInput) => Promise<{ pushplus: PushPlusConfig }>
  testPushPlus: () => Promise<{ result: { ok: boolean } }>
  changeAdminPassword: (current: string, next: string) => Promise<{ ok: boolean }>
}
export interface PythonTask {
  id: string
  name: string
  notes: string
  params: Readonly<Record<string, PythonValue>>
  hasJWT: boolean
  hasRT: boolean
  accountId: string | null
  accountName: string | null
  overrideKeys: string[]
  runningParams: Readonly<Record<string, PythonValue>> | null
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'error'
  runId: string | null
  runDurationSeconds: number | null
  pid: number | null
  memoryBytes: number | null
  lastStartedAt: number | null
  lastStoppedAt: number | null
  lastExitCode: number | null
  lastError: string | null
}
export interface PythonLog { seq: number; at: number; stream: 'stdout' | 'stderr' | 'system'; text: string }
export interface PythonActions {
  create: (input: PythonTaskInput) => Promise<{ task: PythonTask }>
  update: (id: string, input: PythonTaskInput) => Promise<{ task: PythonTask }>
  remove: (id: string) => Promise<{ ok: boolean }>
  start: (id: string, options?: { durationSeconds?: number }) => Promise<{ task: PythonTask }>
  stop: (id: string, runId: string) => Promise<{ task: PythonTask }>
  reveal: (id: string) => Promise<{ credentials: { JWT: string; RT: string } }>
  logs: (id: string, after: number, signal: AbortSignal) => Promise<{ logs: PythonLog[]; nextAfter: number }>
  clearLogs: (id: string) => Promise<{ removed: number }>
}
export const pythonStatus = { starting: '启动中', running: '运行中', stopping: '停止中', stopped: '已停止', error: '已退出/启动失败' } as const
