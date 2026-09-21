import type { TranscriptItem } from '../agent/port'
import { compactionInstruction, readCompactionReply } from './prompt.ts'
import {
  pruneSkeleton,
  renderSkeleton,
  skeletonOf,
  skeletonTokens,
  trimSkeleton,
  type SkeletonLine
} from './skeleton.ts'
import { estimateTokens, skeletonBudgetTokens } from './window.ts'

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
// numbered, and the newly aged lines continue its numbering.
export function planCompaction(
  previous: CompactionState | undefined,
  aged: readonly TranscriptItem[]
): CompactionPlan {
  const carried = previous?.skeleton ?? []
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
// account at all: a compaction without one would leave the agent with a list
// of handles and no idea what it was doing, so the caller fails instead and
// the conversation is left as it was.
//
// The account is kept whole, however long the model ran. It was asked for a
// length, and the budget in `window.ts` assumes it kept to one, but nothing
// the model writes is cut: the end of an account is where what comes next and
// the files that matter live, and a build before this one sliced exactly that
// off a summary that ran long. The skeleton is what the mechanical rules size,
// and only the parts of it that can be got back from disk.
export function settleCompaction(
  plan: CompactionPlan,
  reply: string,
  // The model's own window, where the caller knows it: the skeleton has to fit
  // inside what the compaction just made room in, and on a small model the
  // wide-window budget is most of it.
  contextWindow?: number
): SettledCompaction | undefined {
  const { trajectory, strike } = readCompactionReply(reply)
  if (trajectory === '') return undefined
  const skeleton = trimSkeleton(
    pruneSkeleton(plan.lines, strike),
    skeletonBudgetTokens(contextWindow)
  )
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

