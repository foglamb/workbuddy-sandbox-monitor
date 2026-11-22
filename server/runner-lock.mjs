import { mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AppError } from './errors.mjs'

export function acquireRunnerLock(dataFile) {
  if (dataFile === ':memory:') return () => {}
  mkdirSync(dirname(dataFile), { recursive: true, mode: 0o700 })
  let target = join(realpathSync(dirname(dataFile)), basename(dataFile))
  try {
    target = realpathSync(target)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  // Keep the advisory lock in a separate database so it does not block data writes.
  const db = new DatabaseSync(`${target}.runner.sqlite`)
  try {
    db.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;')
  } catch (error) {
    db.close()
    const sqliteCode = (error.errcode ?? 0) & 0xff
    if (sqliteCode === 5 || sqliteCode === 6) {
      throw new AppError(409, 'runner_locked', '此数据目录已有保活平台运行，请先停止旧进程或改用不同的 WB_DATA_DIR')
    }
    throw error
  }

  // Closing or killing the process rolls back the transaction and releases the OS lock.
  let released = false
  return () => {
    if (released) return
    released = true
    db.close()
  }
}
