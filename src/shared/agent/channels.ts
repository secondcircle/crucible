/**
 * The two IPC channel names the agent channel is built on, and the envelope
 * that travels on the request one.
 *
 * The names are the one fact the preload surface and the main-process handler
 * have to agree on letter for letter, and a mismatch between them is silent in
 * TypeScript and invisible until an operation goes unanswered in a running app
 * — so both spellings live here, and neither side writes the string itself.
 *
 * This module imports nothing, like the port's type module beside it, and the
 * renderer never sees it: the channel names stay behind the preload surface,
 * and the IPC client knows `window.crucible.agent`, not a channel.
 */

/** Invoke: one port operation goes out, one result envelope comes back. */
export const REQUEST_CHANNEL = 'crucible:request'

/** Send: main pushes one port event per message at the window. */
export const EVENT_CHANNEL = 'crucible:event'

/**
 * One port operation, named and with its arguments, as it crosses the process
 * boundary. The name is the port method's own, so there is no second vocabulary
 * to learn and no mapping table to keep in step.
 */
export interface PortRequest {
  readonly op: string
  readonly args: readonly unknown[]
}

/**
 * What comes back. A refusal is a value rather than a throw, because Electron
 * rewraps a handler's throw into "Error invoking remote method …" — which would
 * put IPC plumbing in front of a sentence written for a person. The IPC client
 * turns a refusal back into a rejection with exactly the message main chose.
 */
export type PortResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string }
