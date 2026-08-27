// The seam the run surfaces are driven through: the renderer sees this
// interface and nothing behind it, so a component test hands in a fake and
// the IPC client implements the same shape over the preload bridge.

import type { SessionId, TranscriptItem, Unsubscribe } from '../agent/port'
import type { RunTools } from '../agent/run-tools'
import type { ArtifactKind } from './artifacts'
import type { RunRecord, WorkflowRunId } from './run'

/** One artifact as the artifact reader receives it. */
export interface ArtifactView {
  readonly kind: ArtifactKind
  // Present for markdown and text; absent for html, which rides the exhibit
  // frame and never enters the renderer as a string.
  readonly body?: string
  readonly bytes: number
  /** File mtime, ISO; the reader's time when the record has no `writtenAt`. */
  readonly modifiedAt?: string
}

export interface RunsSnapshot {
  /** Every run the app knows, newest first. The record outlives the run. */
  readonly runs: readonly RunRecord[]
}

export type WorkflowRunEvent =
  // The whole state after any change, like the port's `state` event: nothing
  // is patched, so a dropped frame self-heals on the next one.
  | { readonly type: 'runs'; readonly snapshot: RunsSnapshot }
  // ⌘R, taken in main before the menu can spend it on reload; the renderer
  // hears it here and toggles the global runs view.
  | { readonly type: 'toggle-overview' }

export type WorkflowRunListener = (event: WorkflowRunEvent) => void

export interface WorkflowRunService {
  snapshot(): Promise<RunsSnapshot>
  /** Live-only: no replay, no backlog. */
  onEvent(listener: WorkflowRunListener): Unsubscribe

  // The run view's mechanical buttons. Everything conversational goes through
  // the orchestrator instead.
  pause(runId: WorkflowRunId): Promise<void>
  // Total over the two stopped states: a paused run un-pauses, an interrupted
  // one re-runs the node the app quit cut down, from that node's beginning, in
  // the same worktree. Every other status is refused with a sentence.
  resume(runId: WorkflowRunId): Promise<void>
  cancel(runId: WorkflowRunId): Promise<void>

  // Clears a run that asks for attention it no longer deserves: it changes
  // where the run sits and no other field of the record. Refuses a live run
  // with a sentence; dismissing twice is a quiet no-op.
  dismiss(runId: WorkflowRunId): Promise<void>

  // Makes a session the run's orchestrator, live or settled: every later
  // message arrives there and crucible_runs lists the run for it. This moves
  // the orchestrator's seat, never the rule that messages travel through one.
  // Refuses an unknown run with a sentence.
  adopt(runId: WorkflowRunId, sessionId: SessionId): Promise<void>

  // A node's transcript in the chat pane's own shape, read at call time:
  // the run view renders it with the same code the chat does.
  nodeTranscript(runId: WorkflowRunId, nodeId: string): Promise<readonly TranscriptItem[]>

  // Reads one artifact of one run. Rejects honestly when the path is not in
  // the run's record or the file cannot be read.
  artifact(runId: WorkflowRunId, path: string): Promise<ArtifactView>
  /** Reveals the file in the OS file manager. Same gate, same honesty. */
  revealArtifact(runId: WorkflowRunId, path: string): Promise<void>
}

/** A fire from the schedule surface: a workflow, in a workspace, and nothing else. */
export interface ScheduledFireRequest {
  readonly workspacePath: string
  readonly workflow: string
}

// What main holds beyond the channel: the tool behaviors the adapters mount
// on composed agents, and the ⌘R toggle main's key interception fires.
export interface MainWorkflowRunService extends WorkflowRunService {
  readonly tools: RunTools
  // Consulted once at the start of every user turn of a session, after the
  // turn is claimed and before its prompt is dispatched: it delivers whatever
  // that session is owed about its runs, and answers with the status block the
  // model must see and no surface may show — or nothing, when nothing changed.
  turnStart(sessionId: SessionId): string | undefined
  // Starts a run from the schedule surface: no session, no inputs, branched
  // from the trunk tip fetched fresh, and marked scheduled. It never crosses
  // to the renderer — the schedule seam is what the board asks.
  startScheduled(fire: ScheduledFireRequest): Promise<RunRecord>
  /** Emits `toggle-overview` to every listener; main calls it on ⌘R. */
  toggleOverview(): void
  dispose(): void
}
