import type {
  ImageAttachment,
  QueuedEntry,
  QueuedKind,
  QueueState
} from '../../shared/agent/port'

// π's `steer()` and `followUp()` take images, but its queue is reported and
// handed back as text. So the pictures wait here, per session, and are paired
// back onto π's own lists whenever the queue is read.

/** π's queue as this memory reads it, and what dropped out of it. */
export interface PairedQueue extends QueueState {
  // Remembered messages π no longer lists, oldest first. π drops a message
  // from its list immediately before delivering it, so this is what is on its
  // way into the transcript. It is this memory's answer because this memory
  // holds the pairing rule; a second rule elsewhere could only disagree.
  readonly left: readonly QueuedEntry[]
}

export interface QueuedImages {
  /** A message just handed to π's queue, and whatever rides with it. */
  add(kind: QueuedKind, text: string, images?: readonly ImageAttachment[]): void
  // π's two lists, paired back up with what was handed over, and kept as the
  // new memory: anything π no longer lists has left the queue for good.
  pair(steering: readonly string[], followUp: readonly string[]): PairedQueue
  // What is held now, with the memory emptied. Read before clearing π's queue,
  // because clearing it is itself a queue event and would empty this first.
  take(): QueueState
}

export function createQueuedImages(): QueuedImages {
  let steering: readonly QueuedEntry[] = []
  let followUp: readonly QueuedEntry[] = []

  return {
    add(kind, text, images) {
      const entry: QueuedEntry =
        images === undefined || images.length === 0 ? { text } : { text, images: [...images] }
      if (kind === 'steering') steering = [...steering, entry]
      else followUp = [...followUp, entry]
    },

    pair(reportedSteering, reportedFollowUp) {
      const pairedSteering = claim(reportedSteering, steering)
      const pairedFollowUp = claim(reportedFollowUp, followUp)
      steering = pairedSteering.entries
      followUp = pairedFollowUp.entries
      return {
        steering,
        followUp,
        left: [...pairedSteering.left, ...pairedFollowUp.left]
      }
    },

    take() {
      const held = { steering, followUp }
      steering = []
      followUp = []
      return held
    }
  }
}

/** π's list of texts, holding the pictures each of those messages came with. */
export function withImages(
  texts: readonly string[],
  held: readonly QueuedEntry[]
): readonly QueuedEntry[] {
  return claim(texts, held).entries
}

// Matched by text, and from the end, because two queued messages may hold the
// same words with different pictures. A message leaves π's queue by being
// delivered, and the oldest of a run goes first: π's queue is FIFO, and the
// list it reports afterwards has lost its *first* occurrence of that text. So
// the occurrences still listed are the younger ones, and claiming from the end
// is what keeps each remaining row on its own picture. Where the texts are all
// distinct this is the same pairing reading forwards would give.
function claim(
  texts: readonly string[],
  held: readonly QueuedEntry[]
): { readonly entries: readonly QueuedEntry[]; readonly left: readonly QueuedEntry[] } {
  const unclaimed: (QueuedEntry | undefined)[] = [...held]
  const entries: QueuedEntry[] = []
  for (let at = texts.length - 1; at >= 0; at -= 1) {
    const text = texts[at]
    let found: QueuedEntry | undefined
    for (let candidate = unclaimed.length - 1; candidate >= 0; candidate -= 1) {
      const entry = unclaimed[candidate]
      if (entry?.text !== text) continue
      found = entry
      unclaimed[candidate] = undefined
      break
    }
    // A message this memory never saw carries no pictures, and says so.
    entries[at] = found ?? { text }
  }
  return {
    entries,
    left: unclaimed.filter((entry): entry is QueuedEntry => entry !== undefined)
  }
}
