import type { TranscriptItem } from '../agent/port'
import { compactionInstruction, readCompactionReply } from './prompt.ts'

// A compaction, whole: what to ask the model for, and what the model's answer
// becomes. A session's agent, the orchestrator and a workflow node all get the
// same compaction and none of them owns a variant.

export interface CompactionPlan {
  /** The one user message of a request that stands on its own. */
  readonly instruction: string
}

// The previous compaction's summary goes into the document ahead of the
// messages that followed it, so the next summary is written over both and
// summaries never stack.
export function planCompaction(
  previousSummary: string | undefined,
  aged: readonly TranscriptItem[]
): CompactionPlan {
  return {
    instruction: compactionInstruction({
      ...(previousSummary === undefined ? {} : { previousSummary }),
      items: aged
    })
  }
}

export interface SettledCompaction {
  /** What the model reads in place of the compacted span. */
  readonly text: string
}

// The model's answer turned into the window. Absent when the model wrote
// nothing, so the caller fails instead and the conversation is left as it
// was. Nothing the model wrote is cut: the summary is as long as it made it.
export function settleCompaction(
  _plan: CompactionPlan,
  reply: string
): SettledCompaction | undefined {
  const summary = readCompactionReply(reply)
  return summary === undefined ? undefined : { text: summary }
}
