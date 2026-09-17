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
import { estimateTokens, SKELETON_BUDGET_TOKENS, SUMMARY_BUDGET_TOKENS } from './window.ts'

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
export function settleCompaction(
  plan: CompactionPlan,
  reply: string
): SettledCompaction | undefined {
  const { trajectory, strike } = readCompactionReply(reply)
  if (trajectory === '') return undefined
  const skeleton = trimSkeleton(pruneSkeleton(plan.lines, strike), SKELETON_BUDGET_TOKENS)
  return {
    text: compactionText(clipToBudget(trajectory, SUMMARY_BUDGET_TOKENS), skeleton),
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
        'One numbered line each, oldest first. The results were dropped, not lost: every ' +
        'file named is on disk and every command named can be run again.\n\n' +
        renderSkeleton(skeleton)
    )
  }
  return parts.join('\n\n')
}

// A model that ignored the word count is clipped rather than refused: a long
// account is still an account, and the budget is what keeps the window from
// being one.
function clipToBudget(text: string, budget: number): string {
  const limit = budget * 4
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…`
}
