// Preload and main have to agree letter for letter here, like every other
// channel pair.

import type { WorkflowRunEvent } from './service'

export const WORKFLOW_RUN_REQUEST_CHANNEL = 'crucible:workflow-runs:request'

export const WORKFLOW_RUN_EVENT_CHANNEL = 'crucible:workflow-runs:event'

// The name is the service method's own, so there is no second vocabulary.
export interface WorkflowRunRequest {
  readonly op: string
  readonly args: readonly unknown[]
}

// A value rather than a throw, because Electron rewraps a handler's throw and
// hides the sentence written for a person.
export type WorkflowRunResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string }

export type { WorkflowRunEvent }
