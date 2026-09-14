import { execFile, spawn } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
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
  /** True once the watch has delivered anything, which is the only proof it runs. */
  live: boolean
  /** The window's own timer, dropped with the watch that opened it. */
  starting?: ReturnType<typeof setTimeout>
}

// A build writes hundreds of files in a second, and each of them is one event.
// Long enough to arrive as one change, short enough that watching an agent
// work still feels live.
const SETTLE_MS = 120

// A recursive watch is not running when `watch()` returns. macOS arms it on
// the FSEvents thread and drops everything written before it gets there; where
// there is no recursive watch to ask the OS for, Node walks the tree itself,
// which takes as long as the tree is deep. Measured here on a loaded machine,
// a file written in the same millisecond is lost outright, and the watch wakes
// tens of milliseconds later — seconds, when the machine is busy enough — with
// nothing to say about it. Long enough to cover that, short enough that a tree
// left stale by it corrects itself while the person is still looking at it.
const STARTING_MS = 2000

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

  // One announcement for a burst, whether the burst is the watcher's events or
  // the one the starting window owes: a settling timer already in flight is
  // the same change, said twice.
  function announce(directory: string, held: Watch): void {
    clearTimeout(held.settling)
    held.settling = setTimeout(() => emit({ type: 'files_changed', directory }), SETTLE_MS)
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

    // Nothing here writes, and nothing waits: the directory is the user's, and
    // an earlier version that touched its own timestamps to make the watcher
    // speak moved its ctime — `utimes` does, whatever values it is handed.
    //
    // What is left is to say so. A watch that has not delivered a single event
    // by the time its starting window is over announces one change, because a
    // directory nothing happened in and a directory whose events were dropped
    // look exactly alike from here. That costs a quiet workspace one extra
    // listing; without it a file written in the window is one the tree never
    // hears about, and nothing re-lists after.
    async watchFiles(directory: string): Promise<void> {
      const already = watches.get(directory)
      if (already !== undefined) {
        already.refs += 1
        return
      }
      // A folder that cannot be watched is not a folder to fail over: the tree
      // still lists and still refreshes when something else asks it to.
      const watcher = startWatch(directory, (filename) => {
        const held = watches.get(directory)
        if (held === undefined) return
        // Anything at all proves the watch is running, .git's own churn included.
        held.live = true
        if (insideGit(filename)) return
        announce(directory, held)
      })
      if (watcher === undefined) return
      const held: Watch = { watcher, refs: 1, live: false }
      // Registered with no await before it, so a second caller finds the first
      // watch rather than starting one of its own.
      watches.set(directory, held)
      held.starting = setTimeout(() => {
        if (watches.get(directory) !== held || held.live) return
        announce(directory, held)
      }, STARTING_MS)
    },

    async unwatchFiles(directory: string): Promise<void> {
      const held = watches.get(directory)
      if (held === undefined) return
      held.refs -= 1
      if (held.refs > 0) return
      clearTimeout(held.settling)
      clearTimeout(held.starting)
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
        clearTimeout(held.starting)
        held.watcher.close()
      }
      watches.clear()
      operations.dispose()
    }
  }
}
