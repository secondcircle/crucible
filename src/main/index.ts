import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { type AgentChannel, serveAgentChannel } from './agent/channel'
import { selectAdapter } from './agent/select-adapter'
import { forwardRendererOutput } from './log/renderer-output'
import { createFileSink } from './log/sink'
import { createMainWindow } from './window'

// D9: one sink per launch, built here at startup and passed everywhere from
// here on — main is the sole writer of the run log, which lives repo-local
// under `logs/`.
const log = createFileSink(join(app.getAppPath(), 'logs'))

log.append({
  source: 'main',
  event: 'app_starting',
  pid: process.pid,
  electron: process.versions.electron,
  dev: Boolean(process.env.ELECTRON_RENDERER_URL)
})

// D5: the launch flavor is decided once, here, before any window exists — one
// adapter for the launch, whichever window is holding it at the time. What the
// launch asked for is `selectAdapter`'s business alone, so nothing of the
// environment is read here. The channel owns the adapter from here on.
const adapter = selectAdapter(log)

let channel: AgentChannel | undefined

/**
 * The window and the agent channel that serves it: one window at a time (D2),
 * and the channel it is served over lives and dies with it.
 */
function openWindow(reason?: 'activate'): void {
  const window = createMainWindow()
  // D9: the renderer writes nothing itself. Its console output and any preload
  // failure are forwarded here and appended to the same sink, so one file holds
  // both processes in one order.
  forwardRendererOutput(window.webContents, log)
  channel = serveAgentChannel(adapter, window)
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
  // Still one window at a time (D2).
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
  // Whatever was still running is dropped rather than left running unseen (D6).
  channel?.dispose()
  log.append({ source: 'main', event: 'app_quitting' })
})
