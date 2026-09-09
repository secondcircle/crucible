import { execFile, spawn } from 'node:child_process'
import { rankFiles } from '../../shared/workspace/match'
import type {
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
import { listFiles } from './files'
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

/** No more output than a repository's branches or pull requests can fill. */
const MAX_OUTPUT = 8 * 1024 * 1024

// Nothing the collector runs may block on a person or disturb a working tree an
// agent is mid-turn in: no credential prompt, and no optional index lock.
const COLLECTION_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GH_PROMPT_DISABLED: '1'
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
  runner = spawnRunner(),
  research = createResearchProcesses()
}: {
  /** The OS browser, which only main may reach. */
  readonly openExternal: (url: string) => void
  readonly runner?: CommandRunner
  // Its own process seam, not the collector's runner: the research calls turn
  // on a distinction that runner throws away, and one of them waits on a person.
  readonly research?: ResearchProcesses
}): RealWorkspaceService {
  const listeners = new Set<WorkspaceEventListener>()
  const runs = new Map<RunId, Run>()
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
      operations.dispose()
    }
  }
}
