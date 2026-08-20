// Preload and main have to agree letter for letter here too, and a mismatch is
// silent until an operation goes unanswered in a running app.
//
// One channel, not two: the command service answers questions and announces
// nothing. Every `list` and `expand` reads the folders fresh (CMD-8), so there
// is no cached state anyone would have to be told about.

export const COMMAND_REQUEST_CHANNEL = 'crucible:commands:request'

// The name is the service method's own, so there is no second vocabulary and
// no mapping table to keep in step.
export interface CommandRequest {
  readonly op: string
  readonly args: readonly unknown[]
}

// A value rather than a throw, because Electron rewraps a handler's throw into
// "Error invoking remote method …", hiding the sentence written for a person.
export type CommandResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string }
