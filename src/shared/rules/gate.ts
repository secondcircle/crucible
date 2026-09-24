// The seam every agent loop's hooks call: the SDK adapter's π extension, a
// node session's, and the fake adapter's scripted edits. Behind it are the
// rule host, the judge, the ledger and the delivery rules; in front of it is
// only what an agent just did and what it should read about that. Marks are
// not returned here: they are read back from the ledger by tool call id, so a
// reloaded transcript shows exactly what a live one did.

/** A note that missed the tool result and is delivered at the next tool boundary. */
export interface RuleNote {
  readonly firingId: string
  readonly rule: string
  /** Exactly what the agent reads. */
  readonly text: string
}

/** Who an event came from, and the checkout its paths are relative to. */
export type RuleAgent =
  | { readonly kind: 'session'; readonly sessionId: string; readonly cwd: string }
  | {
      readonly kind: 'node'
      readonly runId: string
      readonly nodeId: string
      readonly workflow: string
      readonly cwd: string
    }

/** What a watch needs of the agent loop it sits in. */
export interface RuleDelivery {
  /** A note that missed its tool result: deliver it at the next tool boundary. */
  steer(note: RuleNote): void
}

/** What resolved in time to ride in the tool result itself. */
export interface Appended {
  /** Text to add to the end of the tool result, starting with its own separator. */
  readonly appendix?: string
}

export interface RuleWatch {
  /** A turn or a node began: a checkpoint diffs from here. */
  turnStarted(): Promise<void>
  /** A bash call about to run; a `block` refuses it with this text as the reason. */
  beforeBash(call: { readonly callId: string; readonly command: string }): Promise<{ readonly block?: string }>
  /** A bash call that ran, which may have made a commit. */
  afterBash(call: { readonly callId: string; readonly command: string }): Promise<Appended>
  /** An edit or a write that landed. */
  afterEdit(call: {
    readonly callId: string
    readonly tool: string
    readonly path: string
    readonly before: string | null
    readonly after: string
  }): Promise<Appended>
  /** What the agent said, which is half of what it did next. */
  said(text: string): void
  /** The turn ended or the node is completing: `hold` refuses completion with this text. */
  checkpoint(at: 'turn-end' | 'node-complete'): Promise<{ readonly hold?: string }>
}

export interface RuleGate {
  watch(agent: RuleAgent, delivery: RuleDelivery): RuleWatch
}

/** The separator an inline note is appended after. */
export const APPENDIX_GAP = '\n\n'

/** The tool output without the inline notes that were appended to it. */
export function withoutAppendix(output: string, reads: readonly string[]): string {
  let text = output
  for (const read of [...reads].reverse()) {
    const tail = `${APPENDIX_GAP}${read}`
    if (text.endsWith(tail)) text = text.slice(0, text.length - tail.length)
  }
  return text
}
