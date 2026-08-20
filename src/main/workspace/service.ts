import { spawn } from 'node:child_process'
import { rankFiles } from '../../shared/workspace/match'
import type {
  RunId,
  Unsubscribe,
  WorkspaceEvent,
  WorkspaceEventListener,
  WorkspaceService
} from '../../shared/workspace/service'
import { listFiles } from './files'

// The workspace service's real flavor: the one module that reads the user's
// folders and starts their processes. Nothing agent-side is reachable from
// here, and nothing here is reachable from the renderer except through the
// workspace channel (ADR 0005).

export interface RealWorkspaceService extends WorkspaceService {
  /** Kills whatever is still running, for app quit and for tests. */
  dispose(): void
}

interface Run {
  readonly kill: () => void
}

export function createWorkspaceService(): RealWorkspaceService {
  const listeners = new Set<WorkspaceEventListener>()
  const runs = new Map<RunId, Run>()
  let minted = 0

  function emit(event: WorkspaceEvent): void {
    for (const listener of [...listeners]) listener(event)
  }

  return {
    async searchFiles(workspacePath: string, query: string): Promise<readonly string[]> {
      return rankFiles(await listFiles(workspacePath), query)
    },

    async startRun(workspacePath: string, command: string): Promise<RunId> {
      minted += 1
      const runId = `run-${minted}`

      // Its own process group, so stopping the run stops what it started
      // rather than orphaning a tree of children.
      const child = spawn('bash', ['-c', command], {
        cwd: workspacePath,
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
