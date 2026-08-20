import type {
  RunId,
  Unsubscribe,
  WorkspaceEvent,
  WorkspaceEventListener,
  WorkspaceService
} from '../../../shared/workspace/service'
import { rankFiles } from '../../../shared/workspace/match'

// Answers the workspace service's operations the way main does but streams
// nothing by itself, so a component test is about rendering rather than about
// timing.
export interface ScriptedWorkspace extends WorkspaceService {
  readonly calls: ReadonlyArray<{ readonly op: string; readonly args: readonly unknown[] }>
  /** What `searchFiles` ranks and answers from. */
  files: readonly string[]
  /** Every run this service was asked to start, oldest first. */
  readonly started: ReadonlyArray<{ readonly runId: RunId; readonly command: string }>
  /** The most recent run's id, which is the one a test drives. */
  lastRun(): RunId
  output(runId: RunId, chunk: string): void
  /** An absent exit code is a run that was stopped rather than exiting. */
  end(runId: RunId, exitCode?: number): void
}

export function createScriptedWorkspace(files: readonly string[] = []): ScriptedWorkspace {
  const listeners = new Set<WorkspaceEventListener>()
  const calls: Array<{ op: string; args: readonly unknown[] }> = []
  const started: Array<{ runId: RunId; command: string }> = []
  let minted = 0

  function emit(event: WorkspaceEvent): void {
    for (const listener of [...listeners]) listener(event)
  }

  const service: ScriptedWorkspace = {
    calls,
    files,
    started,

    searchFiles(workspacePath: string, query: string): Promise<readonly string[]> {
      calls.push({ op: 'searchFiles', args: [workspacePath, query] })
      return Promise.resolve(rankFiles(service.files, query))
    },

    startRun(workspacePath: string, command: string): Promise<RunId> {
      calls.push({ op: 'startRun', args: [workspacePath, command] })
      minted += 1
      const runId = `scripted-run-${minted}`
      started.push({ runId, command })
      return Promise.resolve(runId)
    },

    stopRun(runId: RunId): Promise<void> {
      calls.push({ op: 'stopRun', args: [runId] })
      return Promise.resolve()
    },

    onEvent(listener: WorkspaceEventListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    lastRun(): RunId {
      const last = started.at(-1)
      if (last === undefined) throw new Error('no run has been started')
      return last.runId
    },

    output(runId, chunk) {
      emit({ type: 'run_output', runId, chunk })
    },

    end(runId, exitCode) {
      emit(exitCode === undefined ? { type: 'run_ended', runId } : { type: 'run_ended', runId, exitCode })
    }
  }

  return service
}
