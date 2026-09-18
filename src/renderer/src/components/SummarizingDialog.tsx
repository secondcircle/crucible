import { useEffect, useRef, useState } from 'react'
import './cache-expiry.css'
import './overlay.css'

// The wait while a model rewrites what a conversation's context is: the cache
// expiry choice's summarize door and a compaction both put this up, because
// they are the same wait with the same way out. A bar that claims no
// precision and an estimate that says it is one — the time is the model's and
// Crucible knows nothing about its progress.

export function SummarizingDialog({
  title,
  subtitle,
  footer
}: {
  readonly title: string
  /** One line under the title; the caller owns the words. */
  readonly subtitle: string
  /** What Escape does, stated beside the key. */
  readonly footer: string
}): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)

  // A backdrop click cannot dismiss work that is already spending money —
  // stopping it is Escape's decision alone — but a click that lands on nothing
  // teaches the user that clicks go nowhere, so the footer that names the way
  // out lights up. A count rather than a flag, so a second click replays it.
  const [refused, setRefused] = useState(0)

  // Focus on the dialog rather than on any control: there is nothing here to
  // press, and Escape is read by the window.
  useEffect(() => {
    box.current?.focus()
  }, [])

  return (
    <div className="overlaybg" onMouseDown={() => setRefused((clicks) => clicks + 1)}>
      <div
        className="dialog expirydialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={box}
        onMouseDown={(clicked) => clicked.stopPropagation()}
      >
        <div className="ehead">
          <h3>{title}</h3>
          <p className="esub">{subtitle}</p>
        </div>

        <div className="ework">
          <span className="spin" aria-hidden="true" />
          <span className="ebar" aria-hidden="true">
            <i />
          </span>
          <span className="eeta">~15s</span>
        </div>

        {/* Keyed by the count so a repeat click remounts the footer and the
            one-shot light runs again. */}
        <div className={refused > 0 ? 'efoot lit' : 'efoot'} key={refused}>
          <kbd>esc</kbd>
          {footer}
        </div>
      </div>
    </div>
  )
}
