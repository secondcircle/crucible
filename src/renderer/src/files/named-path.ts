import type { FileView } from '../../../shared/agent/port'

// What a piece of an agent's text could be naming: a file, and the line it
// asked for. Pure syntax — whether the file is there is the disk's answer, and
// this module never asks it. A candidate is cheap to reject and a rejection
// costs no round trip, which is why the shape is checked before the disk is.

/** A path an agent's text names, with the line a `path:42` suffix asked for. */
export interface NamedPath {
  /** The path as written, suffix stripped: what is checked and what is opened. */
  readonly path: string
  /** The 1-based line the suffix named, when it named one. */
  readonly line?: number
}

/** `path`, `path:42` or `path:42:7`; the column is read and dropped. */
const WITH_LINE = /^(.*?):(\d+)(?::\d+)?$/

// What a word has to look like before it is worth a stat: a separator in it,
// or an extension on the end. Applied to a word plucked out of a longer line
// and nowhere else — see `pathPieces`.
const SEPARATED = /[/\\]/
const EXTENDED = /[^./\\]\.[A-Za-z0-9]{1,8}$/

// `https:`, `mailto:`, `javascript:` and anything else with a scheme belong to
// the web door. Two characters at least, so a Windows drive letter is a path
// rather than a scheme.
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]+:/

/**
 * The file this text names, or nothing when it cannot be naming one. Text with
 * whitespace in it is not a candidate: a path with a space is rarer than a
 * command with one, and a false link is worse than a missing one.
 *
 * Nothing here rules on what a file name looks like. A whole code span or a
 * whole href is one thing the agent pointed at, so existence is the only
 * question worth asking about it, and asking is what makes `Makefile`,
 * `.gitignore` and `LICENSE` open like every other file. A span that names no
 * file — `panel_show`, a commit hash like `8dd033a` — costs the one stat the
 * disk answers no to, and stays the code span it was.
 */
export function namedPath(text: string): NamedPath | undefined {
  if (text === '' || /\s/.test(text)) return undefined
  const suffix = WITH_LINE.exec(text)
  const path = suffix === null ? text : suffix[1]
  const line = suffix === null ? undefined : Number(suffix[2])
  if (path === '' || SCHEME.test(path)) return undefined
  // A trailing separator is a folder however it is spelled, and folders are
  // not links.
  if (/[/\\]$/.test(path)) return undefined
  return line === undefined || line < 1 ? { path } : { path, line }
}

/**
 * The file a single word of a longer line names. Stricter than a whole span by
 * the shape rule above, because the words here are every word of every bash
 * command a row header summarizes: without it `npm`, `test`, `&&` and `-rf`
 * each cost a stat, for lines that arrive by the hundred in a working session.
 */
function namedWord(word: string): NamedPath | undefined {
  const named = namedPath(word)
  if (named === undefined) return undefined
  if (!SEPARATED.test(named.path) && !EXTENDED.test(named.path)) return undefined
  return named
}

// How a click in a message opens what its text named: at the line the text
// asked for, and otherwise in the view the file's kind renders — which is
// rendered markdown or HTML, and source for everything else.
export function viewOf(named: NamedPath): FileView {
  return named.line === undefined ? { kind: 'rendered' } : { kind: 'source', line: named.line }
}

/** One stretch of plain text, or one path named inside it. */
export type TextPiece =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'path'; readonly text: string; readonly named: NamedPath }

/**
 * Plain text split into what a tool chain row header draws: the words it
 * says, and the paths among them. Split on whitespace alone, because a row
 * header is a tool's own summary — `Read src/foo.ts` — rather than prose.
 */
export function pathPieces(text: string): readonly TextPiece[] {
  // A summary of one word is not a sentence with a word taken out of it: it is
  // the whole of what the call names, the way a code span is, so it goes to
  // the disk on existence alone and `read Makefile` links like `read
  // src/foo.ts`. Text with whitespace in it never gets this far.
  const whole = namedPath(text)
  if (whole !== undefined) return [{ kind: 'path', text, named: whole }]

  const pieces: TextPiece[] = []
  let plain = ''
  // The separators are captured so the text can be put back exactly as it was
  // written; each of them is whitespace, which names no path.
  for (const word of text.split(/(\s+)/)) {
    const named = namedWord(word)
    if (named === undefined) {
      plain += word
      continue
    }
    if (plain !== '') pieces.push({ kind: 'text', text: plain })
    plain = ''
    pieces.push({ kind: 'path', text: word, named })
  }
  if (plain !== '') pieces.push({ kind: 'text', text: plain })
  return pieces
}
