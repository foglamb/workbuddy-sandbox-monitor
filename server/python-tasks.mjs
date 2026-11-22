import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { AppError, invalid } from './errors.mjs'
import { validatePythonInput } from './python-config.mjs'
import { createSecretBox } from './python-secrets.mjs'
import { readRss, watchMemory } from './python-memory.mjs'
import { PythonSharedSettings } from './python-shared.mjs'

const worker = fileURLToPath(new URL('./python/worker.py', import.meta.url))
const liveStates = new Set(['starting', 'running', 'stopping'])
const taskLimit = 200
// No fixed concurrency cap: each worker is bounded to ~21 MiB RSS / 96 MiB
// address space, so the safe number of runs is derived from free memory.
const perRunMemoryBytes = 96 * 1024 * 1024



// Only consulted when the operator sets WB_MAX_RUNS=0 for memory-derived mode.
// Read MemAvailable rather than MemFree: page cache is reclaimable and counting
// it as free would let the platform start far too many workers.
function availableMemory() {
  try {
    const status = readFileSync('/proc/meminfo', 'utf8')
    const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(status)
    if (match) return Number(match[1]) * 1024
  } catch { /* not Linux, or /proc unavailable */ }
  return Number.POSITIVE_INFINITY
}
const maxDurationSeconds = Math.floor(2_147_483_647 / 1000)

export class PythonTasks {
  constructor(db, dataFile, { now = Date.now, python = 'python3', onEvent, logLines = 1000,
    logFileBytes = 4 * 1024 * 1024, memoryCeilingMb = 512, maxRuns = 0, freeMemory = () => Number.POSITIVE_INFINITY } = {}) {
    this.db = db
    this.now = now
    this.python = python
    this.onEvent = typeof onEvent === 'function' ? onEvent : null
    this.logLines = logLines
    this.logFileBytes = logFileBytes
    this.memoryCeilingBytes = memoryCeilingMb * 1024 * 1024
    this.freeMemory = freeMemory
    this.maxRuns = maxRuns
    this.directory = dataFile === ':memory:' ? null : resolve(dirname(dataFile), 'python-tasks')
    this.active = new Map()
    this.closing = false
    db.exec(`CREATE TABLE IF NOT EXISTS python_tasks (
      id TEXT PRIMARY KEY, config TEXT NOT NULL, credentials TEXT NOT NULL, revision INTEGER NOT NULL,
      last_started INTEGER, last_stopped INTEGER, exit_code INTEGER, error TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS python_task_logs (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES python_tasks(id) ON DELETE CASCADE,
      at INTEGER NOT NULL, stream TEXT NOT NULL, text TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS python_logs_task ON python_task_logs(task_id, seq);
    CREATE TABLE IF NOT EXISTS python_accounts(id TEXT PRIMARY KEY, config TEXT NOT NULL, credentials TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS python_preferences(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`)
    // Any row holding ciphertext means the key file must already exist; missing it
    // would silently break saved credentials, so include the notification token.
    const count = db.prepare(`SELECT (SELECT count(*) FROM python_tasks) + (SELECT count(*) FROM python_accounts)
      + (SELECT count(*) FROM python_preferences WHERE key = 'pushplus_token') AS count`).get().count
    this.box = createSecretBox(dataFile, count > 0)
    this.shared = new PythonSharedSettings(db, this.box)
  }

  row(id) {
    const row = this.db.prepare('SELECT * FROM python_tasks WHERE id = ?').get(id)
    if (!row) throw new AppError(404, 'missing_python_task', '找不到脚本配置')
    return row
  }

  effective(row) {
    const config = JSON.parse(row.config)
    const account = config.accountId ? this.shared.view(config.accountId) : null
    const credentials = account ? this.shared.reveal(account.id) : this.box.decrypt(row.credentials)
    const inherited = { ...this.shared.defaults(), ...(account ? { BASE: account.base, UID: account.uid } : {}) }
    const params = validatePythonInput({ name: config.name, params: config.params }, inherited).params
    return { config, account, params, credentials }
  }

  view(id) {
    const row = this.row(id)
    const { config, account, params, credentials: secrets } = this.effective(row)
    const job = this.active.get(id)
    return { id, ...config, params, accountId: account?.id ?? null, accountName: account?.name ?? null,
      overrideKeys: Object.keys(config.params), runningParams: job?.params ?? null,
      hasJWT: Boolean(secrets.JWT), hasRT: Boolean(secrets.RT),
      status: job?.status ?? (row.error ? 'error' : 'stopped'), runId: job?.runId ?? null, runDurationSeconds: job?.durationSeconds ?? null,
      pid: job?.child.pid ?? null, memoryBytes: job ? readRss(job.child.pid) : null,
      lastStartedAt: row.last_started, lastStoppedAt: row.last_stopped, lastExitCode: row.exit_code, lastError: row.error }
  }

  list() { return this.db.prepare('SELECT id FROM python_tasks ORDER BY rowid').all().map(row => this.view(row.id)) }

  save(input, id) {
    if (id && this.active.has(id)) throw new AppError(409, 'python_running', '请先停止此脚本，再修改参数')
    const old = id ? this.row(id) : null
    if (!old && this.db.prepare('SELECT count(*) AS count FROM python_tasks').get().count >= taskLimit) {
      throw new AppError(409, 'python_limit', `最多保存 ${taskLimit} 份脚本配置`)
    }
    const previous = old ? JSON.parse(old.config) : null
    const accountId = input && Object.hasOwn(input, 'accountId') ? input.accountId : previous?.accountId ?? null
    if (accountId !== null && (typeof accountId !== 'string' || !/^[a-f0-9-]{36}$/.test(accountId))) throw invalid('共享账号标识无效')
    const account = accountId ? this.shared.view(accountId) : null
    const inherited = { ...this.shared.defaults(), ...(account ? { BASE: account.base, UID: account.uid } : {}) }
    const checked = validatePythonInput(input, inherited)
    if (account && (Object.hasOwn(input.params, 'BASE') || Object.hasOwn(input.params, 'UID') || Object.keys(checked.credentials).length)) {
      throw invalid('已选共享账号，BASE、UID 和凭据请在统一设置修改')
    }
    const params = account ? Object.fromEntries(Object.keys(input.params).map(key => [key, checked.params[key]])) : checked.params
    const config = { name: checked.name, notes: checked.notes, accountId, params }
    const credentials = account ? { JWT: '', RT: '' } : old ? this.box.decrypt(old.credentials) : { JWT: '', RT: '' }
    for (const key of ['JWT', 'RT']) {
      if (Object.hasOwn(checked.credentials, key)) credentials[key] = checked.credentials[key] === null ? '' : checked.credentials[key].trim().replace(/^Bearer\s+/i, '')
    }
    id ??= randomUUID()
    const revision = old ? old.revision + Number(JSON.stringify(previous.params) !== JSON.stringify(config.params) || previous.accountId !== accountId ||
      JSON.stringify(this.box.decrypt(old.credentials)) !== JSON.stringify(credentials)) : 1
    if (old) this.db.prepare('UPDATE python_tasks SET config=?, credentials=?, revision=?, error=NULL WHERE id=?')
      .run(JSON.stringify(config), this.box.encrypt(credentials), revision, id)
    else this.db.prepare('INSERT INTO python_tasks(id, config, credentials, revision) VALUES (?, ?, ?, 1)')
      .run(id, JSON.stringify(config), this.box.encrypt(credentials))
    this.log(id, 'system', old ? '参数已保存；下次启动使用此版本。' : '脚本配置已创建，尚未运行。')
    return this.view(id)
  }

  remove(id) {
    this.row(id)
    if (this.active.has(id)) throw new AppError(409, 'python_running', '请先停止脚本再删除配置')
    if (this.directory) {
      const target = resolve(this.directory, id)
      if (dirname(target) !== this.directory) throw new Error('任务目录异常')
      rmSync(target, { recursive: true, force: true })
    }
    this.db.prepare('DELETE FROM python_tasks WHERE id = ?').run(id)
  }

  reveal(id) { return this.effective(this.row(id)).credentials }

  log(id, stream, text, secrets = []) {
    for (const secret of secrets) if (secret) text = text.split(secret).join('[已隐藏]')
    text = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]')
      .replace(/[A-Za-z0-9_.~+\/-]{48,}/g, '[长标识或令牌已隐藏]')
      .replace(/\r/g, '').slice(0, 4000)
    if (!text.trim()) return
    this.db.prepare('INSERT INTO python_task_logs(task_id, at, stream, text) VALUES (?, ?, ?, ?)').run(id, this.now(), stream, text)
    this.boundLogs(id)
  }

  // Bounded in one statement: keep the newest N rows for this task only.
  boundLogs(id) {
    this.db.prepare(`DELETE FROM python_task_logs WHERE task_id = ? AND seq < (
      SELECT seq FROM python_task_logs WHERE task_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?
    )`).run(id, id, this.logLines - 1)
  }

  clearLogs(id) {
    this.row(id)
    const { changes } = this.db.prepare('DELETE FROM python_task_logs WHERE task_id = ?').run(id)
    this.removeLogFiles(id)
    return { removed: changes }
  }

  clearAllLogs() {
    const { changes } = this.db.prepare('DELETE FROM python_task_logs').run()
    this.removeLogFiles()
    return { removed: changes }
  }

  // Disk logs are written by the Python side and never truncated there, so the
  // platform enforces the cap whenever a run writes or the user clears logs.
  removeLogFiles(id) {
    if (!this.directory) return
    let directories
    if (id) {
      const target = resolve(this.directory, id)
      if (dirname(target) !== this.directory) throw new Error('任务目录异常')
      directories = [target]
    } else {
      try { directories = readdirSync(this.directory).map(name => join(this.directory, name)) } catch (error) {
        if (error.code === 'ENOENT') return
        throw error
      }
    }
    for (const directory of directories) {
      let entries
      try { entries = readdirSync(directory) } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue
        throw error
      }
      for (const name of entries) {
        if (!/^keepalive-[A-Za-z0-9_-]+(\.\d+)?\.log$/.test(name)) continue
        try { rmSync(join(directory, name), { force: true }) } catch { /* 清理失败不影响主流程 */ }
      }
    }
  }

  // Called on run start: an append-only file that grew past the cap is rotated.
  trimLogFile(path) {
    try {
      const { size } = statSync(path)
      if (size <= this.logFileBytes) return
      rmSync(`${path}.${Math.floor(this.now() / 1000)}`, { force: true })
      renameSync(path, `${path}.${Math.floor(this.now() / 1000)}`)
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('无法轮转日志文件', error.code || error.name)
    }
  }

  processLog(id, stream, text, redact = []) {
    try { this.log(id, stream, text, redact) } catch {
      // Process signals and cleanup must still run if log storage is unavailable.
    }
  }

  logs(id, after) {
    this.row(id)
    if (!Number.isSafeInteger(after) || after < 0) throw invalid('日志游标无效')
    const logs = this.db.prepare('SELECT seq, at, stream, text FROM python_task_logs WHERE task_id=? AND seq>? ORDER BY seq LIMIT 200').all(id, after)
    return { logs, nextAfter: logs.at(-1)?.seq ?? after }
  }

  // Concurrency is unlimited by default. Memory safety comes from the per-process
  // RSS watchdog, which stops only a run that is genuinely runaway instead of
  // refusing to start work the host could still handle.
  runAllowance() {
    if (Number.isFinite(this.maxRuns) && this.maxRuns > 0) return this.maxRuns
    const free = this.freeMemory()
    if (!Number.isFinite(free) || free < 0) return Number.POSITIVE_INFINITY
    return Math.max(1, Math.floor(free / this.memoryCeilingBytes))
  }

  start(id, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
        Object.keys(options).some(key => key !== 'durationSeconds')) throw invalid('启动参数无效')
    const durationSeconds = options.durationSeconds
    if (durationSeconds !== undefined && (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > maxDurationSeconds)) {
      throw invalid(`运行时限必须是 1 到 ${maxDurationSeconds} 秒的整数`)
    }
    if (this.closing) throw new AppError(409, 'python_closing', '平台正在停止')
    if (this.active.has(id)) throw new AppError(409, 'python_running', '此脚本已经在运行')
    const allowance = this.runAllowance()
    if (this.active.size >= allowance) {
      throw new AppError(429, 'python_busy', `可用内存只够再运行约 ${allowance} 份脚本，请先停止部分进程`)
    }
    if (!this.directory) throw invalid('实际运行脚本需要持久化数据目录')
    const row = this.row(id)
    const effective = this.effective(row)
    const { params } = effective
    let credentials = effective.credentials
    if (!params.CONV_ID || !params.UID || (!credentials.JWT && !credentials.RT)) {
      throw invalid('启动前请填写 CONV_ID、UID 以及 JWT 或 RT')
    }
    const directory = join(this.directory, id)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const runVersion = effective.account ? createHash('sha256').update(JSON.stringify({ params, credentials })).digest('hex').slice(0, 24) : row.revision
    const stateFile = join(directory, `state-${runVersion}.json`)
    const logFile = join(directory, `keepalive-${runVersion}.log`)
    if (params.LOG_TO_FILE) this.trimLogFile(logFile)
    if (params.STATE_ENABLE) {
      try {
        const raw = readFileSync(stateFile)
        if (raw.length < 65536) {
          const saved = JSON.parse(raw.toString('utf8'))
          if (typeof saved.JWT === 'string' && saved.JWT.length < 16385 && typeof saved.RT === 'string' && saved.RT.length < 16385) {
            credentials = { JWT: saved.JWT || credentials.JWT, RT: saved.RT || credentials.RT }
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') this.log(id, 'system', '未能读取上次令牌状态，将使用页面保存的凭据。')
      }
    }
    const env = {}
    for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']) {
      if (process.env[name]) env[name] = process.env[name]
    }
    const redact = [...Object.values(credentials), ...Object.values(this.box.decrypt(row.credentials))]
    this.db.prepare('UPDATE python_tasks SET last_started=?, last_stopped=NULL, exit_code=NULL, error=NULL WHERE id=?').run(this.now(), id)
    const child = spawn(this.python, ['-u', worker], { cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const job = { child, params: { ...params }, status: 'starting', runId: randomUUID(), durationSeconds, limitTimer: null, done: null, killTimer: null }
    this.active.set(id, job)
    this.processLog(id, 'system', '正在启动原 Python 脚本；每份配置独立运行。')
    for (const stream of ['stdout', 'stderr']) {
      const decoder = new StringDecoder('utf8')
      let buffer = ''
      let discard = false
      const accept = value => {
        buffer += value
        let end
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end)
          if (!discard && line.length <= 32768) this.processLog(id, stream, line, redact)
          else this.processLog(id, 'system', '一条过长的日志已省略。')
          buffer = buffer.slice(end + 1)
          discard = false
        }
        if (buffer.length > 32768) { buffer = ''; discard = true }
      }
      child[stream].on('data', data => accept(decoder.write(data)))
      child[stream].on('end', () => { accept(decoder.end()); if (buffer && !discard) this.processLog(id, stream, buffer, redact) })
    }
    let startupError = null
    child.once('spawn', () => {
      if (job.status === 'starting') job.status = 'running'
      else if (job.status === 'stopping') child.kill('SIGTERM')
      if (durationSeconds !== undefined && job.status === 'running') {
        job.limitTimer = setTimeout(() => {
          if (this.active.get(id) !== job || job.status !== 'running') return
          this.processLog(id, 'system', `运行时限 ${durationSeconds} 秒已到，正在停止此 Python 进程。`)
          void this.stop(id, job.runId).catch(() => this.processLog(id, 'system', '自动停止失败，请立即手动停止此进程。'))
        }, durationSeconds * 1000)
        job.limitTimer.unref?.()
      }
      this.processLog(id, 'system', `Python 进程已启动，PID ${child.pid}。`)
      this.onEvent?.('started', {
        title: `WorkBuddy「${effective.config.name}」已启动`,
        content: `PID ${child.pid}${durationSeconds === undefined ? '' : `，运行时限 ${durationSeconds} 秒`}`,
      })
    })
    child.once('error', () => { startupError = '无法启动 Python，请确认服务器已安装 python3。' })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ params, credentials, stateFile, logFile, parentPid: process.pid }))
    job.stopWatch = watchMemory(child.pid, this.memoryCeilingBytes, rss => {
      const mib = (rss / 1024 / 1024).toFixed(0)
      this.processLog(id, 'system', `进程占用内存 ${mib} MiB 持续超过上限，正在停止以保护宿主机。`)
      this.onEvent?.('failure', {
        title: `WorkBuddy「${effective.config.name}」因内存超限被停止`,
        content: `常驻内存 ${mib} MiB，超过上限 ${(this.memoryCeilingBytes / 1024 / 1024).toFixed(0)} MiB`,
      })
      void this.stop(id, job.runId).catch(() => {})
    })
    job.done = new Promise(resolve => child.once('close', (code, signal) => {
      clearTimeout(job.limitTimer)
      clearTimeout(job.killTimer)
      job.stopWatch?.()
      const error = startupError ?? (job.status !== 'stopping' && code !== 0 ? '脚本异常退出，请查看日志。' : null)
      this.active.delete(id)
      try {
        this.db.prepare('UPDATE python_tasks SET last_stopped=?, exit_code=?, error=? WHERE id=?').run(this.now(), code, error, id)
      } catch {
        console.error('无法保存 Python 进程退出状态；进程已结束。')
      } finally {
        this.processLog(id, 'system', `Python 进程已结束；${signal ? `信号 ${signal}` : `退出码 ${code}`}。`)
        this.onEvent?.(error ? 'failure' : 'stopped', {
          title: `WorkBuddy「${effective.config.name}」${error ? '异常退出' : '已停止'}`,
          content: `${signal ? `信号 ${signal}` : `退出码 ${code}`}${error ? `；${error}` : ''}`,
        })
        resolve()
      }
    }))
    return this.view(id)
  }

  async stop(id, runId) {
    this.row(id)
    if (runId !== undefined && (typeof runId !== 'string' || !/^[a-f0-9-]{36}$/.test(runId))) throw invalid('运行标识无效')
    const job = this.active.get(id)
    if (runId !== undefined && job?.runId !== runId) {
      throw new AppError(409, 'stale_python_run', '运行状态已变化；当前进程未受影响，请刷新后重试')
    }
    if (job && job.status !== 'stopping') {
      clearTimeout(job.limitTimer)
      job.stopWatch?.()
      job.status = 'stopping'
      job.killTimer = setTimeout(() => { if (this.active.get(id) === job) job.child.kill('SIGKILL') }, 5000)
      job.child.kill('SIGTERM')
      this.processLog(id, 'system', '正在停止此 Python 进程。')
    }
    if (job) await job.done
    return this.view(id)
  }

  async stopAll() {
    this.closing = true
    await Promise.all([...this.active.keys()].map(id => this.stop(id)))
  }
}
