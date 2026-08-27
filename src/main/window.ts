import { join } from 'node:path'
import { BrowserWindow, shell as osShell } from 'electron'

// The window is not shown until it can paint, and its background matches the
// document's, so a launch never flashes white.

/** The one place main names a color. */
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
      nodeIntegration: false,
      // Exhibits render in <webview> guests: full browser fidelity, in a
      // webContents of its own with no preload and no node, so a page can do
      // everything a browser tab can and reach nothing of the app.
      webviewTag: true
    }
  })

  // An exhibit guest browses freely — links navigate in place, like a browser
  // — but a window it tries to open (target=_blank, window.open) goes to the
  // OS browser: the app spawns no windows it does not own.
  window.webContents.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      openExternally(url)
      return { action: 'deny' }
    })
  })

  window.on('ready-to-show', () => window.show())

  // Denied outright, so no link an agent writes can replace the app with a web
  // page; an external address is handed to the OS browser instead.
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

// Only `http` and `https`, so nothing hands the OS a `file:` or a `pi:` URL.
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
