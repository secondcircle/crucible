import { join } from 'node:path'
import { app, BrowserWindow, dialog, shell as electronShell } from 'electron'
import { type AgentChannel, serveAgentChannel } from './agent/channel'
import { type AppUpdateChannel, serveAppUpdateChannel } from './app-update/channel'
import { createAppUpdateService, stillAppUpdateService } from './app-update/service'
import { selectAdapter } from './agent/select-adapter'
import { withLogging } from './agent/with-logging'
import { type CommandChannel, serveCommandChannel } from './commands/channel'
import { selectCommandService } from './commands/select-service'
import { readShippedAgentDoc } from './shipped'
import { forwardRendererOutput } from './log/renderer-output'
import { createFileSink } from './log/sink'
import { registerExhibitScheme, serveExhibitScheme } from './panel/exhibit-scheme'
import { panelFixtures } from './panel/fixtures'
import { createPanelModel } from './panel/model'
import { storePanelPersistence } from './panel/store-persistence'
import { seedWorkspacePath } from './shell/seed-workspace'
import { createShell } from './shell/shell'
import { createShellStore } from './shell/store'
import { createMainWindow } from './window'
import { serveWorkspaceChannel, type WorkspaceChannel } from './workspace/channel'
import { selectWorkspaceService } from './workspace/select-service'

// Before anything else, because a scheme's privileges are only settable while
// the app is still starting.
registerExhibitScheme()

if (app.isPackaged) {
  // Dock-launched apps inherit the bare GUI PATH, and the agent's tools need
  // more than /usr/bin. Prepend the usual install prefixes once, here.
  const path = process.env.PATH ?? ''
  if (!path.includes('/opt/homebrew/bin')) {
    process.env.PATH = `/opt/homebrew/bin:/usr/local/bin:${path}`
  }
} else {
  // The data firewall between the installed app and every dev launch: dev
  // state lives in Crucible-Dev, so no dev build can ever touch the installed
  // app's sessions. Set before anything reads `userData`.
  app.setPath('userData', join(app.getPath('appData'), 'Crucible-Dev'))
}

// One sink per launch, built here and passed everywhere: main is the sole
// writer of the run log. Packaged, the app bundle is read-only, so the log
// lives beside the rest of the app's state; in dev it stays in the repo.
const log = createFileSink(
  app.isPackaged ? join(app.getPath('userData'), 'logs') : join(app.getAppPath(), 'logs')
)

log.append({
  source: 'main',
  event: 'app_starting',
  pid: process.pid,
  electron: process.versions.electron,
  packaged: app.isPackaged,
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
const { adapter, flavor } = selectAdapter(
  log,
  { tools: panel, exhibits: panelFixtures(app.getAppPath()) },
  {
    // Shipped with the app and read once per launch.
    agentDoc: readShippedAgentDoc(app.getAppPath()),
    // A login's browser is opened here; the renderer gets no such capability.
    openExternal: (url: string) => {
      void electronShell.openExternal(url)
    }
  },
  app.isPackaged
)

// One flavor decision governs every seam, so a fake-flavor launch reads no
// folder, starts no process and serves canned commands.
const workspace = selectWorkspaceService(flavor, log)
const commands = selectCommandService(flavor, log, app.getAppPath())

// Installed only: install-stable replaces the bundle in place, so watching
// our own stamp file is how the running app learns a newer build is waiting.
// A dev launch serves the still service and the pill can never appear.
const appUpdate = app.isPackaged
  ? createAppUpdateService({
      stampPath: join(app.getAppPath(), 'out', 'build-stamp.json'),
      relaunch: () => {
        log.append({ source: 'main', event: 'update_restart' })
        app.relaunch()
        app.quit()
      }
    })
  : stillAppUpdateService()

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
    flavor,
    panel,
    pickFolder,
    seedWorkspacePath: seedWorkspacePath()
  }),
  log,
  flavor
)

let channel: AgentChannel | undefined
let workspaceChannel: WorkspaceChannel | undefined
let commandChannel: CommandChannel | undefined
let appUpdateChannel: AppUpdateChannel | undefined

function openWindow(reason?: 'activate'): void {
  const window = createMainWindow()
  // The renderer writes nothing itself: its console output is forwarded here,
  // so one file holds both processes in one order.
  forwardRendererOutput(window.webContents, log)
  channel = serveAgentChannel(shell, window)
  workspaceChannel = serveWorkspaceChannel(workspace.service, window)
  commandChannel = serveCommandChannel(commands, window)
  appUpdateChannel = serveAppUpdateChannel(appUpdate, window)
  log.append(
    reason === undefined
      ? { source: 'main', event: 'window_created' }
      : { source: 'main', event: 'window_created', reason }
  )
}

void app.whenReady().then(() => {
  log.append({ source: 'main', event: 'app_ready' })

  // The handler answers out of the same panel model the tools write to, so a
  // file is servable exactly while a tab shows it.
  serveExhibitScheme(panel)

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
  commandChannel?.dispose()
  appUpdateChannel?.dispose()
  appUpdate.dispose()
  workspace.dispose()
  log.append({ source: 'main', event: 'app_quitting' })
})
