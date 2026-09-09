import type {
  ConnectOutcome,
  ResearchOutcome,
  ResearchStatus
} from '../../../shared/workspace/research'
import type {
  IssueBoardAnswer,
  RunId,
  Unsubscribe,
  WorkspaceEventListener,
  WorkspaceService,
  WorktreeCreation
} from '../../../shared/workspace/service'
import { workspaceBridge } from '../bridge'

// The renderer's side of the workspace channel. It holds no state: the runs
// and the folders are main's.

export function createWorkspaceClient(): WorkspaceService {
  const workspace = workspaceBridge()
  const listeners = new Set<WorkspaceEventListener>()

  workspace.onEvent((event) => {
    for (const listener of [...listeners]) listener(event)
  })

  async function call<T>(op: string, ...args: readonly unknown[]): Promise<T> {
    const result = await workspace.request({ op, args })
    if (!result.ok) throw new Error(result.message)
    return result.value as T
  }

  return {
    searchFiles: (directory: string, query: string) =>
      call<readonly string[]>('searchFiles', directory, query),
    isGitWorkspace: (workspacePath: string) =>
      call<boolean>('isGitWorkspace', workspacePath),
    createWorktree: (workspacePath: string) =>
      call<WorktreeCreation>('createWorktree', workspacePath),
    startRun: (directory: string, command: string) => call<RunId>('startRun', directory, command),
    stopRun: (runId: RunId) => call<void>('stopRun', runId),
    issueBoard: (workspacePath: string) => call<IssueBoardAnswer>('issueBoard', workspacePath),
    openUrl: (url: string) => call<void>('openUrl', url),

    researchStatus: () => call<ResearchStatus>('researchStatus'),
    // Absent rather than a placeholder: no key is the browser flow, and the
    // channel refuses anything here that is not text.
    researchConnect: (apiKey?: string) =>
      apiKey === undefined
        ? call<ConnectOutcome>('researchConnect')
        : call<ConnectOutcome>('researchConnect', apiKey),
    researchCancelConnect: () => call<void>('researchCancelConnect'),
    researchDisconnect: () => call<ResearchOutcome>('researchDisconnect'),

    onEvent(listener: WorkspaceEventListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
