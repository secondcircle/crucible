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
    plugins: [react()],
    // `npm run dev` hands this checkout its own dev-server port
    // (scripts/renderer-port.sh) and we pin it. electron-vite loads the window
    // from the port it was configured with rather than the one vite fell back
    // to, so on a busy 5173 a second checkout's window quietly shows the first
    // checkout's renderer. Pinned, a collision fails the launch instead.
    server:
      process.env.CRUCIBLE_RENDERER_PORT === undefined
        ? {}
        : { port: Number(process.env.CRUCIBLE_RENDERER_PORT), strictPort: true }
  }
})
