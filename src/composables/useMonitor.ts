import { computed, onMounted, onScopeDispose, readonly, shallowRef } from 'vue'
import { ApiError, errorMessage, makeApi, type Workspace } from '../api'
import { clearSession, loadSession, saveSession } from '../session-store'

export function useMonitor() {
  const restored = loadSession()
  const token = shallowRef(restored.password)
  const remember = shallowRef(restored.remember)
  const api = makeApi(() => token.value)
  const workspace = shallowRef<Workspace | null>(null)
  const locked = shallowRef(false)
  const loading = shallowRef(false)
  const error = shallowRef('')
  const authenticated = computed(() => Boolean(token.value) && !locked.value)
  let request: AbortController | null = null
  let poll: ReturnType<typeof setInterval> | undefined

  function signOut() {
    request?.abort()
    request = null
    token.value = ''
    clearSession()
    workspace.value = null
    loading.value = false
    locked.value = true
    error.value = ''
  }

  async function refresh() {
    request?.abort()
    const current = new AbortController()
    request = current
    loading.value = true
    try {
      const result = await api.list(current.signal)
      if (current.signal.aborted) return false
      workspace.value = result
      locked.value = false
      error.value = ''
      // Only a credential the server accepted is worth persisting.
      if (token.value) saveSession(token.value, remember.value)
      return true
    } catch (cause) {
      if (current.signal.aborted) return false
      if (cause instanceof ApiError && cause.status === 401) {
        const attempted = Boolean(token.value)
        signOut()
        if (attempted) error.value = errorMessage(cause)
      } else {
        error.value = errorMessage(cause)
      }
      return false
    } finally {
      if (request === current) {
        loading.value = false
        request = null
      }
    }
  }

  function signIn(value: string, keep = remember.value) {
    token.value = value.trim()
    remember.value = keep
    return refresh()
  }

  onMounted(() => {
    void refresh()
    poll = setInterval(() => {
      if (!document.hidden && !locked.value && !loading.value) void refresh()
    }, 5000)
  })
  onScopeDispose(() => {
    request?.abort()
    clearInterval(poll)
  })
  return { workspace: readonly(workspace), locked: readonly(locked), loading: readonly(loading),
    error: readonly(error), authenticated, remember: readonly(remember), api, refresh, signIn, signOut }
}
