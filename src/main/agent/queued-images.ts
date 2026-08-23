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
  // A message just handed to π's queue, and whatever rides with it. The call
  // handed back takes it out again, for a message π refused: it never reached
  // the queue, and a memory one entry longer than π's queue would put every
  // later picture on the message before it. Once π has reported the queue the
  // message is genuinely in it, and the call then does nothing.
  add(kind: QueuedKind, text: string, images?: readonly ImageAttachment[]): () => void
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

/** π's list of texts, holding the pictures each of those messages came with. */
export function withImages(
  texts: readonly string[],
  held: readonly QueuedEntry[]
): readonly QueuedEntry[] {
  return align(texts, held).entries
}

// Paired by position rather than by text, because π's text is not the text it
// was handed: `steer()` expands a `/skill:name` message into the skill's body,
// and a `/name` that matches one of π's prompt templates into that template,
// before pushing anything. Position holds where text does not, because the two
// lists are one queue filled in lockstep — `queueInto` remembers a message
// immediately before handing it over, and π pushes it with nothing awaited in
// between. They are aligned at the tail, where a new message arrives with this
// memory already holding it; π only ever removes from the head, its queue being
// FIFO and the list it reports having lost the delivered text's first
// occurrence. Whatever π reports for an entry becomes that entry's text here:
// that is the text π will deliver it under, hand back on a flush, and name it
// by in a dequeue.
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
