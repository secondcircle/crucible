import type { TranscriptItem, Unsubscribe } from '../../../shared/agent/port'
import type { ArtifactView, RunsSnapshot } from '../../../shared/workflows/service'
import type {
  WorkflowRunListener,
  WorkflowRunService
} from '../../../shared/workflows/service'
import { workflowRunsBridge } from '../bridge'

// The renderer's side of the workflow-run channel. It holds no state: the
// engine's records are the truth and every event carries a whole snapshot.

export function createWorkflowRunClient(): WorkflowRunService {
  const bridge = workflowRunsBridge()
  const listeners = new Set<WorkflowRunListener>()

  bridge.onEvent((event) => {
    for (const listener of [...listeners]) listener(event)
  })

  async function call<T>(op: string, ...args: readonly unknown[]): Promise<T> {
    const result = await bridge.request({ op, args })
    if (!result.ok) throw new Error(result.message)
    return result.value as T
  }

  return {
    snapshot: () => call<RunsSnapshot>('snapshot'),

    onEvent(listener: WorkflowRunListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    pause: (runId: string) => call<void>('pause', runId),
    resume: (runId: string) => call<void>('resume', runId),
    cancel: (runId: string) => call<void>('cancel', runId),
    dismiss: (runId: string) => call<void>('dismiss', runId),
    adopt: (runId: string, sessionId: string) => call<void>('adopt', runId, sessionId),
    nodeTranscript: (runId: string, nodeId: string) =>
      call<readonly TranscriptItem[]>('nodeTranscript', runId, nodeId),
    artifact: (runId: string, path: string) => call<ArtifactView>('artifact', runId, path),
    revealArtifact: (runId: string, path: string) =>
      call<void>('revealArtifact', runId, path)
  }
}
