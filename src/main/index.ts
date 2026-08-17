import { app, BrowserWindow } from 'electron'
import { createMainWindow } from './window'

void app.whenReady().then(() => {
  createMainWindow()

  // macOS: the app stays alive with no windows; re-open one on dock activate.
  // Still one window at a time (D2).
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
