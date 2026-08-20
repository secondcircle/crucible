import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'

// Component tests share one jsdom document, so an unmounted tree would leave
// the next test's queries finding two of everything. Node tests have none.
if (typeof document !== 'undefined') {
  const { cleanup } = await import('@testing-library/react')
  afterEach(cleanup)
}
