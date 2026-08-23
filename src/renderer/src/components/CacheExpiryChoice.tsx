import { useEffect, useRef, useState } from 'react'
import type { CachedPrefix } from '../../../shared/agent/port'
import { idleMs } from '../cache/expiry'
import { compactTokens, idleText, rebillText, retentionText } from '../cache/format'
import './cache-expiry.css'
import './overlay.css'

// The cache expiry choice: three facts, two doors, and a footer that names
// the way out. It exists to make what this send costs visible, so the
// dollars are never rounded away and never hidden behind a threshold.
//
// Escape belongs to the shell, which knows what else is on screen and in what
// order. Enter and S are this dialog's own, read on the dialog itself, which
// takes focus as it opens. On the document they would hear the very Enter
// that raised the dialog: a send is a discrete event, so React renders this
// component and runs its effects before that keydown finishes bubbling to the
// document, and one press would both open the choice and answer it.

export function CacheExpiryChoice({
  prefix,
  now,
  summarizing,
  note,
  onSendAnyway,
  onSummarize,
  onDismiss
}: {
  readonly prefix: CachedPrefix
  /** The instant the send was pressed: the idle time is measured from it. */
  readonly now: number
  /** The whole wait while π writes the summary, up from the press itself. */
  readonly summarizing: boolean
  /** π's own retry narration, which replaces the subtitle while it stands. */
  readonly note?: string
  readonly onSendAnyway: () => void
  readonly onSummarize: () => void
  /** Back to the composer, message kept. Never offered mid-summary. */
  readonly onDismiss: () => void
}): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const tokens = compactTokens(prefix.tokens)
  const rebill = rebillText(prefix.rebillDollars)

  // A backdrop click cannot dismiss a summary that is already spending money
  // — stopping it is Escape's decision alone — but a click that lands on
  // nothing teaches the user that clicks go nowhere, so the footer that names
  // the way out lights up. A count rather than a flag, so a second click
  // replays the light.
  const [refused, setRefused] = useState(0)

  // Focus goes to the dialog rather than to a button: with a button focused
  // the browser turns Enter into a click of it, and one press would send
  // twice.
  useEffect(() => {
    box.current?.focus()
  }, [])

  const title = summarizing
    ? 'Summarizing the conversation'
    : 'The cache for this conversation has expired'

  return (
    <div
      className="overlaybg"
      onMouseDown={() => {
        if (summarizing) setRefused((clicks) => clicks + 1)
        else onDismiss()
      }}
    >
      <div
        className="dialog expirydialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={box}
        onMouseDown={(clicked) => clicked.stopPropagation()}
        onKeyDown={(pressed) => {
          if (summarizing) return
          if (pressed.metaKey || pressed.ctrlKey || pressed.altKey) return
          if (pressed.key === 'Enter') {
            pressed.preventDefault()
            onSendAnyway()
            return
          }
          if (pressed.key === 's' || pressed.key === 'S') {
            pressed.preventDefault()
            onSummarize()
          }
        }}
      >
        <div className="ehead">
          <h3>{title}</h3>
          <p className="esub">
            {summarizing
              ? (note ??
                `Reading ${tokens} tokens once. Your message goes out the moment this lands.`)
              : 'Sending now re-bills the whole conversation as new input. Nothing is wrong — it has just been sitting longer than the cache lives.'}
          </p>
        </div>

        {summarizing ? (
          // A bar that claims no precision and an estimate that says it is
          // one: the wait is π's, and Crucible knows nothing about its
          // progress.
          <div className="ework">
            <span className="spin" aria-hidden="true" />
            <span className="ebar" aria-hidden="true">
              <i />
            </span>
            <span className="eeta">~15s</span>
          </div>
        ) : (
          <>
            <div className="efacts">
              <div className="efact">
                <span className="k">Idle</span>
                <b className="warn">{idleText(idleMs(prefix, now))}</b>
              </div>
              <div className="efact">
                <span className="k">In context</span>
                <b>{tokens}</b>
              </div>
              <div className="efact">
                <span className="k">Re-bill</span>
                <b className="warn">~{rebill}</b>
              </div>
            </div>

            <div className="edoors">
              {/* The default, because the message was already typed and that
                  was the intent: the dialog informs rather than herds. */}
              <button className="edoor primary" onClick={onSendAnyway}>
                <span className="eic" aria-hidden="true">
                  ▶
                </span>
                <span className="etext">
                  <span className="et">
                    Send anyway <kbd>⏎</kbd>
                  </span>
                  <span className="ed">
                    Keep every message. Pay to re-cache the prefix now, and carry all {tokens} on
                    every turn from here.
                  </span>
                </span>
                <span className="eprice">+{rebill}</span>
              </button>

              <button className="edoor" onClick={onSummarize}>
                <span className="eic" aria-hidden="true">
                  ↯
                </span>
                <span className="etext">
                  <span className="et">
                    Summarize, then continue <kbd>S</kbd>
                  </span>
                  <span className="ed">
                    Read the conversation once, carry a summary forward, and send your message
                    against a small base. The full history stays in the session tree.
                  </span>
                </span>
                {/* The summary's size is not knowable beforehand, so the tag
                    says the order of magnitude and nothing more. */}
                <span className="eprice good">~2k after</span>
              </button>
            </div>
          </>
        )}

        {/* Keyed by the count so a repeat click remounts the footer and the
            one-shot light runs again. */}
        <div className={refused > 0 ? 'efoot lit' : 'efoot'} key={refused}>
          <kbd>esc</kbd>
          {summarizing
            ? 'cancel — the conversation is left exactly as it was'
            : 'back to the composer, message kept'}
          <span className="espacer" />
          {summarizing ? null : <span>retention {retentionText(prefix.retention)}</span>}
        </div>
      </div>
    </div>
  )
}
