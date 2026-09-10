import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  shell as electronShell,
  utilityProcess
} from 'electron'
import { type AgentChannel, serveAgentChannel } from './agent/channel'
import type { SessionId, SystemMessage } from '../shared/agent/port'
import { type MonitorChannel, serveMonitorChannel } from './monitors/channel'
import { selectMonitorService } from './monitors/select-service'
import { type AppUpdateChannel, serveAppUpdateChannel } from './app-update/channel'
import { type CacheChannel, serveCacheChannel } from './cache/channel'
import { createCacheLedger } from './cache/ledger'
import { retentionInForce } from './cache/retention'
import { useCacheLedgerDir } from './cache/paths'
import { createAppUpdateService, type MainAppUpdateService } from './app-update/service'
import { checkoutCommit, createDevVersionService } from './app-update/dev-service'
import { npmRegistry } from './app-update/registry'
import { npmStager } from './app-update/stager'
import { forkedAssembler } from './app-update/forked-assembler'
import { bundleRootFromExecutable } from './install/layout'
import { readPackageIdentity } from './install/package-json'
import { decideFlavor, selectAdapter } from './agent/select-adapter'
import { withLogging } from './agent/with-logging'
import { type CommandChannel, serveCommandChannel } from './commands/channel'
import { selectCommandService } from './commands/select-service'
import { createSkillService, userSkillsPath } from './skills/service'
import { shippedSkillsPath, shippedSystemPrompt } from './shipped'
import { forwardRendererOutput } from './log/renderer-output'
import { createFileSink } from './log/sink'
import { type NeedsYouChannel, serveNeedsYouChannel } from './needs-you/channel'
import { selectNeedsYouService } from './needs-you/select-service'
import type { LiveNeedsYouService } from './needs-you/service'
import { serveScheduleChannel, type ScheduleChannel } from './schedules/channel'
import { selectScheduleService } from './schedules/select-service'
import { type QuotaChannel, serveQuotaChannel } from './quota/channel'
import { useQuotaCacheDir } from './quota/paths'
import { selectQuotaService } from './quota/select-service'
import { panelFixtures } from './panel/fixtures'
import { createPanelModel } from './panel/model'
import { storePanelPersistence } from './panel/store-persistence'
import { seedWorkspacePath } from './shell/seed-workspace'
import { createShell } from './shell/shell'
import { createShellStore } from './shell/store'
import { devInstance } from './instance'
import { createMainWindow } from './window'
import { serveWorkspaceChannel, type WorkspaceChannel } from './workspace/channel'
import { selectWorkspaceService } from './workspace/select-service'
import { serveWorkflowRunChannel, type WorkflowRunChannel } from './workflows/channel'
import type { SpawnHost } from './workflows/host/host'
import { selectWorkflowRunService } from './workflows/select-service'
import { inspectorProfiler, startStallWatchdog } from './watchdog/stalls'

// One hour of prompt retention, for every launch and every flavor. π reads
// this off the environment when it builds a request, and nothing that starts
// Crucible — Dock, dev script, a run's engine — carries a shell environment
// worth inheriting, so main is the only place the choice can be made. It runs
// ahead of the ledger, the adapters and the workflow engine, all of which
// snapshot the setting. Set `PI_CACHE_RETENTION` yourself and that wins.
const retention = retentionInForce()

if (app.isPackaged && process.platform === 'darwin') {
  // Dock-launched apps inherit the bare GUI PATH, and the agent's tools need
  // more than /usr/bin. Prepend the usual install prefixes once, here. Mac
  // only: a Windows or Linux launcher inherits a usable PATH already, and
  // inventing prefixes without evidence is a bug farm.
  const path = process.env.PATH ?? ''
  if (!path.includes('/opt/homebrew/bin')) {
    process.env.PATH = `/opt/homebrew/bin:/usr/local/bin:${path}`
  }
}

// The data firewall between the installed app and every dev launch: dev state
// lives in Crucible-Dev, so no dev build can ever touch the installed app's
// sessions. Set before anything reads `userData`. The badge names the same
// directory the window is pointed at, so the two cannot disagree; the
// installed app has neither a suffix nor a badge.
const instance = app.isPackaged ? undefined : devInstance(app.getAppPath())
if (instance !== undefined) {
  app.setPath('userData', join(app.getPath('appData'), instance.stateDir))
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
  dev: Boolean(process.env.ELECTRON_RENDERER_URL),
  retention: retention.retention
})

// The event loop watched from the first moment: a beachball is this process
// failing to turn its loop, and every stall of a quarter second or more goes
// on the log as `main_stalled` with the frames that held it. Profiles land
// beside the log for DevTools. Set `CRUCIBLE_NO_STALL_PROFILE` to measure
// without the sampling profiler.
const stallWatchdog = startStallWatchdog({
  log,
  profileDir: app.isPackaged ? join(app.getPath('userData'), 'logs') : join(app.getAppPath(), 'logs'),
  writeProfile: (path, body) => {
    void writeFile(path, body).catch(() => {})
  },
  profiler: process.env.CRUCIBLE_NO_STALL_PROFILE === undefined ? inspectorProfiler() : undefined
})

log.append({
  source: 'main',
  event: 'cache_retention',
  retention: retention.retention,
  decidedBy: retention.source
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

// The folder a CRUCIBLE_WORKSPACE launch opens, read once: the shell adds it
// on creation, and the fake flavor's canned runs claim it so their Investigate
// has an open workspace to make a session in.
const seededWorkspace = seedWorkspacePath()

// Where the fake flavor's canned runs say they ran. It has to be a real
// directory the sidebar can hold, or Investigate on those rows is disabled
// forever: a workspace already open, else the seed, else the fallback of
// this checkout, which the user can add.
const cannedWorkspacePath = ((): string | undefined => {
  const { workspaces, activeWorkspaceId } = store.state
  const active = workspaces.find((workspace) => workspace.id === activeWorkspaceId)
  return (active ?? workspaces[0])?.path ?? seededWorkspace
})()

// One context panel for the launch, persisting inside the same store: the
// adapter's three tools and the shell's snapshots read the same tabs.
const panel = createPanelModel({ persistence: storePanelPersistence(store) })

// The cache ledger, before anything that could observe a miss: one file per
// installation, directly under Crucible's own state directory, flavor-scoped
// like everything there and never pruned. A fake-flavor
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

// One store for the launch, whatever is on screen: two windows, two workspaces
// or a dozen sessions never multiply the requests. The cache is Crucible's own
// and lives under Crucible's state, so it follows the dev/installed split and
// touches nothing of π's. Before the engine, which asks it what a node may
// spend on.
useQuotaCacheDir(app.getPath('userData'))
const quota = selectQuotaService(
  decideFlavor(process.env.CRUCIBLE_AGENT, app.isPackaged).flavor,
  log
)

// Everything Crucible says to a session's agent on its own behalf — a run's
// report, a monitor's wake — travels this one road. The shell that carries it
// is built later, because the run tools and the monitor tools ride every
// composed agent; the indirection here is that knot untied.
// Initialized explicitly so the one real assignment below stays an
// assignment: the closures above it must keep reading this binding late.
let inbox: ((sessionId: SessionId, message: SystemMessage) => Promise<void>) | undefined =
  undefined

// The monitor service before the engine, because a node's monitor tools and
// its wait are the engine's to hold, and before the adapter, because a
// session's monitor tools ride every composed agent.
const monitors = selectMonitorService(
  decideFlavor(process.env.CRUCIBLE_AGENT, app.isPackaged).flavor,
  log,
  {
    stateDir: app.getPath('userData'),
    sessionExists: (sessionId) => store.session(sessionId) !== undefined,
    deliver: async (sessionId, message) => {
      if (store.session(sessionId) === undefined) return 'no-session'
      if (inbox === undefined) throw new Error('no shell is up to carry a wake yet')
      await inbox(sessionId, message)
      return 'delivered'
    }
  }
)

// The process a workflow file runs in: a utility process per file, so nothing
// a repository's code does synchronously can hold this one. The entry is the
// fourth thing the main build produces, beside the assembler.
const spawnHost: SpawnHost = (workflowFile, authoringModule) =>
  utilityProcess.fork(
    join(app.getAppPath(), 'out', 'main', 'workflow-host.js'),
    [workflowFile, authoringModule],
    { stdio: 'pipe' }
  )

const workflowRuns = selectWorkflowRunService(
  decideFlavor(process.env.CRUCIBLE_AGENT, app.isPackaged).flavor,
  log,
  {
    appPath: app.getAppPath(),
    stateDir: app.getPath('userData'),
    spawnHost,
    cache,
    quota,
    ...(cannedWorkspacePath === undefined ? {} : { cannedWorkspacePath }),
    // The renderer gets no path-opening capability of its own; Reveal in the
    // artifact reader asks the service, which asks this.
    reveal: (path: string) => electronShell.showItemInFolder(path),
    // The store is the authority on which sessions exist, so a run resuming
    // to a session the user has since deleted goes unattended and parks
    // instead of reporting into nothing.
    sessionExists: (sessionId) => store.session(sessionId) !== undefined,
    monitors: monitors.nodes,
    deliver: (sessionId, text) => {
      if (inbox === undefined) {
        throw new Error('no shell is up to carry a run message yet')
      }
      void inbox(sessionId, { text }).catch((cause: unknown) => {
        log.append({
          source: 'main',
          event: 'run_message_undeliverable',
          sessionId,
          message: cause instanceof Error ? cause.message : String(cause)
        })
      })
    }
  }
)

// The scheduler, beside the run service and above it: it fires runs through
// that seam and reads the records back through it, and knows nothing about
// sessions. Its workspaces are the sidebar's, read fresh at every evaluation
// — a schedule fires for the workspace that declares it and no other.
const schedules = selectScheduleService(
  decideFlavor(process.env.CRUCIBLE_AGENT, app.isPackaged).flavor,
  log,
  {
    appPath: app.getAppPath(),
    stateDir: app.getPath('userData'),
    spawnHost,
    workspaces: () => store.state.workspaces.map((workspace) => workspace.path),
    runs: workflowRuns,
    ...(cannedWorkspacePath === undefined ? {} : { cannedWorkspacePath })
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
    // A thunk for the other half of the same reason: a fake-flavor launch
    // never builds this, so it reads no skill folder at all.
    skills: () =>
      createSkillService({
        roots: { builtIn: shippedSkillsPath(app.getAppPath()), user: userSkillsPath() },
        onDiagnostic: (diagnostic) => {
          log.append({ source: 'main', event: 'skill_diagnostic', ...diagnostic })
        }
      }),
    // A login's browser is opened here; the renderer gets no such capability.
    openExternal: (url: string) => {
      void electronShell.openExternal(url)
    }
  },
  app.isPackaged,
  workflowRuns.tools,
  monitors.tools
)

// One flavor decision governs every seam, so a fake-flavor launch reads no
// folder, starts no process and serves canned commands.
const workspace = selectWorkspaceService(flavor, log, (url: string) => {
  void electronShell.openExternal(url)
})
const commands = selectCommandService(flavor, log, app.getAppPath())

// Installed only: the registry is checked at launch and every 15 minutes, a
// newer version is staged and assembled into this very bundle, and only then
// is a restart offered. A dev launch serves the version service instead, which
// has no update state to carry at all — and asks the registry nothing, so it
// never even reads the package's name.
const appUpdate = app.isPackaged
  ? createInstalledUpdateService()
  : createDevVersionService({
      version: app.getVersion(),
      commit: checkoutCommit(app.getAppPath())
    })

function createInstalledUpdateService(): MainAppUpdateService {
  // The package's own name, read from the package.json this app was built
  // from: the one place it is written, so renaming the package before first
  // publish is one edit and the update check follows it.
  const identity = readPackageIdentity(app.getAppPath())
  return createAppUpdateService({
    version: app.getVersion(),
    // The bundle this process is running from, never a location derived
    // afresh: an app installed under ~/Applications must not assemble its
    // updates into a /Applications copy it will never relaunch.
    bundleRoot: bundleRootFromExecutable(process.platform, app.getPath('exe')),
    registry: npmRegistry(identity.name),
    stage: npmStager({
      packageName: identity.name,
      root: join(app.getPath('userData'), 'update-staging')
    }).stage,
    // In a process of its own: the assembler copies the whole Electron
    // distribution with synchronous file calls, and inline here that held the
    // window frozen for as long as the copy took.
    assemble: forkedAssembler({
      script: join(app.getAppPath(), 'out', 'main', 'assemble-cli.js'),
      packageName: identity.name,
      fork: (script, args) => utilityProcess.fork(script, [...args], { stdio: 'pipe' })
    }),
    relaunch: () => {
      log.append({ source: 'main', event: 'update_restart' })
      app.relaunch()
      app.quit()
    },
    onFailure: (message) => {
      log.append({ source: 'main', event: 'update_check_failed', message })
    }
  })
}

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
    seedWorkspacePath: seededWorkspace,
    // Fresh run status at the start of every user turn, whatever interruption
    // notice this session is owed, and whatever the user stopped watching
    // since the last one. The shell carries an opaque string; every rule about
    // runs and monitors stays behind these two seams.
    turnContext: (sessionId) =>
      joined([workflowRuns.turnStart(sessionId), monitors.turnStart(sessionId)]),
    onSessionEnded: (sessionId) => monitors.release({ kind: 'session', sessionId }),
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

// Crucible's own messages take the shell's own road: queued while the agent
// works, prompted the moment it is idle — never lost, never refused, and
// never read as the user taking a turn.
inbox = (sessionId, message) => shell.deliver(sessionId, message)

/** Two turn-start hooks, one opaque string, and nothing at all when neither spoke. */
function joined(blocks: readonly (string | undefined)[]): string | undefined {
  const said = blocks.filter((block): block is string => block !== undefined && block !== '')
  return said.length === 0 ? undefined : said.join('\n\n')
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
let scheduleChannel: ScheduleChannel | undefined
let monitorChannel: MonitorChannel | undefined

function openWindow(reason?: 'activate'): void {
  const window = createMainWindow({
    ...(instance === undefined ? {} : { instance: instance.badge }),
    // The Dock takes its icon from the bundle; a Windows taskbar and a Linux
    // launcher take theirs from the window.
    ...(process.platform === 'darwin'
      ? {}
      : { icon: join(app.getAppPath(), 'build', 'icon.png') })
  })
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
  scheduleChannel = serveScheduleChannel(schedules.service, window)
  monitorChannel = serveMonitorChannel(monitors, window)
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

  // Off macOS the default File/Edit/View menu is hidden entirely rather than
  // populated with roles this app has no use for: every chord it would carry
  // is handled in the app, and the clipboard chords are native Chromium
  // there. On a Mac the menu is what keeps ⌘C/⌘V/⌘Q alive, so it stays.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)

  openWindow()

  // The clock starts once, after the window exists, so the first evaluation's
  // catch-up fire has a surface to land on. Whatever passed while Crucible was
  // closed is found here and fires once, late and unbothered.
  schedules.scheduler?.begin()

  // Beside it, and for the same reason: a monitor that outlived the quit picks
  // its checking back up here, and a wake it is owed has a shell to reach.
  monitors.begin()

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
  stallWatchdog.dispose()
  channel?.dispose()
  scheduleChannel?.dispose()
  schedules.service.dispose()
  workflowRunChannel?.dispose()
  workflowRuns.dispose()
  monitorChannel?.dispose()
  monitors.dispose()
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
