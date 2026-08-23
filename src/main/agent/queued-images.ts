import type {
  ImageAttachment,
  QueuedEntry,
  QueuedKind,
  QueueState
} from '../../shared/agent/port'

// π's queue is reported and handed back as text, so the pictures a queued
// message carries wait here, per session, until that message leaves.

export interface PairedQueue extends QueueState {
  // π drops a message from its list immediately before delivering it, so what
  // this memory no longer sees listed is on its way into the transcript.
  readonly left: readonly QueuedEntry[]
}

export interface QueuedImages {
  // The call handed back forgets the message again, for one π refused: the
  // pairing is by position, and an extra entry would shift every later picture.
  add(kind: QueuedKind, text: string, images?: readonly ImageAttachment[]): () => void
  // Anything π no longer lists has left the queue for good.
  pair(steering: readonly string[], followUp: readonly string[]): PairedQueue
  // Read before clearing π's queue: the clear is itself a queue event, and
  // would empty this first.
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
      // Identity, not text: `pair` replaces every entry it keeps, so an entry
      // still in the list by reference is one π has never reported.
      return () => {
        if (kind === 'steering') steering = steering.filter((held) => held !== entry)
        else followUp = followUp.filter((held) => held !== entry)
      }
    },

    pair(reportedSteering, reportedFollowUp) {
      const pairedSteering = align(reportedSteering, steering)
      const pairedFollowUp = align(reportedFollowUp, followUp)
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

export function withImages(
  texts: readonly string[],
  held: readonly QueuedEntry[]
): readonly QueuedEntry[] {
  return align(texts, held).entries
}

// Paired by position rather than by text, because π rewrites a message on its
// way in and the text it reports is not the text it was handed. The two lists
// are one FIFO queue, aligned at the tail, filled in lockstep.
function align(
  texts: readonly string[],
  held: readonly QueuedEntry[]
): { readonly entries: readonly QueuedEntry[]; readonly left: readonly QueuedEntry[] } {
  const dropped = held.length - texts.length
  const entries = texts.map((text, at): QueuedEntry => {
    // A message this memory never saw carries no pictures, and says so.
    const images = dropped + at < 0 ? undefined : held[dropped + at]?.images
    return images === undefined ? { text } : { text, images }
  })
  return { entries, left: held.slice(0, Math.max(dropped, 0)) }
}
