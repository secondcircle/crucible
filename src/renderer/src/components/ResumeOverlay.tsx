import { useEffect, useState } from 'react'
import type { HistoryMatch } from '../../../shared/agent/port'
import { relativeTime } from '../labels'
import './overlay.css'

// The one place adapter-managed history is looked at. A result shows a preview
// and a time, never a path or anything else about how it is stored.
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
