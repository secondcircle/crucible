import { execFile, spawn } from 'node:child_process'
import { rankFiles } from '../../shared/workspace/match'
import type {
  BranchBoardAnswer,
  IssueBoardAnswer,
  RunId,
  Unsubscribe,
  WorkspaceEvent,
  WorkspaceEventListener,
  WorkspaceService,
  WorktreeCreation
} from '../../shared/workspace/service'
import { collectBoard, type CommandOutcome, type CommandRunner } from './collect-board'
import { collectIssues } from './collect-issues'
import { listFiles } from './files'
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
  runner = spawnRunner()
}: {
  /** The OS browser, which only main may reach. */
  readonly openExternal: (url: string) => void
  readonly runner?: CommandRunner
}): RealWorkspaceService {
  const listeners = new Set<WorkspaceEventListener>()
  const runs = new Map<RunId, Run>()
  // One collection per workspace at a time: a second caller joins the first
  // rather than starting a second `gh` stampede.
  const collecting = new Map<string, Promise<BranchBoardAnswer>>()
  // The issues have their own hold: they ask the host different questions, and
  // neither board should wait on the other's answer.
  const collectingIssues = new Map<string, Promise<IssueBoardAnswer>>()
  let minted = 0

  function emit(event: WorkspaceEvent): void {
    for (const listener of [...listeners]) listener(event)
  }

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

      // Its own process group, so stopping the run stops what it started
      // rather than orphaning a tree of children.
      const child = spawn('bash', ['-c', command], {
        cwd: directory,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let ended = false
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
        // A signalled process never exited, so it has no exit status to report.
        end(signal === null && code !== null ? code : undefined)
      })

      runs.set(runId, {
        kill(): void {
          if (child.pid === undefined) return
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {
            // Already gone, which is the outcome asked for.
          }
        }
      })

      return runId
    },

    async stopRun(runId: RunId): Promise<void> {
      runs.get(runId)?.kill()
    },

    branchBoard(workspacePath: string): Promise<BranchBoardAnswer> {
      const joined = collecting.get(workspacePath)
      if (joined !== undefined) return joined
      const collection = collectBoard(runner, workspacePath).finally(() => {
        collecting.delete(workspacePath)
      })
      collecting.set(workspacePath, collection)
      return collection
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

    onEvent(listener: WorkspaceEventListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    dispose(): void {
      for (const run of runs.values()) run.kill()
      runs.clear()
    }
  }
}
