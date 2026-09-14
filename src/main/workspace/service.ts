import { execFile, spawn } from 'node:child_process'
import { statSync, utimesSync, watch, type FSWatcher } from 'node:fs'
import { resolve } from 'node:path'
import { rankFiles } from '../../shared/workspace/match'
import type {
  FileTree,
  IssueBoardAnswer,
  RunId,
  Unsubscribe,
  WorkspaceEvent,
  WorkspaceEventListener,
  WorkspaceService,
  WorktreeCreation
} from '../../shared/workspace/service'
import type {
  ConnectOutcome,
  ResearchOutcome,
  ResearchStatus
} from '../../shared/workspace/research'
import type { CommandOutcome, CommandRunner } from './command-runner'
import { collectIssues } from './collect-issues'
import { fileTree, listFiles } from './files'
import { createResearchOperations } from './research'
import { createResearchProcesses, type ResearchProcesses } from './research-processes'
import { bashLocation, killTree } from '../platform/exec'
import { createWorktree, isGitWorkspace } from './worktree'

// The workspace service's real flavor: the one module that reads the user's
// folders and starts their processes, reachable only through its own channel.

export interface RealWorkspaceService extends WorkspaceService {
  /** Kills whatever is still running, for app quit and for tests. */
  dispose(): void
}

interface Run {
  readonly kill: () => void
}

interface Watch {
  readonly watcher: FSWatcher
  refs: number
  settling?: ReturnType<typeof setTimeout>
  /** False while the watch is being armed, when every event is the probe's own. */
  live: boolean
  /** Resolves when arming is over, so a second caller waits for the first. */
  armed: Promise<void>
}

// A build writes hundreds of files in a second, and each of them is one event.
// Long enough to arrive as one change, short enough that watching an agent
// work still feels live.
const SETTLE_MS = 120

/** No more output than a repository's branches or pull requests can fill. */
const MAX_OUTPUT = 8 * 1024 * 1024

// Nothing the collector runs may block on a person or disturb a working tree an
// agent is mid-turn in: no credential prompt, and no optional index lock.
const COLLECTION_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GH_PROMPT_DISABLED: '1'
}

// git churns its own directory constantly — an index lock per command — and
// nothing under it is listed, so its noise is not a change to the tree.
function insideGit(filename: string | null): boolean {
  return filename !== null && /^\.git([/\\]|$)/.test(filename)
}

// macOS arms a recursive watch on the FSEvents thread, so `watch()` returning
// is not the watch running: a change written in the milliseconds before it
// arms is lost, silently and for good. Under load that window stretches to
// tens of milliseconds, which is exactly when a workspace is opened and an
// agent starts writing in it.
const NEEDS_ARMING = process.platform === 'darwin'

/** Long enough for a loaded machine, short enough not to hang opening a tree. */
const ARMING_BUDGET_MS = 3000

/**
 * Touches the directory's own timestamps — with the values it already has —
 * until the watcher reports something back. A touch changes nothing anyone
 * else reads, and it is the only change the watch can be asked for without
 * writing into the workspace.
 */
async function whenArmed(
  directory: string,
  delivered: () => boolean,
  abandoned: () => boolean
): Promise<void> {
  if (!NEEDS_ARMING) return
  let times: ReturnType<typeof statSync>
  try {
    times = statSync(directory)
  } catch {
    return
  }
  const deadline = Date.now() + ARMING_BUDGET_MS
  while (!delivered()) {
    // A directory nobody may touch, or one already let go of, is armed as far
    // as we will ever know: the tree still refreshes when something asks it to.
    if (abandoned() || Date.now() > deadline) return
    try {
      utimesSync(directory, times.atime, times.mtime)
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  // One touch can come back more than once, and a straggler let through after
  // arming would read as a change nobody made.
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
}

function startWatch(
  directory: string,
  changed: (filename: string | null) => void
): FSWatcher | undefined {
  function listen(recursive: boolean): FSWatcher | undefined {
    try {
      const watcher = watch(directory, { recursive }, (_event, filename) => {
        changed(filename)
      })
      // A watch that dies takes itself down rather than throwing out of an
      // event: the tree goes back to refreshing when something asks it to.
      watcher.on('error', () => watcher.close())
      return watcher
    } catch {
      return undefined
    }
  }
  // Depth is the whole point, but a platform that refuses a recursive watch is
  // better served by a shallow one than by none.
  return listen(true) ?? listen(false)
}

export function spawnRunner(): CommandRunner {
  return (command, args, { cwd, timeoutMs }) =>
    new Promise<CommandOutcome>((resolve) => {
      execFile(
        command,
        [...args],
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: MAX_OUTPUT,
          encoding: 'utf8',
          env: { ...process.env, ...COLLECTION_ENV }
        },
        (failure, stdout, stderr) => {
          resolve({ ok: failure === null, stdout, stderr })
        }
      )
    })
}

export function createWorkspaceService({
  openExternal,
  revealItem,
  runner = spawnRunner(),
  research = createResearchProcesses()
}: {
  /** The OS browser, which only main may reach. */
  readonly openExternal: (url: string) => void
  /** The platform's file manager, likewise. */
  readonly revealItem: (path: string) => void
  readonly runner?: CommandRunner
  // Its own process seam, not the collector's runner: the research calls turn
  // on a distinction that runner throws away, and one of them waits on a person.
  readonly research?: ResearchProcesses
}): RealWorkspaceService {
  const listeners = new Set<WorkspaceEventListener>()
  const runs = new Map<RunId, Run>()
  const watches = new Map<string, Watch>()
  // One collection per workspace at a time: a second caller joins the first
  // rather than starting a second `gh` stampede.
  const collectingIssues = new Map<string, Promise<IssueBoardAnswer>>()
  let minted = 0

  function emit(event: WorkspaceEvent): void {
    for (const listener of [...listeners]) listener(event)
  }

  const operations = createResearchOperations({
    processes: research,
    onOutput: (chunk) => emit({ type: 'research_output', chunk })
  })

  return {
    async searchFiles(directory: string, query: string): Promise<readonly string[]> {
      return rankFiles(await listFiles(directory), query)
    },

    fileTree(directory: string): Promise<FileTree> {
      return fileTree(directory)
    },

    async watchFiles(directory: string): Promise<void> {
      const already = watches.get(directory)
      if (already !== undefined) {
        already.refs += 1
        // Whoever asked first is still arming it; nobody is watching until then.
        await already.armed
        return
      }
      let delivered = false
      // A folder that cannot be watched is not a folder to fail over: the tree
      // still lists and still refreshes when something else asks it to.
      const watcher = startWatch(directory, (filename) => {
        // Anything at all proves the watch is live, .git's own churn included.
        delivered = true
        if (insideGit(filename)) return
        const live = watches.get(directory)
        if (live === undefined || !live.live) return
        clearTimeout(live.settling)
        live.settling = setTimeout(() => emit({ type: 'files_changed', directory }), SETTLE_MS)
      })
      if (watcher === undefined) return
      // Registered before it is armed, so letting go mid-arming is noticed.
      const held: Watch = { watcher, refs: 1, live: false, armed: Promise.resolve() }
      watches.set(directory, held)
      held.armed = whenArmed(
        directory,
        () => delivered,
        () => watches.get(directory) !== held
      )
      await held.armed
      held.live = true
    },

    async unwatchFiles(directory: string): Promise<void> {
      const held = watches.get(directory)
      if (held === undefined) return
      held.refs -= 1
      if (held.refs > 0) return
      clearTimeout(held.settling)
      held.watcher.close()
      watches.delete(directory)
    },

    async revealFile(directory: string, path: string): Promise<void> {
      revealItem(resolve(directory, path))
    },

    isGitWorkspace(workspacePath: string): Promise<boolean> {
      return isGitWorkspace(workspacePath)
    },

    createWorktree(workspacePath: string): Promise<WorktreeCreation> {
      return createWorktree(workspacePath)
    },

    async startRun(directory: string, command: string): Promise<RunId> {
      minted += 1
      const runId = `run-${minted}`

      // A bash run is bash on every OS; where that bash is, is the platform
      // module's answer. When there is none — Windows without Git for Windows
      // — the run says so in its own output rather than failing invisibly.
      const bash = bashLocation()
      if (!bash.ok) {
        queueMicrotask(() => {
          emit({ type: 'run_output', runId, chunk: `${bash.message}\n` })
          emit({ type: 'run_ended', runId, exitCode: 127 })
        })
        return runId
      }

      // Its own process group, so stopping the run stops what it started
      // rather than orphaning a tree of children.
      const child = spawn(bash.path, ['-c', command], {
        cwd: directory,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let ended = false
      // Set by stopRun. Killing a process group is not atomic: bash can see its
      // child die and exit 137 on its own before its own SIGKILL lands, which
      // would report a status for a run nobody let finish.
      let stopped = false
      function end(exitCode?: number): void {
        if (ended) return
        ended = true
        runs.delete(runId)
        emit(exitCode === undefined ? { type: 'run_ended', runId } : { type: 'run_ended', runId, exitCode })
      }

      // Both streams go to the same place in arrival order, which is what the
      // person watching the drawer saw the shell print.
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding('utf8')
        stream.on('data', (chunk: string) => emit({ type: 'run_output', runId, chunk }))
      }

      child.on('error', (cause: Error) => {
        emit({ type: 'run_output', runId, chunk: `${cause.message}\n` })
        end(127)
      })

      child.on('close', (code, signal) => {
        // A signalled or stopped process never finished, so it has no exit
        // status to report.
        end(!stopped && signal === null && code !== null ? code : undefined)
      })

      runs.set(runId, {
        kill(): void {
          if (child.pid === undefined) return
          stopped = true
          killTree(child.pid)
        }
      })

      return runId
    },

    async stopRun(runId: RunId): Promise<void> {
      runs.get(runId)?.kill()
    },

    issueBoard(workspacePath: string): Promise<IssueBoardAnswer> {
      const joined = collectingIssues.get(workspacePath)
      if (joined !== undefined) return joined
      const collection = collectIssues(runner, workspacePath).finally(() => {
        collectingIssues.delete(workspacePath)
      })
      collectingIssues.set(workspacePath, collection)
      return collection
    },

    async openUrl(url: string): Promise<void> {
      // The renderer hands over text; what it names is checked here, where the
      // capability actually is.
      const wanted = URL.parse(url)
      if (wanted === null || wanted.protocol !== 'https:') {
        throw new Error('Crucible opens https links only.')
      }
      openExternal(wanted.toString())
    },

    researchStatus(): Promise<ResearchStatus> {
      return operations.status()
    },

    researchConnect(apiKey?: string): Promise<ConnectOutcome> {
      return operations.connect(apiKey)
    },

    researchCancelConnect(): Promise<void> {
      return operations.cancelConnect()
    },

    researchDisconnect(): Promise<ResearchOutcome> {
      return operations.disconnect()
    },

    onEvent(listener: WorkspaceEventListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    dispose(): void {
      for (const run of runs.values()) run.kill()
      runs.clear()
      for (const held of watches.values()) {
        clearTimeout(held.settling)
        held.watcher.close()
      }
      watches.clear()
      operations.dispose()
    }
  }
}
