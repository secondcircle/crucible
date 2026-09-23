// Shared extractors: `crucible:rule/extract` in the design.

import { createHash } from 'node:crypto'
import type { EditEvent, Item } from './rule.ts'
import { withTree } from './syntax.ts'

export interface CommentBlock {
  /** 0-based first and last rows. */
  start: number
  end: number
  /** The comment as written, markers and all. */
  raw: string
  /** Markers stripped and whitespace collapsed: the identity used to tell new from old. */
  text: string
  /** True when the comment shares its first line with code (`x = 1 // why`). */
  trailing: boolean
}

// Tool directives, not prose a reader is meant to read.
const directive =
  /^(eslint-|@ts-|prettier-ignore|istanbul |c8 |v8 |#region|#endregion|<reference|biome-ignore|@vitest-environment|@jsx|global )/

export function normalize(raw: string): string {
  return raw
    .replace(/^\/\*\*?|\*\/$/g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*(\/\/+|\*)\s?/, '').trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Every comment in a file, with consecutive own-line `//` comments grouped into one block. */
export async function commentBlocks(path: string, text: string): Promise<CommentBlock[]> {
  const nodes =
    (await withTree(path, text, (p) =>
      p
        .query('(comment) @c')
        .captures(p.tree.rootNode)
        .map((c) => ({ row: c.node.startPosition.row, col: c.node.startPosition.column, endRow: c.node.endPosition.row, text: c.node.text })),
    )) ?? []
  const lines = text.split('\n')
  const blocks: CommentBlock[] = []
  for (const node of nodes) {
    const { row, col } = node
    const trailing = (lines[row] ?? '').slice(0, col).trim() !== ''
    const raw = node.text
    const prev = blocks.at(-1)
    const joinable =
      prev &&
      !prev.trailing &&
      !trailing &&
      raw.startsWith('//') &&
      prev.raw.startsWith('//') &&
      prev.end === row - 1
    if (joinable) {
      prev.end = node.endRow
      prev.raw += '\n' + raw
      prev.text = normalize(prev.raw)
    } else {
      blocks.push({ start: row, end: node.endRow, raw, text: normalize(raw), trailing })
    }
  }
  return blocks.filter((b) => b.text !== '' && !directive.test(b.text) && !b.raw.startsWith('#!'))
}

export interface AddedCommentOptions {
  /** Lines of code after the comment to include. */
  following?: number
  /** Lines of code before the comment to include. */
  preceding?: number
}

/**
 * The comments an edit added or reworded: blocks in `after` whose text is not in `before`.
 * An edit that adds none returns an empty list, and the rule is over for that edit.
 */
export async function addedComments(event: EditEvent, opts: AddedCommentOptions = {}): Promise<Item[]> {
  const following = opts.following ?? 12
  const preceding = opts.preceding ?? 4
  const old = new Set((event.before ? await commentBlocks(event.path, event.before) : []).map((b) => b.text))
  const lines = event.after.split('\n')
  const items: Item[] = []
  for (const b of await commentBlocks(event.path, event.after)) {
    if (old.has(b.text)) continue
    const before = lines.slice(Math.max(0, b.start - preceding), b.start).join('\n')
    // A trailing comment's own line is the code it speaks about.
    const after = lines.slice(b.trailing ? b.start : b.end + 1, b.end + 1 + following).join('\n')
    items.push({
      key: createHash('sha1').update(`${event.path}\0${b.text}`).digest('hex').slice(0, 12),
      path: event.path,
      line: b.start + 1,
      state: {
        file: event.path,
        comment: b.raw,
        preceding_code: before,
        following_code: after,
      },
      meta: { text: b.text, lines: b.raw.split('\n').filter((l) => normalize(l) !== '').length, trailing: b.trailing },
    })
  }
  return items
}
