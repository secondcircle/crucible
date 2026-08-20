import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    // D10: component tests in jsdom. A main-process unit test opts out per file
    // with `// @vitest-environment node`.
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    // scripts/ is in because the git hooks decide when the human's installed
    // app is rebuilt, and nothing else would catch them breaking.
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts']
  }
})
