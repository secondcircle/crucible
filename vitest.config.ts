import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    // D10: component tests in jsdom. A main-process unit test opts out per file
    // with `// @vitest-environment node`.
    environment: 'jsdom',
    // The five-second default measures how saturated the machine is, not
    // whether a file is right: the suite spawns real processes — a workflow
    // host per case in the host, loader and schedule-source suites, each a
    // Node start plus a TypeScript transform — on top of one worker per
    // core. A test that genuinely hangs still fails, thirty seconds later,
    // and a hook twenty.
    testTimeout: 30_000,
    hookTimeout: 20_000,
    setupFiles: ['./vitest.setup.ts'],
    // scripts/ is in because the publish workflow's version choice decides
    // what every installed Crucible updates to, and nothing else would catch
    // it breaking.
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts']
  }
})
