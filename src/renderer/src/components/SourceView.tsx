import { useLayoutEffect, useMemo, useRef } from 'react'
import { highlight, type TokenKind } from '../files/highlight'
import './source-view.css'

// A file as it is written: numbered lines, colored by the pure highlighter.
// Read-only, like everything the file tree leads to.

const CLASS: Readonly<Record<TokenKind, string>> = {
  plain: '',
  keyword: 'tok-key',
  string: 'tok-str',
  comment: 'tok-com',
  number: 'tok-num',
  type: 'tok-typ'
}

export function SourceView({
  text,
  extension,
  line
}: {
  readonly text: string
  /** Lowercase and without the dot; what the coloring follows. */
  readonly extension: string
  // The 1-based line a `path:42` click asked for, marked and scrolled to.
  // Absent for a file opened without one.
  readonly line?: number
}): React.JSX.Element {
  const lines = useMemo(() => highlight(text, extension), [text, extension])
  const marked = useRef<HTMLDivElement>(null)

  // Before paint, so a file opened at a line is never shown at its top first.
  // The click is what scrolls, never the disk: a file re-read while it is
  // being written must not pull the reader back off what they are reading.
  // `scrollIntoView` is absent under jsdom, where there is no layout to move.
  useLayoutEffect(() => {
    marked.current?.scrollIntoView?.({ block: 'center' })
  }, [line])

  return (
    <pre className="src">
      {lines.map((tokens, index) => (
        // Index as key: a line's identity here is its number, and the whole
        // block is replaced whenever the text changes.
        <div
          className={index + 1 === line ? 'ln hl' : 'ln'}
          key={index}
          ref={index + 1 === line ? marked : undefined}
        >
          <span className="n" aria-hidden="true">
            {index + 1}
          </span>
          <span className="lt">
            {tokens.map((token, at) => (
              <span key={at} className={CLASS[token.kind]}>
                {token.text}
              </span>
            ))}
          </span>
        </div>
      ))}
    </pre>
  )
}

/** How many lines the header states. An empty file has none. */
export function lineCount(text: string): number {
  if (text === '') return 0
  // A file ending in a newline has no line after it, which is what every
  // editor's line count says too.
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
}
