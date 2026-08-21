import { useEffect, useState } from 'react'
import type { CacheHealth } from '../../../shared/cache/service'
import { homePath, missesText, retentionSource, retentionText, spanStartFull } from '../cache/format'
import './cache-strip.css'
import './overlay.css'

// The cache health view: four facts, a path and three buttons. No list of
// misses — the ledger's reader is an agent, and a human scrolling a thousand
// JSONL lines was never the point.
//
// Every input here names its feedback (ADR 0010): Reset disables in the
// click's frame, Investigate says it is working, and Copy path says it
// copied.

/** Long enough to read, short enough that the button is a button again. */
const COPIED_MS = 1400

export function CacheHealthView({
  health,
  workspaceOpen,
  onReset,
  onInvestigate,
  onCopy,
  onClose
}: {
  readonly health: CacheHealth
  /** Investigate starts a session, so with no workspace it cannot act. */
  readonly workspaceOpen: boolean
  /** Appends a reset line; deletes nothing. Resolves when the ledger answers. */
  readonly onReset: () => Promise<void>
  // Creates the session, activates it and sends the opening prompt. Rejects
  // display-safely, and the dialog stays open holding the sentence.
  readonly onInvestigate: () => Promise<void>
  readonly onCopy: (path: string) => void
  readonly onClose: () => void
}): React.JSX.Element {
  const [resetting, setResetting] = useState(false)
  const [investigating, setInvestigating] = useState(false)
  const [copied, setCopied] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!copied) return
    const clear = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(clear)
  }, [copied])

  function reset(): void {
    if (resetting) return
    // Disabled in this frame; the numbers below re-date when the ledger has
    // written the line.
    setResetting(true)
    setFailure(undefined)
    void onReset()
      .catch((cause: unknown) => {
        setFailure(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => setResetting(false))
  }

  function investigate(): void {
    if (investigating || !workspaceOpen) return
    setInvestigating(true)
    setFailure(undefined)
    void onInvestigate()
      // The dialog closes on success, so nothing re-enables that button: the
      // session it made is already on screen.
      .catch((cause: unknown) => {
        setFailure(cause instanceof Error ? cause.message : String(cause))
        setInvestigating(false)
      })
  }

  return (
    <div className="overlaybg" onMouseDown={onClose}>
      <div
        className="dialog cachedialog"
        role="dialog"
        aria-modal="true"
        aria-label="Cache health"
        onMouseDown={(clicked) => clicked.stopPropagation()}
      >
        <div className="dh">Cache health</div>
        <div className="dbody">
          <div className="cfacts">
            <div className="cfact">
              <b>{health.count}</b>
              <span>{health.count === 1 ? 'miss' : 'misses'}</span>
            </div>
            <div className="cfact">
              <b className="money">${health.dollars.toFixed(2)}</b>
              <span>re-billed</span>
            </div>
            <div className="cfact">
              <b>{spanStartFull(health.since)}</b>
              <span>counting since</span>
            </div>
          </div>

          {failure === undefined ? (
            <p className="cprose">
              Every miss Crucible has ever seen is in the ledger, across every workspace and
              every run. The counter above runs from your last reset; the file goes back
              further.
            </p>
          ) : (
            <p className="failure" role="alert">
              {failure}
            </p>
          )}

          {/* The machine's entry point, shown whole rather than summarized:
              this dialog is 520px wide for exactly this line. */}
          <div className="cpath">
            {/* The absolute path is what Copy writes and what the title
                holds; the home directory is shortened so the rest of it
                renders whole. */}
            <code title={health.ledgerPath}>{homePath(health.ledgerPath)}</code>
            <button
              className="btn cpcopy"
              onClick={() => {
                setCopied(true)
                onCopy(health.ledgerPath)
              }}
            >
              {copied ? 'Copied' : 'Copy path'}
            </button>
          </div>

          {/* The setting the whole experiment exists to answer, beside the
              bill it is being measured against. */}
          <p className="cretention">
            Retention in force · <b>{retentionText(health.retention)}</b> (
            {retentionSource(health.retention)})
          </p>

          {workspaceOpen ? null : (
            <p className="cretention">
              Investigate needs a workspace open — it starts a session there.
            </p>
          )}
        </div>

        <div className="dfoot">
          <button className="btn cghost" disabled={resetting} onClick={reset}>
            {resetting ? 'Resetting…' : 'Reset counter'}
          </button>
          <span className="dspacer" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button
            className="btn primary"
            disabled={investigating || !workspaceOpen}
            title={
              workspaceOpen
                ? `Start a session on the ${missesText(health.count)} since your last reset`
                : 'Open a workspace first — an investigation runs in a session of its own'
            }
            onClick={investigate}
          >
            {investigating ? 'Starting…' : 'Investigate'}
          </button>
        </div>
      </div>
    </div>
  )
}
