import { basename, join, sep } from 'node:path'
import { app, BrowserWindow, dialog, shell as electronShell } from 'electron'
import { type AgentChannel, serveAgentChannel } from './agent/channel'
import type { SessionId } from '../shared/agent/port'
import { type AppUpdateChannel, serveAppUpdateChannel } from './app-update/channel'
import { type CacheChannel, serveCacheChannel } from './cache/channel'
import { createCacheLedger } from './cache/ledger'
import { useCacheLedgerDir } from './cache/paths'
import { createAppUpdateService, stillAppUpdateService } from './app-update/service'
import { decideFlavor, selectAdapter } from './agent/select-adapter'
import { withLogging } from './agent/with-logging'
import { type CommandChannel, serveCommandChannel } from './commands/channel'
import { selectCommandService } from './commands/select-service'
import { shippedSystemPrompt } from './shipped'
import { forwardRendererOutput } from './log/renderer-output'
import { createFileSink } from './log/sink'
import { type NeedsYouChannel, serveNeedsYouChannel } from './needs-you/channel'
import { selectNeedsYouService } from './needs-you/select-service'
import type { LiveNeedsYouService } from './needs-you/service'
import { registerExhibitScheme, serveExhibitScheme } from './panel/exhibit-scheme'
import { type QuotaChannel, serveQuotaChannel } from './quota/channel'
import { useQuotaCacheDir } from './quota/paths'
import { selectQuotaService } from './quota/select-service'
import { panelFixtures } from './panel/fixtures'
import { createPanelModel } from './panel/model'
import { storePanelPersistence } from './panel/store-persistence'
import { seedWorkspacePath } from './shell/seed-workspace'
import { createShell } from './shell/shell'
import { createShellStore } from './shell/store'
import { createMainWindow } from './window'
import { serveWorkspaceChannel, type WorkspaceChannel } from './workspace/channel'
import { selectWorkspaceService } from './workspace/select-service'
import { serveWorkflowRunChannel, type WorkflowRunChannel } from './workflows/channel'
import { selectWorkflowRunService } from './workflows/select-service'

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
  //
  // A run's worktree gets its own directory under that, because concurrent
  // builds would otherwise write one another's sessions and config. Only
  // Crucible-managed worktrees are suffixed, so the human's own checkout keeps
  // the plain Crucible-Dev state it has always had. The matching per-checkout
  // debug port lives in scripts/dev-port.sh.
  const root = app.getAppPath()
  const inRunWorktree = root.includes(`${sep}.crucible${sep}worktrees${sep}`)
  const devState = inRunWorktree ? `Crucible-Dev-${basename(root)}` : 'Crucible-Dev'
  app.setPath('userData', join(app.getPath('appData'), devState))
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

// The cache ledger, before anything that could observe a miss: one file per
// installation, directly under Crucible's own state directory, flavor-scoped
// like everything there and never pruned (ADR 0015, ADR 0019). A fake-flavor
// launch writes to the dev ledger, which is what makes the whole loop
// drivable by an agent.
useCacheLedgerDir(app.getPath('userData'))
const cache = createCacheLedger({
  onFailure: (cause) => {
    log.append({
      source: 'main',
      event: 'cache_ledger_write_failed',
      message: cause instanceof Error ? cause.message : String(cause)
    })
  }
})

// The workflow engine exists before the adapter, because the run tools ride
// every composed agent. A run speaks by messaging its orchestrator session,
// and the shell that carries the message is built later — the indirection
// below is that knot untied.
// Initialized explicitly so the one real assignment below stays an
// assignment: the closure above it must keep reading this binding late.
let orchestratorInbox: ((sessionId: SessionId, text: string) => void) | undefined = undefined
const workflowRuns = selectWorkflowRunService(
  decideFlavor(process.env.CRUCIBLE_AGENT, app.isPackaged).flavor,
  log,
  {
    appPath: app.getAppPath(),
    stateDir: app.getPath('userData'),
    cache,
    // The renderer gets no path-opening capability of its own; Reveal in the
    // artifact reader asks the service, which asks this.
    reveal: (path: string) => electronShell.showItemInFolder(path),
    deliver: (sessionId, text) => {
      if (orchestratorInbox === undefined) {
        throw new Error('no shell is up to carry a run message yet')
      }
      orchestratorInbox(sessionId, text)
    }
  }
)

// Decided once, before any window exists: one adapter for the launch, whichever
// window is holding it at the time.
const { adapter, flavor } = selectAdapter(
  log,
  { tools: panel, exhibits: panelFixtures(app.getAppPath()) },
  {
    // A thunk, so a fake-flavor launch starts even when a shipped prompt file
    // cannot be read; for the sdk flavor an unreadable file throws the launch.
    systemPrompt: () => shippedSystemPrompt(app.getAppPath()),
    // A login's browser is opened here; the renderer gets no such capability.
    openExternal: (url: string) => {
      void electronShell.openExternal(url)
    }
  },
  app.isPackaged,
  workflowRuns.tools
)

// One flavor decision governs every seam, so a fake-flavor launch reads no
// folder, starts no process and serves canned commands.
const workspace = selectWorkspaceService(flavor, log, (url: string) => {
  void electronShell.openExternal(url)
})
const commands = selectCommandService(flavor, log, app.getAppPath())
// One store for the launch, whatever is on screen: two windows, two workspaces
// or a dozen sessions never multiply the requests. The cache is Crucible's own
// and lives under Crucible's state, so it follows the dev/installed split and
// touches nothing of π's (ADR 0015).
useQuotaCacheDir(app.getPath('userData'))
const quota = selectQuotaService(flavor, log)

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
    seedWorkspacePath: seedWorkspacePath(),
    cache,
    // Nobody asked for a title, so nobody is told it failed: the run log is
    // the whole of the report.
    onTitlingFailure: (cause) => {
      log.append({
        source: 'main',
        event: 'titling_failed',
        adapter: flavor,
        message: cause instanceof Error ? cause.message : String(cause)
      })
    }
  }),
  log,
  flavor
)

// A run's message is a follow-up: queued while the orchestrator works,
// prompted the moment it is idle — never lost, never refused (ADR 0017).
orchestratorInbox = (sessionId, text) => {
  void shell.followUp(sessionId, text).catch((cause: unknown) => {
    log.append({
      source: 'main',
      event: 'run_message_undeliverable',
      sessionId,
      message: cause instanceof Error ? cause.message : String(cause)
    })
  })
}

let channel: AgentChannel | undefined
let workspaceChannel: WorkspaceChannel | undefined
let commandChannel: CommandChannel | undefined
let appUpdateChannel: AppUpdateChannel | undefined
let quotaChannel: QuotaChannel | undefined
let cacheChannel: CacheChannel | undefined
let needsYouChannel: NeedsYouChannel | undefined
let needsYou: LiveNeedsYouService | undefined
let workflowRunChannel: WorkflowRunChannel | undefined

function openWindow(reason?: 'activate'): void {
  const window = createMainWindow()
  // The renderer writes nothing itself: its console output is forwarded here,
  // so one file holds both processes in one order.
  forwardRendererOutput(window.webContents, log)
  channel = serveAgentChannel(shell, window)
  workspaceChannel = serveWorkspaceChannel(workspace.service, window)
  commandChannel = serveCommandChannel(commands, window)
  appUpdateChannel = serveAppUpdateChannel(appUpdate, window)
  quotaChannel = serveQuotaChannel(quota, window)
  cacheChannel = serveCacheChannel(cache, window)
  // Per window, because the dock badge and the banners follow that window's
  // focus. A clicked banner is served here rather than in the renderer: the
  // session is activated on the shell, and the sidebar hears about it as the
  // ordinary state event it would get from a click in the rail.
  needsYou = selectNeedsYouService(flavor, window, log, (sessionId) => {
    void shell.activateSession(sessionId).catch(() => {})
  })
  needsYouChannel = serveNeedsYouChannel(needsYou, window)
  workflowRunChannel = serveWorkflowRunChannel(workflowRuns, window)
  // ⌘R is the global runs view (Q15). Taken here, before the menu can spend
  // it on reload; dev reloads keep ⇧⌘R. On non-mac the chord is Ctrl+R.
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key.toLowerCase() !== 'r') return
    const chord = process.platform === 'darwin' ? input.meta : input.control
    if (!chord || input.shift || input.alt) return
    event.preventDefault()
    workflowRuns.toggleOverview()
  })
  log.append(
    reason === undefined
      ? { source: 'main', event: 'window_created' }
      : { source: 'main', event: 'window_created', reason }
  )
}

void app.whenReady().then(() => {
  log.append({ source: 'main', event: 'app_ready' })

  // The handler answers out of the same panel model the tools write to and the
  // same run service the view reads, so a file is servable exactly while a tab
  // shows it or a run's record names it.
  serveExhibitScheme(panel, workflowRuns)

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
  workflowRunChannel?.dispose()
  workflowRuns.dispose()
  workspaceChannel?.dispose()
  commandChannel?.dispose()
  appUpdateChannel?.dispose()
  quotaChannel?.dispose()
  cacheChannel?.dispose()
  needsYouChannel?.dispose()
  needsYou?.dispose()
  appUpdate.dispose()
  workspace.dispose()
  log.append({ source: 'main', event: 'app_quitting' })
})
