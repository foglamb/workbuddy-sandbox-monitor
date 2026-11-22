import { randomUUID } from 'node:crypto'
import { AppError, invalid } from './errors.mjs'
import { pythonCommonKeys, pythonSchema, validatePythonInput } from './python-config.mjs'

export class PythonSharedSettings {
  constructor(db, box) { this.db = db; this.box = box }

  defaults() {
    const stored = this.db.prepare("SELECT value FROM python_preferences WHERE key='defaults'").get()
    return { ...Object.fromEntries(pythonSchema.filter(field => pythonCommonKeys.includes(field.key)).map(field => [field.key, field.default])),
      ...(stored ? JSON.parse(stored.value) : {}) }
  }

  saveDefaults(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 ||
        !input.params || typeof input.params !== 'object' || Array.isArray(input.params) ||
        Object.keys(input.params).some(key => !pythonCommonKeys.includes(key))) throw invalid('统一参数只接受通用运行设置')
    const checked = validatePythonInput({ name: 'defaults', params: { ...this.defaults(), ...input.params } }).params
    const result = Object.fromEntries(pythonCommonKeys.map(key => [key, checked[key]]))
    this.db.prepare("INSERT INTO python_preferences(key,value) VALUES ('defaults',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(result))
    return result
  }

  row(id) {
    const row = this.db.prepare('SELECT * FROM python_accounts WHERE id=?').get(id)
    if (!row) throw new AppError(404, 'missing_python_account', '共享账号不存在')
    return row
  }

  view(id) {
    const row = this.row(id)
    const account = JSON.parse(row.config)
    const secrets = this.box.decrypt(row.credentials)
    const inUse = this.db.prepare("SELECT count(*) AS count FROM python_tasks WHERE json_extract(config,'$.accountId')=?").get(id).count
    return { id, ...account, hasJWT: Boolean(secrets.JWT), hasRT: Boolean(secrets.RT), inUse }
  }

  list() { return this.db.prepare('SELECT id FROM python_accounts ORDER BY rowid').all().map(row => this.view(row.id)) }
  reveal(id) { return this.box.decrypt(this.row(id).credentials) }

  save(input, id, fromTask) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !['name', 'base', 'uid', 'credentials', 'sourceTaskId'].includes(key))) throw invalid('共享账号格式无效')
    if (!id && this.db.prepare('SELECT count(*) AS count FROM python_accounts').get().count >= 200) throw invalid('最多保存 200 个共享账号')
    const previous = id ? this.row(id) : null
    const oldConfig = previous ? JSON.parse(previous.config) : null
    let base = input.base ?? oldConfig?.base ?? 'https://copilot.tencent.com'
    let uid = input.uid ?? oldConfig?.uid
    let patch = input.credentials
    if (input.sourceTaskId !== undefined) {
      if (id || typeof input.sourceTaskId !== 'string' || input.base !== undefined || input.uid !== undefined || input.credentials !== undefined) throw invalid('提取账号时只填写名称和原配置')
      const source = fromTask(input.sourceTaskId)
      base = source.params.BASE
      uid = source.params.UID
      patch = Object.fromEntries(Object.entries(source.credentials).map(([key, value]) => [key, value || null]))
    }
    if (typeof uid !== 'string' || !uid.trim()) throw invalid('共享账号必须填写 UID')
    const checked = validatePythonInput({ name: input.name, params: { BASE: base, UID: uid }, credentials: patch })
    const credentials = previous ? this.box.decrypt(previous.credentials) : { JWT: '', RT: '' }
    for (const key of ['JWT', 'RT']) {
      if (Object.hasOwn(checked.credentials, key)) credentials[key] = checked.credentials[key] === null ? '' : checked.credentials[key].trim()
    }
    const config = { name: checked.name, base: checked.params.BASE, uid: checked.params.UID }
    id ??= randomUUID()
    if (previous) this.db.prepare('UPDATE python_accounts SET config=?, credentials=? WHERE id=?').run(JSON.stringify(config), this.box.encrypt(credentials), id)
    else this.db.prepare('INSERT INTO python_accounts(id,config,credentials) VALUES (?,?,?)').run(id, JSON.stringify(config), this.box.encrypt(credentials))
    return this.view(id)
  }

  remove(id) {
    if (this.view(id).inUse) throw new AppError(409, 'python_account_in_use', '仍有沙盒使用此账号，请先切换这些配置的账号')
    this.db.prepare('DELETE FROM python_accounts WHERE id=?').run(id)
  }
}
