import { renderSkeleton, type SkeletonLine } from './skeleton.ts'

// What the model is asked for at a compaction, and how its answer is read.
// The request is appended to the conversation as it already stands, so the
// model reads its own work from the warm cache and only these words are new
// input.

export interface CompactionRequest {
  /** Lines aged out since the last compaction, in order. */
  readonly aged: readonly SkeletonLine[]
  /** How many lines the skeleton in the window already holds. */
  readonly carried: number
}

export function compactionInstruction({ aged, carried }: CompactionRequest): string {
  const numbering =
    carried === 0
      ? 'Here is that skeleton, one numbered line per thing that happened:'
      : 'The skeleton opens this conversation, numbered. These lines join the end of it:'

  return [
    'This conversation is about to be compacted. Everything except the last stretch of it ' +
      'leaves your context and is replaced by what you write now, so write for yourself: ' +
      'the same agent, picking this work up cold, with nothing else of the conversation in ' +
      'front of you. What you drop you can still reach — every file is on disk and every ' +
      'command can be run again — but you will not know to look for it unless you say so here.',
    'Write two things.',
    'WHERE WE ARE. Where this work stands, in prose: the goal as it is now, the decisions ' +
      'that hold, what was tried and abandoned and why it was abandoned, what is in flight, ' +
      'what comes next, and the few files that matter now. Name the abandoned approaches — ' +
      'left out, they get retried. Aim under 1,200 words.',
    'DEAD LINES. Beside your account the conversation survives as a skeleton: what was said, ' +
      'verbatim, and one line per tool call naming what it touched. ' +
      numbering,
    renderSkeleton(aged, carried + 1),
    'Give the numbers of the lines that no longer bear on the work — an exploration that ' +
      'went nowhere, a question your account now answers, a check whose result you have just ' +
      'written down. A line you are unsure about stays. A line carrying something the user ' +
      'said stays unless you are certain it is spent.',
    'Answer with exactly this and nothing around it:',
    '<trajectory>\nyour account\n</trajectory>\n<strike>numbers, comma separated; ranges ' +
      'like 12-20 are fine; leave it empty if nothing is dead</strike>'
  ].join('\n\n')
}

export interface CompactionReply {
  /** Empty when the model wrote nothing usable, which the caller treats as a failure. */
  readonly trajectory: string
  /** 1-based line numbers, deduplicated and in order. */
  readonly strike: readonly number[]
}

export function readCompactionReply(text: string): CompactionReply {
  return {
    trajectory: (block(text, 'trajectory') ?? '').trim(),
    strike: readStrike(block(text, 'strike') ?? '')
  }
}

function block(text: string, tag: string): string | undefined {
  const opened = text.indexOf(`<${tag}>`)
  if (opened === -1) return undefined
  const closed = text.indexOf(`</${tag}>`, opened)
  const from = opened + tag.length + 2
  return closed === -1 ? text.slice(from) : text.slice(from, closed)
}

// Numbers and `a-b` ranges, however they are separated. A range written
// backwards is read the way it was plainly meant.
function readStrike(text: string): readonly number[] {
  const struck = new Set<number>()
  for (const match of text.matchAll(/(\d+)\s*(?:-|–|—|to)\s*(\d+)|(\d+)/g)) {
    const [, from, to, single] = match
    if (single !== undefined) {
      struck.add(Number(single))
      continue
    }
    if (from === undefined || to === undefined) continue
    const low = Math.min(Number(from), Number(to))
    const high = Math.max(Number(from), Number(to))
    // A wild range would strike the whole skeleton on one bad digit.
    if (high - low > 5_000) continue
    for (let at = low; at <= high; at += 1) struck.add(at)
  }
  return [...struck].sort((left, right) => left - right)
}
