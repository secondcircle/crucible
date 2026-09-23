import { createElement, memo, type ReactNode } from 'react'
import { isLocalAddress } from '../../../shared/agent/local-address'
import { useNamedPath } from '../files/path-links'
import { AddressButton, PathButton } from './PathLink'
import { isWebAddress, webAddressIn } from './web-address'
import './markdown.css'

// Written by hand rather than pulled in so that no string from an agent can
// become markup: no HTML is parsed here, and no sanitizer can be misconfigured.
// Memoized on the one string it takes: the parse is pure, and everything that
// renders markdown sits inside a document that re-renders on every port
// event. An open artifact of a megabyte used to be re-parsed 6.7 times a
// second while a run progressed, for a document that had not changed.
export const Markdown = memo(function Markdown({
  markdown
}: {
  markdown: string
}): React.JSX.Element {
  return <div className="markdown">{blocks(markdown)}</div>
})

/** A line that opens a block of its own, which is where a paragraph stops. */
const BLOCK_START = /^\s*(```|#{1,6}\s|[-*+]\s|\d+\.\s|>\s?|\||(-{3,}|\*{3,}|_{3,})\s*$)/

function blocks(source: string): ReactNode[] {
  const lines = source.split('\n')
  const out: ReactNode[] = []
  let at = 0
  let key = 0

  while (at < lines.length) {
    const line = lines[at]

    if (line.trim() === '') {
      at += 1
      continue
    }

    // Fenced code. An unclosed fence runs to the end of the reply, which is
    // what a streaming block looks like before its closing fence arrives.
    if (/^\s*```/.test(line)) {
      const body: string[] = []
      at += 1
      while (at < lines.length && !/^\s*```/.test(lines[at])) {
        body.push(lines[at])
        at += 1
      }
      if (at < lines.length) at += 1
      out.push(
        <pre key={key++}>
          <code>{body.join('\n')}</code>
        </pre>
      )
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      out.push(createElement(`h${heading[1].length}`, { key: key++ }, inline(heading[2])))
      at += 1
      continue
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(<hr key={key++} />)
      at += 1
      continue
    }

    // A table is a pipe row followed by a separator row; anything else that
    // starts with a pipe is just a paragraph.
    if (line.trim().startsWith('|') && isSeparator(lines[at + 1])) {
      const header = cells(line)
      at += 2
      const rows: string[][] = []
      while (at < lines.length && lines[at].trim().startsWith('|')) {
        rows.push(cells(lines[at]))
        at += 1
      }
      out.push(
        <table key={key++}>
          <thead>
            <tr>
              {header.map((cell, index) => (
                <th key={index}>{inline(cell)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, index) => (
                  <td key={index}>{inline(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )
      continue
    }

    const bullet = /^\s*[-*+]\s+/
    const numbered = /^\s*\d+\.\s+/
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line)
      const marker = ordered ? numbered : bullet
      const items: string[] = []
      while (at < lines.length && marker.test(lines[at])) {
        items.push(lines[at].replace(marker, ''))
        at += 1
      }
      out.push(
        createElement(
          ordered ? 'ol' : 'ul',
          { key: key++ },
          items.map((item, index) => <li key={index}>{inline(item)}</li>)
        )
      )
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = []
      while (at < lines.length && /^\s*>\s?/.test(lines[at])) {
        quoted.push(lines[at].replace(/^\s*>\s?/, ''))
        at += 1
      }
      out.push(<blockquote key={key++}>{inline(quoted.join(' '))}</blockquote>)
      continue
    }

    const paragraph: string[] = []
    while (at < lines.length && lines[at].trim() !== '' && !BLOCK_START.test(lines[at])) {
      paragraph.push(lines[at])
      at += 1
    }
    if (paragraph.length === 0) {
      // A line that looks like a block start but matched no block above: keep
      // it rather than loop forever on it.
      paragraph.push(lines[at])
      at += 1
    }
    out.push(<p key={key++}>{inline(paragraph.join(' '))}</p>)
  }

  return out
}

function isSeparator(line: string | undefined): boolean {
  return line !== undefined && /^\s*\|?[\s:|-]*-[\s:|-]*$/.test(line) && line.includes('-')
}

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

// A bare address runs to the next space, quote or angle bracket; where the
// sentence around it takes some of that back is `webAddressIn`'s call.
const INLINE =
  /(`+)([\s\S]+?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\n]+?)\*|_([^_\n]+?)_|\[([^\]]*)\]\(([^)\s]+)\)|\b(https?:\/\/[^\s<>`"]+)/g

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let index = 0
  let key = 0

  // A copy per call, because bold and emphasis parse their own insides and a
  // shared pattern's position would be trampled by the nested call.
  const pattern = new RegExp(INLINE)
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match.index > index) out.push(text.slice(index, match.index))
    const [whole, , code, strong, strongToo, emphasis, emphasisToo, label, href, bare] = match
    let taken = whole.length

    if (code !== undefined) out.push(<CodeSpan key={key++} text={code} />)
    else if (strong !== undefined) out.push(<strong key={key++}>{inline(strong)}</strong>)
    else if (strongToo !== undefined) out.push(<strong key={key++}>{inline(strongToo)}</strong>)
    else if (emphasis !== undefined) out.push(<em key={key++}>{inline(emphasis)}</em>)
    else if (emphasisToo !== undefined) out.push(<em key={key++}>{inline(emphasisToo)}</em>)
    else if (href !== undefined) out.push(<Link key={key++} label={label} href={href} />)
    else if (bare !== undefined) {
      const address = webAddressIn(bare)
      if (address === undefined) out.push(whole)
      else {
        out.push(
          <WebAddress key={key++} address={address} look="link">
            {address}
          </WebAddress>
        )
        // What the sentence took back is read again as the text it is.
        taken = address.length
        pattern.lastIndex = match.index + taken
      }
    } else out.push(whole)

    index = match.index + taken
  }
  if (index < text.length) out.push(text.slice(index))
  return out
}

// A path in backticks is a file the moment the disk says it is one, and a web
// address in backticks is a link whatever the disk says; every other code span
// is the code span it always was.
function CodeSpan({ text }: { readonly text: string }): React.JSX.Element {
  const named = useNamedPath(text)
  if (named !== undefined) {
    return (
      <PathButton named={named} look="code">
        {text}
      </PathButton>
    )
  }
  if (isWebAddress(text)) {
    return (
      <WebAddress address={text} look="code">
        {text}
      </WebAddress>
    )
  }
  return <code>{text}</code>
}

// Three doors and no fourth: the context panel for a file this agent named
// and for a local address, the OS browser for every other web address, and
// the text as written for anything else — nothing else is ever handed out.
function Link({
  label,
  href
}: {
  readonly label: string
  readonly href: string
}): React.JSX.Element {
  const named = useNamedPath(href)
  const shown = label === '' ? href : label

  if (named !== undefined) {
    return (
      <PathButton named={named} look="link">
        {shown}
      </PathButton>
    )
  }
  if (!/^(https?:|mailto:)/i.test(href)) return <>{`[${label}](${href})`}</>
  return (
    <WebAddress address={href} look="link">
      {shown}
    </WebAddress>
  )
}

// One rule for every way an agent can write an address: the panel is what a
// page served on this machine is for, and every other address keeps going to
// the browser, where the user's logins are.
function WebAddress({
  address,
  look,
  children
}: {
  readonly address: string
  readonly look: 'code' | 'link'
  readonly children: ReactNode
}): React.JSX.Element {
  if (isLocalAddress(address)) {
    return (
      <AddressButton address={address} look={look}>
        {children}
      </AddressButton>
    )
  }
  return (
    <a href={address} target="_blank" rel="noreferrer noopener">
      {look === 'code' ? <code>{children}</code> : children}
    </a>
  )
}
