// Session storage for the admin password.
//
// Two modes, chosen by the "记住此设备" checkbox on the login screen:
//
//   session  — sessionStorage. Survives a page refresh and in-tab navigation,
//              and is dropped when the tab closes. This is the default because
//              a refresh should not demand the password again, but nothing
//              should linger on disk indefinitely.
//   device   — localStorage. Survives browser restarts until 退出 is pressed.
//              Opt-in only, for an operator on a dedicated machine.
//
// The mode is recorded alongside the value so a page load knows where to look.
// Every access is wrapped: storage throws in private-mode Safari, when the
// origin is opaque, and when the quota is exhausted. Losing the cached value
// only costs one login, so failures must never surface to the caller.

const valueKey = 'workbuddy.admin.password'
const modeKey = 'workbuddy.admin.mode'

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null

function read(store: Store, key: string): string {
  try {
    return store?.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function write(store: Store, key: string, value: string): void {
  try {
    if (value) store?.setItem(key, value)
    else store?.removeItem(key)
  } catch {
    // A full or blocked store only costs the convenience, never a crash.
  }
}

function session(): Store {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

function device(): Store {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** Saved password and where it came from, or an empty value in session mode. */
export function loadSession(): { password: string; remember: boolean } {
  const remembered = read(device(), valueKey)
  if (remembered) return { password: remembered, remember: true }
  return { password: read(session(), valueKey), remember: false }
}

/** Persist the password in the requested mode and clear the other one. */
export function saveSession(password: string, remember: boolean): void {
  if (!password) return clearSession()
  if (remember) {
    write(device(), valueKey, password)
    write(device(), modeKey, 'device')
    write(session(), valueKey, '')
  } else {
    write(session(), valueKey, password)
    write(device(), valueKey, '')
    write(device(), modeKey, '')
  }
}

export function clearSession(): void {
  write(session(), valueKey, '')
  write(device(), valueKey, '')
  write(device(), modeKey, '')
}
