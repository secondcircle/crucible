import { join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { type AgentChannel, serveAgentChannel } from './agent/channel'
import { selectAdapter } from './agent/select-adapter'
import { withLogging } from './agent/with-logging'
import { forwardRendererOutput } from './log/renderer-output'
import { createFileSink } from './log/sink'
import { seedWorkspacePath } from './shell/seed-workspace'
import { createShell } from './shell/shell'
import { createShellStore } from './shell/store'
import { createMainWindow } from './window'

// One sink per launch, built here at startup and passed everywhere from here
// on — main is the sole writer of the run log, which lives repo-local under
// `logs/`.
const log = createFileSink(join(app.getAppPath(), 'logs'))

log.append({
  source: 'main',
  event: 'app_starting',
  pid: process.pid,
  electron: process.versions.electron,
  dev: Boolean(process.env.ELECTRON_RENDERER_URL)
})

// The launch flavor is decided once, here, before any window exists — one
// adapter for the launch, whichever window is holding it at the time. What the
// launch asked for is `selectAdapter`'s business alone, so nothing of the
// environment is read here.
const { adapter, flavor } = selectAdapter(log)

/**
 * Crucible's own state file, in Crucible's own directory. Nothing of π's is
 * read, written or named here (A28); the adapter's binding tokens are the only
 * thing in it that means anything to an adapter, and they are opaque strings.
 */
const store = createShellStore(join(app.getPath('userData'), 'shell-state.json'), (cause) => {
  log.append({
    source: 'main',
    event: 'store_write_failed',
    message: cause instanceof Error ? cause.message : String(cause)
  })
})

/**
 * The folder picker, which is the only reason adding a workspace is an
 * operation on the port rather than an argument to one: the dialog is the main
 * process's to open, and the renderer never learns a path it did not receive
 * in a snapshot.
 */
async function pickFolder(): Promise<string | null> {
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const options = {
    title: 'Add workspace',
    buttonLabel: 'Add workspace',
    properties: ['openDirectory' as const, 'createDirectory' as const]
  }
  const chosen =
    parent === undefined
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(parent, options)
  return chosen.canceled || chosen.filePaths.length === 0 ? null : chosen.filePaths[0]
}

// One shell for the launch, wrapped so every operation and every event it
// produces is on the run log (LF-2).
const shell = withLogging(
  createShell({
    store,
    adapter,
    pickFolder,
    seedWorkspacePath: seedWorkspacePath()
  }),
  log,
  flavor
)

let channel: AgentChannel | undefined

/** The window and the agent channel that serves it: one window at a time. */
function openWindow(reason?: 'activate'): void {
  const window = createMainWindow()
  // The renderer writes nothing itself. Its console output and any preload
  // failure are forwarded here and appended to the same sink, so one file holds
  // both processes in one order.
  forwardRendererOutput(window.webContents, log)
  channel = serveAgentChannel(shell, window)
  log.append(
    reason === undefined
      ? { source: 'main', event: 'window_created' }
      : { source: 'main', event: 'window_created', reason }
  )
}

void app.whenReady().then(() => {
  log.append({ source: 'main', event: 'app_ready' })

  openWindow()

  // macOS: the app stays alive with no windows; re-open one on dock activate.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length > 0) return
    openWindow('activate')
  })
})

app.on('window-all-closed', () => {
  log.append({ source: 'main', event: 'windows_closed' })
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  // Whatever was still running is dropped rather than left running unseen.
  channel?.dispose()
  log.append({ source: 'main', event: 'app_quitting' })
})
