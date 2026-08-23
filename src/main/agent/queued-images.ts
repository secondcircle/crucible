import type {
  ImageAttachment,
  QueuedEntry,
  QueuedKind,
  QueueState
} from '../../shared/agent/port'

// π's `steer()` and `followUp()` take images, but its queue is reported and
// handed back as text. So the pictures wait here, per session, and are paired
// back onto π's own lists whenever the queue is read.

export interface QueuedImages {
  /** A message just handed to π's queue, and whatever rides with it. */
  add(kind: QueuedKind, text: string, images?: readonly ImageAttachment[]): void
  // π's two lists, paired back up with what was handed over, and kept as the
  // new memory: anything π no longer lists has left the queue for good.
  pair(steering: readonly string[], followUp: readonly string[]): QueueState
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
      steering = withImages(reportedSteering, steering)
      followUp = withImages(reportedFollowUp, followUp)
      return { steering, followUp }
    },

    take() {
      const held = { steering, followUp }
      steering = []
      followUp = []
      return held
    }
  }
}

// Matched by text, first unclaimed first, because two queued messages may hold
// the same words with different pictures and π's order is the one that counts.
export function withImages(
  texts: readonly string[],
  held: readonly QueuedEntry[]
): readonly QueuedEntry[] {
  const unclaimed = [...held]
  return texts.map((text) => {
    const at = unclaimed.findIndex((entry) => entry.text === text)
    if (at === -1) return { text }
    const [claimed] = unclaimed.splice(at, 1)
    return claimed ?? { text }
  })
}
