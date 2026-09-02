import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    // D10: component tests in jsdom. A main-process unit test opts out per file
    // with `// @vitest-environment node`.
    environment: 'jsdom',
    // Vitest's default is five seconds, which on a saturated machine measures
    // how many other files are running rather than whether this one is right:
    // the suite spawns real processes and loads π's own skill reader, and
    // those tests were failing on wall clock alone. A test that genuinely
    // hangs still fails, twenty seconds later.
    testTimeout: 20_000,
    setupFiles: ['./vitest.setup.ts'],
    // scripts/ is in because the publish workflow's version choice decides
    // what every installed Crucible updates to, and nothing else would catch
    // it breaking.
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts']
  }
})
