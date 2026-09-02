import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // Two entries out of one build: the app's main process, and the
        // desktop installer npm runs after an install. They share the
        // assembler, so both get the same answer to where an app goes.
        input: {
          index: 'src/main/index.ts',
          postinstall: 'src/main/install/postinstall.ts'
        }
      }
    }
  },
  preload: {
    // D2/A5: no `externalizeDepsPlugin` here on purpose. A sandboxed preload
    // must be a single bundled file, so the preload build keeps its
    // dependencies inlined (electron itself stays external either way).
    build: {
      rollupOptions: {
        output: { format: 'cjs' }
      }
    }
  },
  renderer: {
    plugins: [react()],
    // Pinned to the per-checkout port dev launches hand in: electron-vite
    // loads the window from the configured port, not the one vite falls back
    // to on a busy one, so an unpinned collision would quietly show another
    // checkout's renderer. Pinned, it fails the launch instead.
    server:
      process.env.CRUCIBLE_RENDERER_PORT === undefined
        ? {}
        : { port: Number(process.env.CRUCIBLE_RENDERER_PORT), strictPort: true }
  }
})
