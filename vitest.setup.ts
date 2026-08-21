import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'

// Component tests share one jsdom document, so an unmounted tree would leave
// the next test's queries finding two of everything. Node tests have none.
if (typeof document !== 'undefined') {
  const { cleanup } = await import('@testing-library/react')
  afterEach(cleanup)
  installStorage()
  // A document's storage outlives a component but not a test: what one test
  // remembered must not be what the next one starts from.
  afterEach(() => window.localStorage.clear())
}

// Node 25 has a `localStorage` global of its own that stores nothing without
// `--localstorage-file`, and the jsdom environment carries it onto the window
// over the one jsdom provides. Tests of anything the renderer remembers would
// silently prove nothing, so the document gets a working store back.
function installStorage(): void {
  if (typeof window.localStorage?.setItem === 'function') return
  const held = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return held.size
    },
    key: (at) => [...held.keys()][at] ?? null,
    getItem: (name) => held.get(name) ?? null,
    setItem: (name, value) => {
      held.set(name, String(value))
    },
    removeItem: (name) => {
      held.delete(name)
    },
    clear: () => held.clear()
  }
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage })
}
