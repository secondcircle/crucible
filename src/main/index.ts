import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
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

void app.whenReady().then(() => {
  log.append({ source: 'main', event: 'app_ready' })

  createMainWindow()
  log.append({ source: 'main', event: 'window_created' })

  // macOS: the app stays alive with no windows; re-open one on dock activate.
  // Still one window at a time (D2).
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length > 0) return
    createMainWindow()
    log.append({ source: 'main', event: 'window_created', reason: 'activate' })
  })
})

app.on('window-all-closed', () => {
  log.append({ source: 'main', event: 'windows_closed' })
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  log.append({ source: 'main', event: 'app_quitting' })
})
