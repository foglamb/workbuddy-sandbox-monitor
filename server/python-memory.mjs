import { readFileSync } from 'node:fs'

// Resident-memory watchdog for Python worker processes.
//
// A hard RLIMIT_AS ceiling was tried first and rejected on evidence: the script's
// virtual address space legitimately swings between ~30 MiB and ~250 MiB because
// glibc reserves 8 MiB of address space per thread and TLS buffers are allocated
// on demand. Capping that number randomly aborted healthy runs (reproduced: 3 of
// 8 test-suite runs failed with MemoryError). Resident set size is the value that
// actually pressures the host, so the guard watches RSS instead.
//
// A run is stopped only after several consecutive samples stay above the ceiling,
// which a healthy keepalive never does: measured RSS is ~21-24 MiB.

const kibibyte = 1024
export const sampleIntervalMs = 10_000
export const breachSamples = 3

/** Resident set size of a process in bytes, or null when unavailable. */
export function readRss(pid) {
  if (!pid) return null
  try {
    const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))
    return match ? Number(match[1]) * kibibyte : null
  } catch {
    return null
  }
}

/**
 * Watch one process. `onBreach` fires once, after the ceiling has been exceeded
 * for `breachSamples` consecutive samples. Returns a stop function.
 *
 * The timer is unref'd so a watchdog never keeps the process alive on its own,
 * and sampling stops as soon as the process is gone.
 */
export function watchMemory(pid, ceilingBytes, onBreach, { read = readRss, intervalMs = sampleIntervalMs } = {}) {
  if (!pid || !Number.isFinite(ceilingBytes) || ceilingBytes <= 0) return () => {}
  let breaches = 0
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    clearInterval(timer)
  }
  const timer = setInterval(() => {
    if (finished) return
    const rss = read(pid)
    if (rss === null) return finish()
    if (rss <= ceilingBytes) {
      breaches = 0
      return
    }
    breaches += 1
    if (breaches < breachSamples) return
    finish()
    try { onBreach(rss) } catch { /* the caller logs; never throw from a timer */ }
  }, intervalMs)
  timer.unref?.()
  return finish
}
