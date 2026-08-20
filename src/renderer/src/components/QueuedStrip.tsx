import type { QueuedKind, QueueState } from '../../../shared/agent/port'
import './queued-strip.css'

// What is queued and not yet delivered, and nothing else: an undelivered
// message is never shown in the transcript as if it were part of the
// conversation. The strip renders from the snapshot, so it follows the active
// session and is still there after switching away and back.
export function QueuedStrip({
  queue,
  onDequeue
}: {
  readonly queue: QueueState
  readonly onDequeue: (kind: QueuedKind, text: string) => void
}): React.JSX.Element {
  return (
    <div className="queue" aria-label="Queued messages">
      {entriesOf(queue).map((entry, index) => (
        // Two entries can hold the same words, so position within the strip is
        // what names one.
        <button
          key={`${entry.kind}-${index}`}
          className="qitem"
          onClick={() => onDequeue(entry.kind, entry.text)}
        >
          <span className={`qkind ${entry.kind === 'steering' ? 'steer' : 'follow'}`}>
            {label(entry.kind)}
          </span>
          <span className="qtext">{entry.text}</span>
          <span className="qhint">queued · click or ⌥↑ to edit</span>
        </button>
      ))}
    </div>
  )
}

export interface QueuedEntry {
  readonly kind: QueuedKind
  readonly text: string
}

// Steering before follow-ups, each in queue order: the two queues π keeps are
// the two the strip shows, and neither interleaves into the other.
export function entriesOf(queue: QueueState): readonly QueuedEntry[] {
  return [
    ...queue.steering.map((text): QueuedEntry => ({ kind: 'steering', text })),
    ...queue.followUp.map((text): QueuedEntry => ({ kind: 'followUp', text }))
  ]
}

export function label(kind: QueuedKind): string {
  return kind === 'steering' ? 'steer' : 'follow-up'
}
