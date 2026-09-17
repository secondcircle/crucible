// What one compaction is, as facts: what asked for it and what it did. This
// module imports nothing, because the agent port carries these and the port
// is the one module the renderer shares with main.

/** What fired a compaction, which is what the transcript block states. */
export type CompactionTrigger =
  /** The conversation crossed the size in the setting. */
  | 'threshold'
  // The conversation reached the model's own window with the switch off, or
  // with a threshold set above that window. The last resort: without it the
  // conversation would error on every send from here.
  | 'windowEdge'
  /** Quiet long enough that the prompt cache is about to lapse. */
  | 'idle'

/** What the transcript block states about one compaction. */
export interface CompactionRecord {
  readonly trigger: CompactionTrigger
  readonly tokensBefore: number
  readonly tokensAfter: number
}
