import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'

// Component tests share one jsdom document, so each test's tree is unmounted
// when it ends — otherwise the next test's queries find two of everything.
// Main-process tests run in the node environment, have no document, and skip
// this entirely rather than loading React to find that out.
if (typeof document !== 'undefined') {
  const { cleanup } = await import('@testing-library/react')
  afterEach(cleanup)
}
