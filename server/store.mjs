import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DEFAULTS, MAX_SANDBOXES } from './config.mjs'
import { AppError } from './errors.mjs'

function checkView(row) {
  if (!row) return null
  return {
    id: row.id, at: row.at, trigger: row.trigger, ok: row.code === 'ok',
    code: row.code, statusCode: row.status_code, durationMs: row.duration_ms,
  }
}

export class Store {
  constructor(file, historyLimit) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(file)
    this.historyLimit = historyLimit
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS sandboxes (
        id TEXT PRIMARY KEY,
        config TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sandboxes_next_at ON sandboxes(next_at);
      CREATE TABLE IF NOT EXISTS checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        at INTEGER NOT NULL,
        trigger TEXT NOT NULL,
        code TEXT NOT NULL,
        status_code INTEGER,
        duration_ms INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS checks_sandbox_id ON checks(sandbox_id, id DESC);
      CREATE INDEX IF NOT EXISTS checks_generation ON checks(sandbox_id, generation, id DESC);
      CREATE TABLE IF NOT EXISTS admin_password (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        alg TEXT NOT NULL,
        salt TEXT NOT NULL,
        hash TEXT NOT NULL,
        cost INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `)
  }

  adminPassword() {
    const row = this.db.prepare('SELECT salt, hash, cost FROM admin_password WHERE id = 1').get()
    return row ? { salt: row.salt, hash: row.hash, cost: row.cost } : null
  }

  saveAdminPassword(record, at) {
    this.db.prepare(`INSERT INTO admin_password (id, alg, salt, hash, cost, updated_at)
      VALUES (1, 'scrypt', ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET salt=excluded.salt, hash=excluded.hash, cost=excluded.cost, updated_at=excluded.updated_at`)
      .run(record.salt, record.hash, record.cost, at)
  }

  row(id) {
    const row = this.db.prepare('SELECT * FROM sandboxes WHERE id = ?').get(id)
    if (!row) throw new AppError(404, 'missing_sandbox', '找不到该沙盒配置')
    return row
  }

  snapshot(row, isRunning = () => false) {
    const config = { ...DEFAULTS, ...JSON.parse(row.config) }
    const last = this.db.prepare(`
      SELECT * FROM checks WHERE sandbox_id = ? AND generation = ? ORDER BY id DESC LIMIT 1
    `).get(row.id, row.generation)
    let status = 'pending'
    if (!config.enabled) status = 'paused'
    else if (last?.code === 'ok') status = 'up'
    else if (last) status = row.failures >= config.failureThreshold ? 'down' : 'degraded'
    return {
      id: row.id, config, status, failures: row.failures, lastCheck: checkView(last),
      nextCheckAt: row.next_at, running: isRunning(row.id),
    }
  }

  list(isRunning) {
    return this.db.prepare('SELECT * FROM sandboxes ORDER BY created_at, rowid').all()
      .map(row => this.snapshot(row, isRunning))
  }

  createMany(configs, now) {
    const ids = configs.map(() => randomUUID())
    this.transaction(() => {
      const { count } = this.db.prepare('SELECT count(*) AS count FROM sandboxes').get()
      if (count + configs.length > MAX_SANDBOXES) {
        throw new AppError(409, 'sandbox_limit', `最多可保存 ${MAX_SANDBOXES} 个沙盒配置`)
      }
      const add = this.db.prepare(`
        INSERT INTO sandboxes (id, config, next_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      `)
      configs.forEach((config, index) => {
        add.run(ids[index], JSON.stringify(config), config.enabled ? now : null, now, now)
      })
    })
    return ids.map(id => this.snapshot(this.row(id)))
  }

  update(id, config, now) {
    const row = this.row(id)
    const previous = JSON.parse(row.config)
    const targetChanged = ['url', 'method', 'successMin', 'successMax', 'timeoutSec', 'expectedText']
      .some(key => (previous[key] ?? DEFAULTS[key]) !== (config[key] ?? DEFAULTS[key]))
    let next = row.next_at
    if (!config.enabled) next = null
    else if (!previous.enabled || targetChanged) next = now
    else if (previous.intervalSec !== config.intervalSec) {
      const check = this.snapshot(row).lastCheck
      next = check ? Math.max(now, check.at + config.intervalSec * 1000) : now
    }
    this.db.prepare(`
      UPDATE sandboxes SET config = ?, next_at = ?, generation = ?, failures = ?, updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(config), next, row.generation + Number(targetChanged),
      targetChanged ? 0 : row.failures, now, id)
    return this.snapshot(this.row(id))
  }

  delete(id) {
    const { changes } = this.db.prepare('DELETE FROM sandboxes WHERE id = ?').run(id)
    if (!changes) throw new AppError(404, 'missing_sandbox', '找不到该沙盒配置')
  }

  due(now) {
    return this.db.prepare('SELECT id FROM sandboxes WHERE next_at <= ? ORDER BY next_at, rowid').all(now)
  }

  // 不再按 generation 过滤：改了地址或成功条件后，之前的记录仍然要能看到，
  // 否则"这个站到底什么时候开始坏的"就查不到了。用 latest 标出代次，
  // 前端可以把变更点画出来。
  history(id, limit, before = null) {
    const { generation } = this.row(id)
    const rows = before === null
      ? this.db.prepare('SELECT * FROM checks WHERE sandbox_id = ? ORDER BY id DESC LIMIT ?').all(id, limit)
      : this.db.prepare('SELECT * FROM checks WHERE sandbox_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(id, before, limit)
    return rows.map(row => ({ ...checkView(row), latest: row.generation === generation }))
  }

  // 供前端判断"这一条是不是旧配置下的记录"，以及画变更分界线。
  generationOf(id) {
    return this.row(id).generation
  }

  // 汇总：可用率、耗时分布、失败原因分布。全部从原始记录算出，
  // 不做采样，保证结论可以用明细逐条核对。
  stats(id, since = null) {
    const where = since === null ? 'sandbox_id = ?' : 'sandbox_id = ? AND at >= ?'
    const args = since === null ? [id] : [id, since]
    const row = this.db.prepare(`
      SELECT count(*) AS total,
             sum(CASE WHEN code = 'ok' THEN 1 ELSE 0 END) AS ok,
             min(at) AS firstAt, max(at) AS lastAt,
             min(duration_ms) AS minMs, max(duration_ms) AS maxMs,
             avg(duration_ms) AS avgMs,
             sum(duration_ms) AS totalMs
      FROM checks WHERE ${where}
    `).get(...args)
    const byCode = this.db.prepare(`
      SELECT code, count(*) AS count FROM checks WHERE ${where} GROUP BY code ORDER BY count DESC
    `).all(...args)
    const total = row.total ?? 0
    return {
      total,
      ok: row.ok ?? 0,
      failed: total - (row.ok ?? 0),
      availability: total ? (row.ok ?? 0) / total : null,
      firstAt: row.firstAt ?? null,
      lastAt: row.lastAt ?? null,
      durationMs: total
        ? { min: row.minMs, max: row.maxMs, avg: Math.round(row.avgMs), total: row.totalMs }
        : null,
      byCode,
    }
  }

  record(id, generation, result, now, trigger) {
    const row = this.row(id)
    if (row.generation !== generation) throw new AppError(409, 'cancelled', '配置已更新，请重新检查')
    const config = JSON.parse(row.config)
    const failures = result.ok ? 0 : Math.min(10_000, row.failures + 1)
    let next = row.next_at
    if (config.enabled && (trigger === 'scheduled' || next <= now)) next = now + config.intervalSec * 1000
    const runId = this.transaction(() => {
      const { lastInsertRowid } = this.db.prepare(`
        INSERT INTO checks (sandbox_id, generation, at, trigger, code, status_code, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, generation, now, trigger, result.code, result.statusCode, result.durationMs)
      this.db.prepare('UPDATE sandboxes SET failures = ?, next_at = ? WHERE id = ?').run(failures, next, id)
      // historyLimit 为 0 表示永久保留：不做任何删除。
      if (this.historyLimit > 0) {
        this.db.prepare(`
          DELETE FROM checks WHERE sandbox_id = ? AND id < (
            SELECT id FROM checks WHERE sandbox_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?
          )
        `).run(id, id, this.historyLimit - 1)
      }
      return lastInsertRowid
    })
    return { ...result, id: Number(runId), at: now, trigger }
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  close() { this.db.close() }
}
