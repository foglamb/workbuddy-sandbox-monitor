import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function createSecretBox(dataFile, hasStoredTasks) {
  let key
  if (dataFile === ':memory:') key = randomBytes(32)
  else {
    mkdirSync(dirname(dataFile), { recursive: true, mode: 0o700 })
    const path = `${dataFile}.python-key`
    if (!existsSync(path)) {
      if (hasStoredTasks) throw new Error('脚本凭据加密密钥缺失，请恢复数据目录的 .python-key 文件')
      try { writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 }) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    key = readFileSync(path)
    if (key.length !== 32) throw new Error('脚本凭据加密密钥长度无效')
  }
  return {
    encrypt(value) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const bytes = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64')
    },
    decrypt(value) {
      const bytes = Buffer.from(value, 'base64')
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      decipher.setAuthTag(bytes.subarray(12, 28))
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'))
    },
  }
}
