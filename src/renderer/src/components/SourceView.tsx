import { useMemo } from 'react'
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
  extension
}: {
  readonly text: string
  /** Lowercase and without the dot; what the coloring follows. */
  readonly extension: string
}): React.JSX.Element {
  const lines = useMemo(() => highlight(text, extension), [text, extension])

  return (
    <pre className="src">
      {lines.map((tokens, index) => (
        // Index as key: a line's identity here is its number, and the whole
        // block is replaced whenever the text changes.
        <div className="ln" key={index}>
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
