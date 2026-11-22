import { onMounted, onScopeDispose, readonly, shallowRef, watch } from 'vue'
import { errorMessage } from '../api'
import type { PythonActions, PythonLog } from '../python-model'

/** Poll only the currently selected task; never retain an in-flight request after selection changes. */
export function usePythonLogs(taskId: () => string, enabled: () => boolean, readLogs: PythonActions['logs']) {
  const logs = shallowRef<readonly PythonLog[]>([])
  const loading = shallowRef(false)
  const error = shallowRef('')
  let cursor = 0
  let mounted = false
  let generation = 0
  let request: AbortController | null = null
  let timer: ReturnType<typeof setInterval> | undefined

  function cancel() {
    generation++
    request?.abort()
    request = null
    clearInterval(timer)
    timer = undefined
    loading.value = false
  }

  async function poll() {
    const id = taskId()
    if (!mounted || !enabled() || !id || request) return
    const current = new AbortController()
    const version = generation
    request = current
    loading.value = true
    try {
      const result = await readLogs(id, cursor, current.signal)
      if (current.signal.aborted || version !== generation || taskId() !== id) return
      const existing = logs.value
      const lastSeq = existing[existing.length - 1]?.seq ?? 0
      logs.value = [...existing, ...result.logs.filter(line => line.seq > lastSeq)].slice(-200)
      cursor = result.nextAfter
      error.value = ''
    } catch (cause) {
      if (!current.signal.aborted && version === generation) error.value = errorMessage(cause)
    } finally {
      if (request === current) {
        request = null
        loading.value = false
      }
    }
  }

  function restart() {
    cancel()
    logs.value = []
    cursor = 0
    error.value = ''
    if (!mounted || !enabled() || !taskId()) return
    void poll()
    timer = setInterval(() => { void poll() }, 1000)
  }

  watch([taskId, enabled], restart)
  onMounted(() => {
    mounted = true
    restart()
  })
  onScopeDispose(() => {
    mounted = false
    cancel()
    logs.value = []
  })

  return { logs: readonly(logs), loading: readonly(loading), error: readonly(error), restart }
}
