import { join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { type AgentChannel, serveAgentChannel } from './agent/channel'
import { selectAdapter } from './agent/select-adapter'
import { withLogging } from './agent/with-logging'
import { forwardRendererOutput } from './log/renderer-output'
import { createFileSink } from './log/sink'
import { panelFixtures } from './panel/fixtures'
import { createPanelModel } from './panel/model'
import { storePanelPersistence } from './panel/store-persistence'
import { seedWorkspacePath } from './shell/seed-workspace'
import { createShell } from './shell/shell'
import { createShellStore } from './shell/store'
import { createMainWindow } from './window'
import { serveWorkspaceChannel, type WorkspaceChannel } from './workspace/channel'
import { selectWorkspaceService } from './workspace/select-service'

// One sink per launch, built here and passed everywhere: main is the sole
// writer of the run log.
const log = createFileSink(join(app.getAppPath(), 'logs'))

log.append({
  source: 'main',
  event: 'app_starting',
  pid: process.pid,
  electron: process.versions.electron,
  dev: Boolean(process.env.ELECTRON_RENDERER_URL)
})

// Crucible's own state file in Crucible's own directory: nothing of π's is read
// or written here.
const store = createShellStore(join(app.getPath('userData'), 'shell-state.json'), (cause) => {
  log.append({
    source: 'main',
    event: 'store_write_failed',
    message: cause instanceof Error ? cause.message : String(cause)
  })
})

// One context panel for the launch, persisting inside the same store: the
// adapter's three tools and the shell's snapshots read the same tabs.
const panel = createPanelModel({ persistence: storePanelPersistence(store) })

// Decided once, before any window exists: one adapter for the launch, whichever
// window is holding it at the time.
const { adapter, flavor } = selectAdapter(log, {
  tools: panel,
  exhibits: panelFixtures(app.getAppPath())
})

// One flavor decision governs both seams, so a fake-flavor launch reads no
// folder and starts no process either.
const workspace = selectWorkspaceService(flavor, log)

// The dialog is the main process's to open, which is why adding a workspace is
// an operation on the port rather than an argument to one.
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

// One shell for the launch, wrapped so every operation and event it produces is
// on the run log.
const shell = withLogging(
  createShell({
    store,
    adapter,
    panel,
    pickFolder,
    seedWorkspacePath: seedWorkspacePath()
  }),
  log,
  flavor
)

let channel: AgentChannel | undefined
let workspaceChannel: WorkspaceChannel | undefined

function openWindow(reason?: 'activate'): void {
  const window = createMainWindow()
  // The renderer writes nothing itself: its console output is forwarded here,
  // so one file holds both processes in one order.
  forwardRendererOutput(window.webContents, log)
  channel = serveAgentChannel(shell, window)
  workspaceChannel = serveWorkspaceChannel(workspace.service, window)
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
  workspaceChannel?.dispose()
  workspace.dispose()
  log.append({ source: 'main', event: 'app_quitting' })
})
