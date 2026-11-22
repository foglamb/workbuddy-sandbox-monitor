import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const N = 2 ** 15
const KEY_LENGTH = 32
const MAX_MEMORY = 64 * 1024 * 1024
// Minimum 8 characters, as requested. Short values are accepted but
// reported as weak so the console can warn without blocking.
export const passwordPattern = /^[A-Za-z0-9_-]{8,128}$/
export const strongPasswordPattern = /^[A-Za-z0-9_-]{16,128}$/

// A successful match is memoised by SHA-256 of the submitted value so that
// routine polling does not pay ~80 ms of scrypt per request. Failures are never
// cached, so guessing still costs a full derivation each time.
const verified = new Map()
const verifiedLimit = 8

const fingerprint = (password, stored) =>
  createHash('sha256').update(`${stored.salt}:${stored.hash}:${password}`).digest('hex')

function remember(key) {
  verified.delete(key)
  verified.set(key, true)
  while (verified.size > verifiedLimit) verified.delete(verified.keys().next().value)
}

function derive(password, salt, cost, length) {
  return scryptSync(password, salt, length, { N: cost, r: 8, p: 1, maxmem: MAX_MEMORY })
}

export function hashPassword(password) {
  const salt = randomBytes(16)
  return {
    salt: salt.toString('base64'),
    hash: derive(password, salt, N, KEY_LENGTH).toString('base64'),
    cost: N,
  }
}

// Returns false for malformed records instead of throwing, so a corrupt row
// cannot be mistaken for a successful match.
export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || !stored) return false
  let expected
  try {
    expected = Buffer.from(stored.hash, 'base64')
  } catch {
    return false
  }
  if (expected.length !== KEY_LENGTH) return false
  const key = fingerprint(password, stored)
  if (verified.has(key)) return true
  try {
    const actual = derive(password, Buffer.from(stored.salt, 'base64'), Number(stored.cost), expected.length)
    if (!timingSafeEqual(actual, expected)) return false
    remember(key)
    return true
  } catch {
    return false
  }
}
