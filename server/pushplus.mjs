import { AppError, invalid } from './errors.mjs'

const endpoint = 'https://www.pushplus.plus/send'
const maxReply = 64 * 1024
const events = ['started', 'stopped', 'failure']
const prefKey = 'pushplus'
const tokenKey = 'pushplus_token'

function text(value, max, label) {
  if (typeof value !== 'string' || value.trim().length > max) throw invalid(`${label}长度不得超过 ${max} 字符`)
  return value.trim()
}

export class PushPlusService {
  constructor(db, box, { fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 8000 } = {}) {
    this.db = db
    this.box = box
    this.fetch = fetchImpl
    this.now = now
    this.timeoutMs = timeoutMs
  }

  stored() {
    const row = this.db.prepare('SELECT value FROM python_preferences WHERE key=?').get(prefKey)
    const parsed = row ? JSON.parse(row.value) : {}
    return { enabled: parsed.enabled === true, topic: typeof parsed.topic === 'string' ? parsed.topic : '',
      events: Array.isArray(parsed.events) ? parsed.events.filter(name => events.includes(name)) : [] }
  }

  token() {
    const row = this.db.prepare('SELECT value FROM python_preferences WHERE key=?').get(tokenKey)
    if (!row) return ''
    try { return this.box.decrypt(row.value) } catch { return '' }
  }

  view() {
    const stored = this.stored()
    return { enabled: stored.enabled, hasToken: Boolean(this.token()), topic: stored.topic, events: stored.events }
  }

  // Token is three-state: omitted keeps the saved value, empty clears it, a string replaces it.
  save(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('推送配置格式无效')
    if (Object.keys(input).some(key => !['enabled', 'token', 'topic', 'events'].includes(key))) throw invalid('推送配置含有未知字段')
    const previous = this.stored()
    const enabled = input.enabled === undefined ? previous.enabled : input.enabled
    if (typeof enabled !== 'boolean') throw invalid('启用状态须为布尔值')
    const topic = input.topic === undefined ? previous.topic : text(input.topic, 100, '群组编码')
    const checkedEvents = input.events === undefined ? previous.events : input.events
    if (!Array.isArray(checkedEvents) || checkedEvents.some(name => !events.includes(name))) throw invalid('通知事件无效')
    const token = input.token === undefined ? this.token()
      : input.token === null ? '' : text(input.token, 200, 'PushPlus Token')
    if (/^[A-Za-z0-9]{1,200}$/.test(token) === false && token) throw invalid('PushPlus Token 只接受字母和数字')
    if (enabled && !token) throw invalid('启用推送前请先填写 PushPlus Token')
    const db = this.db
    const save = (key, value) => db.prepare(`INSERT INTO python_preferences(key,value) VALUES (?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value)
    save(prefKey, JSON.stringify({ enabled, topic, events: [...new Set(checkedEvents)] }))
    if (token) save(tokenKey, this.box.encrypt(token))
    else db.prepare('DELETE FROM python_preferences WHERE key=?').run(tokenKey)
    return this.view()
  }

  async deliver(title, content) {
    const stored = this.stored()
    const token = this.token()
    if (!stored.enabled || !token) return { ok: false, skipped: true }
    let response
    try {
      response = await this.fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, title, content, template: 'txt', ...(stored.topic ? { topic: stored.topic } : {}) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch { return { ok: false, reason: 'network' } }
    let body = ''
    try {
      const text = await response.text()
      body = text.slice(0, maxReply)
    } catch { return { ok: false, reason: 'read' } }
    let parsed = null
    try { parsed = JSON.parse(body) } catch { /* keep null */ }
    const code = parsed && typeof parsed.code === 'number' ? parsed.code : null
    return { ok: Boolean(response.ok && code === 200), httpStatus: response.status, code }
  }

  async notify(event, title, content) {
    if (!events.includes(event)) return { ok: false, skipped: true }
    if (!this.stored().events.includes(event)) return { ok: false, skipped: true }
    return this.deliver(title, content)
  }

  async test() {
    if (!this.token()) throw new AppError(400, 'pushplus_token_missing', '请先填写 PushPlus Token 再发送测试')
    const result = await this.deliver('WorkBuddy 推送测试', `推送通道测试成功。时间 ${new Date(this.now()).toISOString()}`)
    if (!result.ok) throw new AppError(502, 'pushplus_failed', '测试消息未送达 PushPlus，请核对 Token 与网络')
    return result
  }
}
