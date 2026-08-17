import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
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
    plugins: [react()]
  }
})
