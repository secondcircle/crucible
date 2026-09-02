import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach } from 'vitest'

// Component tests share one jsdom document, so an unmounted tree would leave
// the next test's queries finding two of everything. Node tests have none.
if (typeof document !== 'undefined') {
  const { cleanup } = await import('@testing-library/react')
  const { runningOn } = await import('./src/renderer/src/keys')
  afterEach(cleanup)
  // A jsdom document is on no OS at all, so every component test is told which
  // one it is pretending to be. Mac unless the test says otherwise: that is
  // where the chords and the glyphs were written. A test about another
  // platform declares it and this resets it afterwards.
  beforeEach(() => runningOn('darwin'))
  installStorage()
  // A document's storage outlives a component but not a test: what one test
  // remembered must not be what the next one starts from.
  afterEach(() => window.localStorage.clear())
}

// Node 25's own `localStorage` global stores nothing without
// `--localstorage-file` and shadows the working one jsdom provides, so tests
// of anything the renderer remembers would silently prove nothing.
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
