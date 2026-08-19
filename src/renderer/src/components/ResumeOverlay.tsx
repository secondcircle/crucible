import { useEffect, useState } from 'react'
import type { HistoryMatch } from '../../../shared/agent/port'
import { relativeTime } from '../labels'
import './overlay.css'

/**
 * Resume: the one place adapter-managed history is looked at, and only while
 * this overlay is open (A23, RES-2).
 *
 * The search runs on the query as it changes, scoped to the active workspace,
 * and a result shows a display-safe preview and a relative time — never a path,
 * a filename or anything else about how the conversation is stored (RES-3,
 * A28). Choosing one hands its opaque ref back and the shell does the rest.
 *
 * The overlay closes on Escape through the shell's precedence rule, not here,
 * so closing it never touches live work (RES-6).
 */
export function ResumeOverlay({
  onSearch,
  onChoose,
  onClose
}: {
  readonly onSearch: (query: string) => Promise<readonly HistoryMatch[]>
  readonly onChoose: (ref: string) => void
  readonly onClose: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<readonly HistoryMatch[]>([])
  const [failure, setFailure] = useState<string | undefined>(undefined)

  useEffect(() => {
    let current = true
    onSearch(query)
      .then((found) => {
        if (current) {
          setResults(found)
          setFailure(undefined)
        }
      })
      .catch((cause: unknown) => {
        if (current) setFailure(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      current = false
    }
  }, [query, onSearch])

  return (
    <div className="overlaybg" onMouseDown={onClose}>
      <div
        className="overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Resume session"
        onMouseDown={(clicked) => clicked.stopPropagation()}
      >
        <div className="osearch">
          <span aria-hidden="true">⌕</span>
          <input
            aria-label="Search conversations"
            placeholder="Search this workspace's conversations…"
            autoFocus
            value={query}
            onChange={(changed) => setQuery(changed.target.value)}
          />
        </div>

        {failure === undefined ? null : (
          <p className="ofail" role="alert">
            {failure}
          </p>
        )}

        <ul className="results">
          {results.map((match) => (
            <li key={match.ref}>
              <button onClick={() => onChoose(match.ref)}>
                <span className="preview">{match.preview}</span>
                <span className="when">{relativeTime(match.at)}</span>
              </button>
            </li>
          ))}
          {results.length === 0 && failure === undefined ? (
            <li className="noresults">No conversation matches that.</li>
          ) : null}
        </ul>

        <div className="ofoot">
          <kbd>esc</kbd> closes
        </div>
      </div>
    </div>
  )
}
