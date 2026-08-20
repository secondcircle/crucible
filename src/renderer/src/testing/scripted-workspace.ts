import type {
  RunId,
  Unsubscribe,
  WorkspaceEvent,
  WorkspaceEventListener,
  WorkspaceService,
  WorktreeCreation
} from '../../../shared/workspace/service'
import { rankFiles } from '../../../shared/workspace/match'

// Answers the way main does but streams nothing by itself, so a component
// test is about rendering rather than about timing.
export interface ScriptedWorkspace extends WorkspaceService {
  readonly calls: ReadonlyArray<{ readonly op: string; readonly args: readonly unknown[] }>
  /** What `searchFiles` ranks and answers from. */
  files: readonly string[]
  /** Every run this service was asked to start, oldest first. */
  readonly started: ReadonlyArray<{ readonly runId: RunId; readonly command: string }>
  /** What `isGitWorkspace` answers for any folder. */
  git: boolean
  // Held open until the test settles it, so the creating state stays put for
  // as long as the assertions need it.
  settleWorktree(created: WorktreeCreation): void
  /** How many creations are still waiting to be settled. */
  creating(): number
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
  const worktrees: Array<(created: WorktreeCreation) => void> = []
  let minted = 0

  function emit(event: WorkspaceEvent): void {
    for (const listener of [...listeners]) listener(event)
  }

  const service: ScriptedWorkspace = {
    calls,
    files,
    started,

    git: true,

    searchFiles(directory: string, query: string): Promise<readonly string[]> {
      calls.push({ op: 'searchFiles', args: [directory, query] })
      return Promise.resolve(rankFiles(service.files, query))
    },

    isGitWorkspace(workspacePath: string): Promise<boolean> {
      calls.push({ op: 'isGitWorkspace', args: [workspacePath] })
      return Promise.resolve(service.git)
    },

    createWorktree(workspacePath: string): Promise<WorktreeCreation> {
      calls.push({ op: 'createWorktree', args: [workspacePath] })
      return new Promise<WorktreeCreation>((resolve) => {
        worktrees.push(resolve)
      })
    },

    startRun(directory: string, command: string): Promise<RunId> {
      calls.push({ op: 'startRun', args: [directory, command] })
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

    settleWorktree(created: WorktreeCreation): void {
      const settle = worktrees.shift()
      if (settle === undefined) throw new Error('no worktree creation is waiting')
      settle(created)
    },

    creating: () => worktrees.length,

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
