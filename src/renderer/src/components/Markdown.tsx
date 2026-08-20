import { createElement, type ReactNode } from 'react'
import './markdown.css'

// Written by hand rather than pulled in so that no string from an agent can
// become markup: no HTML is parsed here, and no sanitizer can be misconfigured.
export function Markdown({ markdown }: { markdown: string }): React.JSX.Element {
  return <div className="markdown">{blocks(markdown)}</div>
}

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

const INLINE =
  /(`+)([\s\S]+?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\n]+?)\*|_([^_\n]+?)_|\[([^\]]*)\]\(([^)\s]+)\)/g

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let index = 0
  let key = 0

  INLINE.lastIndex = 0
  for (let match = INLINE.exec(text); match !== null; match = INLINE.exec(text)) {
    if (match.index > index) out.push(text.slice(index, match.index))
    const [whole, , code, strong, strongToo, emphasis, emphasisToo, label, href] = match

    if (code !== undefined) out.push(<code key={key++}>{code}</code>)
    else if (strong !== undefined) out.push(<strong key={key++}>{strong}</strong>)
    else if (strongToo !== undefined) out.push(<strong key={key++}>{strongToo}</strong>)
    else if (emphasis !== undefined) out.push(<em key={key++}>{emphasis}</em>)
    else if (emphasisToo !== undefined) out.push(<em key={key++}>{emphasisToo}</em>)
    else if (href !== undefined) out.push(link(label, href, key++))
    else out.push(whole)

    index = match.index + whole.length
  }
  if (index < text.length) out.push(text.slice(index))
  return out
}

/** An address the OS browser can be handed, or the text it was written as. */
function link(label: string, href: string, key: number): ReactNode {
  const safe = /^(https?:|mailto:)/i.test(href)
  if (!safe) return `[${label}](${href})`
  return (
    <a key={key} href={href} target="_blank" rel="noreferrer noopener">
      {label === '' ? href : label}
    </a>
  )
}
