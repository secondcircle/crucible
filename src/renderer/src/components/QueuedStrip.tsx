import type { QueuedKind, QueuedMessage, QueueState } from '../../../shared/agent/port'
import './queued-strip.css'

/** Past this the row says how many more rather than drawing them. */
const THUMBNAILS = 3

// Undelivered messages live here and never in the transcript, which would read
// as if they were already part of the conversation.
export function QueuedStrip({
  queue,
  onDequeue
}: {
  readonly queue: QueueState
  readonly onDequeue: (kind: QueuedKind, text: string) => void
}): React.JSX.Element {
  return (
    <div className="queue" aria-label="Queued messages">
      {entriesOf(queue).map((entry, index) => {
        const images = entry.images ?? []
        return (
          // Two entries can hold the same words, so position within the strip
          // is what names one.
          <button
            key={`${entry.kind}-${index}`}
            className="qitem"
            onClick={() => onDequeue(entry.kind, entry.text)}
          >
            <span className={`qkind ${entry.kind === 'steering' ? 'steer' : 'follow'}`}>
              {label(entry.kind)}
            </span>
            {/* Empty alternative text on purpose: the row's accessible name
                stays the badge and the words. */}
            {images.length === 0 ? null : (
              <span className="qthumbs">
                {images.slice(0, THUMBNAILS).map((image, at) => (
                  <img
                    key={at}
                    className="qthumb"
                    src={`data:${image.mimeType};base64,${image.data}`}
                    alt=""
                  />
                ))}
              </span>
            )}
            {images.length > THUMBNAILS ? (
              <span className="qmore">+{images.length - THUMBNAILS}</span>
            ) : null}
            <span className="qtext">{entry.text}</span>
            <span className="qhint">queued · click or ⌥↑ to edit</span>
          </button>
        )
      })}
    </div>
  )
}

// Steering before follow-ups, each in queue order: the two queues π keeps are
// the two the strip shows, and neither interleaves into the other.
export function entriesOf(queue: QueueState): readonly QueuedMessage[] {
  return [
    ...queue.steering.map((entry): QueuedMessage => ({ kind: 'steering', ...entry })),
    ...queue.followUp.map((entry): QueuedMessage => ({ kind: 'followUp', ...entry }))
  ]
}

export function label(kind: QueuedKind): string {
  return kind === 'steering' ? 'steer' : 'follow-up'
}
