import type { TranscriptItem } from '../../../shared/agent/port'
import type { RunRecord } from '../../../shared/workflows/run'
import type {
  WorkflowRunListener,
  WorkflowRunService
} from '../../../shared/workflows/service'

// Answers the run seam the way main does but moves nothing by itself: a test
// changes the records and the event goes out whole, like the engine's.
export interface ScriptedWorkflowRuns extends WorkflowRunService {
  readonly calls: ReadonlyArray<{ readonly op: string; readonly args: readonly string[] }>
  /** Replaces the records and announces the new snapshot. */
  setRuns(runs: readonly RunRecord[]): void
  /** ⌘R the way main announces it after intercepting the chord. */
  emitToggle(): void
  /** What `nodeTranscript` answers with, keyed `runId:nodeId`. */
  readonly transcripts: Map<string, readonly TranscriptItem[]>
}

export function createScriptedWorkflowRuns(
  initial: readonly RunRecord[] = []
): ScriptedWorkflowRuns {
  let runs = initial
  const listeners = new Set<WorkflowRunListener>()
  const calls: Array<{ op: string; args: string[] }> = []
  const transcripts = new Map<string, readonly TranscriptItem[]>()

  return {
    calls,
    transcripts,

    setRuns(next: readonly RunRecord[]): void {
      runs = next
      for (const listener of [...listeners]) listener({ type: 'runs', snapshot: { runs } })
    },

    emitToggle(): void {
      for (const listener of [...listeners]) listener({ type: 'toggle-overview' })
    },

    async snapshot() {
      return { runs }
    },

    onEvent(listener: WorkflowRunListener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async pause(runId: string) {
      calls.push({ op: 'pause', args: [runId] })
    },

    async resume(runId: string) {
      calls.push({ op: 'resume', args: [runId] })
    },

    async cancel(runId: string) {
      calls.push({ op: 'cancel', args: [runId] })
    },

    async nodeTranscript(runId: string, nodeId: string) {
      calls.push({ op: 'nodeTranscript', args: [runId, nodeId] })
      return transcripts.get(`${runId}:${nodeId}`) ?? []
    }
  }
}
