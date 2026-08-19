import { join } from 'node:path'
import { BrowserWindow, shell as osShell } from 'electron'

/**
 * The sole `BrowserWindow` of the app.
 *
 * Four facts about it are load-bearing and are the reason this lives in one
 * place:
 *
 * - The renderer is sandboxed — `sandbox`, `contextIsolation`, no
 *   `nodeIntegration` — with a preload bundled to a single file so it loads
 *   under the sandbox.
 * - Ember owns the window from the first frame (WIN-1). The window's own
 *   background color is the Ember background, the document's is the same, and
 *   the window is not shown until it is ready to paint, so a launch never
 *   flashes white.
 * - The standard OS title bar stays (WIN-2). A custom drag region is later
 *   shell work; a frameless window without one is a window you cannot move.
 * - The app window never navigates (WIN-4). Every navigation the renderer could
 *   start is denied, and every new-window open is denied too; an activated
 *   `http(s)` link is handed to the OS browser instead. That is what makes
 *   rendering a link in a markdown reply safe: the link works, and it can never
 *   replace the app with a web page.
 *
 * In dev the renderer is loaded from electron-vite's dev URL, which is what
 * makes an edit to the React tree hot-reload in the running window.
 */

/** Ember's background, from mock A. The one place main names a color. */
const EMBER_BACKGROUND = '#191419'

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    show: false,
    title: 'Crucible',
    backgroundColor: EMBER_BACKGROUND,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  window.on('ready-to-show', () => window.show())

  // A link, a form, anything: the window stays on the app. An external address
  // goes to the OS browser, everything else goes nowhere.
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    openExternally(url)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    // dev: vite serves the renderer, so edits hot-reload
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

/** Only `http` and `https`, so nothing hands the OS a `file:` or a `pi:` URL. */
function openExternally(url: string): void {
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    return
  }
  if (protocol !== 'http:' && protocol !== 'https:') return
  void osShell.openExternal(url)
}
