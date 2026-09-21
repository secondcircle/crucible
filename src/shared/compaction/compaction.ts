import type { TranscriptItem } from '../agent/port'
import { compactionInstruction, readCompactionReply } from './prompt.ts'
import {
  pruneSkeleton,
  reclassifySkeleton,
  renderSkeleton,
  skeletonOf,
  skeletonTokens,
  type SkeletonLine
} from './skeleton.ts'
import { estimateTokens } from './window.ts'

// A compaction, whole: what to ask the model for, and what the model's answer
// becomes. Everything that decides what the window looks like afterwards is
// here, so a session's agent, the orchestrator and a workflow node all get the
// same compaction and none of them owns a variant.

// Kept with the compaction so the next one can prune what this one wrote
// rather than rebuilding it from messages that are no longer in the window.
export interface CompactionState {
  readonly skeleton: readonly SkeletonLine[]
}

export interface CompactionPlan {
  /** Appended to the conversation as it stands, so it reads the warm cache. */
  readonly instruction: string
  /** The merged skeleton the model's strike numbers are against. */
  readonly lines: readonly SkeletonLine[]
}

// The previous skeleton is carried whole: it is already in the model's window,
// numbered, and the newly aged lines continue its numbering. Carried as this
// build reads it, not as the build that stored it did: a line's kind decides
// how the model is told to treat it, and an older build's kinds are not this
// one's.
export function planCompaction(
  previous: CompactionState | undefined,
  aged: readonly TranscriptItem[]
): CompactionPlan {
  const carried = reclassifySkeleton(previous?.skeleton ?? [])
  const fresh = skeletonOf(aged)
  return {
    instruction: compactionInstruction({ aged: fresh, carried: carried.length }),
    lines: [...carried, ...fresh]
  }
}

export interface SettledCompaction {
  /** What the model reads in place of the compacted span. */
  readonly text: string
  readonly state: CompactionState
}

// The model's answer turned into the window. Absent when the model wrote no
// account, or not all of one: a compaction without an account would leave the
// agent with a list of handles and no idea what it was doing, and one with a
// cut account would replace a whole account with its first paragraphs. The
// caller fails instead and the conversation is left as it was.
//
// Nothing the model wrote is cut and nothing it kept is trimmed. The account
// is kept whole however long it ran: its end is where what comes next and the
// files that matter live. The skeleton is what the model left after striking
// what it judged dead, and no rule of size second-guesses it. A build before
// this one trimmed the skeleton to a budget, oldest first, sparing the user's
// lines; on a skeleton whose protected lines alone were over the budget that
// dropped every reply and every call and left a list of nothing but what had
// been said to the agent.
export function settleCompaction(
  plan: CompactionPlan,
  reply: string
): SettledCompaction | undefined {
  const { trajectory, strike } = readCompactionReply(reply)
  if (trajectory === '') return undefined
  const skeleton = pruneSkeleton(plan.lines, strike)
  return {
    text: compactionText(trajectory, skeleton),
    state: { skeleton }
  }
}

/** What the window would cost, which is what the transcript block reports. */
export function compactionTokens(settled: SettledCompaction): number {
  return estimateTokens(settled.text)
}

export function skeletonSize(state: CompactionState): number {
  return skeletonTokens(state.skeleton)
}

function compactionText(trajectory: string, skeleton: readonly SkeletonLine[]): string {
  const parts = [`## Where we are\n\n${trajectory}`]
  if (skeleton.length > 0) {
    parts.push(
      '## What happened before this point\n\n' +
        'One numbered line each, oldest first. What was dropped is not lost: every file ' +
        'named is on disk, every command named can be run again, and every run or question ' +
        'named has its record.\n\n' +
        renderSkeleton(skeleton)
    )
  }
  return parts.join('\n\n')
}
