import type {
  RunId,
  Unsubscribe,
  WorkspaceEventListener,
  WorkspaceService
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
    searchFiles: (workspacePath: string, query: string) =>
      call<readonly string[]>('searchFiles', workspacePath, query),
    startRun: (workspacePath: string, command: string) =>
      call<RunId>('startRun', workspacePath, command),
    stopRun: (runId: RunId) => call<void>('stopRun', runId),

    onEvent(listener: WorkspaceEventListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
