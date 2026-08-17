import { join } from 'node:path'
import { BrowserWindow } from 'electron'

/**
 * The sole `BrowserWindow` of the app (D2).
 *
 * Two facts about it are load-bearing and are the reason this lives in one
 * place: the renderer is sandboxed — `sandbox`, `contextIsolation`, no
 * `nodeIntegration`, with a preload bundled to a single file so it loads under
 * the sandbox — and in dev the renderer is loaded from electron-vite's dev URL,
 * which is what makes an edit to the React tree hot-reload in the running
 * window.
 */
export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1024,
    height: 768,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  window.on('ready-to-show', () => window.show())

  if (process.env.ELECTRON_RENDERER_URL) {
    // dev: vite serves the renderer, so edits hot-reload
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}
