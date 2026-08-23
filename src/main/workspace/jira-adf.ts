// Jira descriptions and comments arrive as ADF, Atlassian's document tree. The
// reading pane renders markdown, so the tree is converted here — best-effort by
// design: a node this build does not know contributes its plain text rather
// than vanishing, because a dropped paragraph is worse than an unstyled one.

interface AdfNode {
  readonly type?: unknown
  readonly text?: unknown
  readonly attrs?: unknown
  readonly content?: unknown
  readonly marks?: unknown
}

/** Beyond this the document is not being read, it is being escaped from. */
const MAX_DEPTH = 12

export function adfToMarkdown(document: unknown): string {
  const node = asNode(document)
  if (node === undefined) return ''
  return blocks(children(node), 0).join('\n\n').trim()
}

function asNode(value: unknown): AdfNode | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as AdfNode)
    : undefined
}

function children(node: AdfNode): readonly AdfNode[] {
  if (!Array.isArray(node.content)) return []
  return node.content.flatMap((child) => {
    const parsed = asNode(child)
    return parsed === undefined ? [] : [parsed]
  })
}

function attr(node: AdfNode, name: string): unknown {
  const attrs = asNode(node.attrs)
  return attrs === undefined ? undefined : (attrs as Record<string, unknown>)[name]
}

/** Each block as its own markdown, empties dropped so no blank line doubles. */
function blocks(nodes: readonly AdfNode[], depth: number): string[] {
  if (depth > MAX_DEPTH) return []
  return nodes.map((node) => block(node, depth)).filter((text) => text !== '')
}

function block(node: AdfNode, depth: number): string {
  switch (node.type) {
    case 'paragraph':
      return inlines(children(node), depth + 1)
    case 'heading': {
      const level = attr(node, 'level')
      const hashes = '#'.repeat(
        typeof level === 'number' && level >= 1 && level <= 6 ? Math.trunc(level) : 1
      )
      return `${hashes} ${inlines(children(node), depth + 1)}`
    }
    case 'bulletList':
      return list(node, depth, () => '- ')
    case 'orderedList': {
      const start = attr(node, 'order')
      const from = typeof start === 'number' && start > 0 ? Math.trunc(start) : 1
      return list(node, depth, (index) => `${from + index}. `)
    }
    case 'codeBlock': {
      const language = attr(node, 'language')
      const fence = typeof language === 'string' ? language : ''
      return `\`\`\`${fence}\n${plainText(node)}\n\`\`\``
    }
    case 'blockquote':
      return prefixLines(blocks(children(node), depth + 1).join('\n\n'), '> ')
    case 'rule':
      return '---'
    case 'mediaSingle':
    case 'mediaGroup':
      // The bytes are behind an authenticated fetch this collection never makes,
      // so an attachment is named rather than shown.
      return '_(attachment)_'
    default: {
      // Panels, tables, expands, extensions: whatever it is, its text survives.
      const inner = blocks(children(node), depth + 1)
      if (inner.length > 0) return inner.join('\n\n')
      return inlines([node], depth + 1)
    }
  }
}

/** One list, its items indented two spaces per level of nesting. */
function list(node: AdfNode, depth: number, bullet: (index: number) => string): string {
  const items = children(node).map((item, index) => {
    const marker = bullet(index)
    const inner = blocks(children(item), depth + 1).join('\n\n')
    return prefixLines(inner, ' '.repeat(marker.length), marker)
  })
  return items.filter((item) => item !== '').join('\n')
}

/** `first` opens the block; every later line takes the continuation prefix. */
function prefixLines(text: string, prefix: string, first: string = prefix): string {
  if (text === '') return ''
  return text
    .split('\n')
    .map((line, index) => (index === 0 ? `${first}${line}` : line === '' ? '' : `${prefix}${line}`))
    .join('\n')
}

function inlines(nodes: readonly AdfNode[], depth: number): string {
  if (depth > MAX_DEPTH) return ''
  return nodes.map((node) => inline(node, depth)).join('')
}

function inline(node: AdfNode, depth: number): string {
  switch (node.type) {
    case 'text':
      return marked(typeof node.text === 'string' ? node.text : '', node)
    case 'hardBreak':
      return '\n'
    case 'mention': {
      const text = attr(node, 'text')
      return typeof text === 'string' ? text : ''
    }
    case 'emoji': {
      const text = attr(node, 'text') ?? attr(node, 'shortName')
      return typeof text === 'string' ? text : ''
    }
    case 'inlineCard':
    case 'blockCard': {
      const url = attr(node, 'url')
      return typeof url === 'string' ? url : ''
    }
    default:
      return inlines(children(node), depth + 1)
  }
}

/** Innermost first: code, then emphasis, then the link around all of it. */
function marked(text: string, node: AdfNode): string {
  if (text === '') return ''
  const marks = Array.isArray(node.marks) ? node.marks.flatMap((mark) => asNode(mark) ?? []) : []
  const has = (type: string): boolean => marks.some((mark) => mark.type === type)

  let out = text
  if (has('code')) out = `\`${out}\``
  if (has('strong')) out = `**${out}**`
  if (has('em')) out = `*${out}*`
  if (has('strike')) out = `~~${out}~~`
  const link = marks.find((mark) => mark.type === 'link')
  if (link !== undefined) {
    const href = attr(link, 'href')
    if (typeof href === 'string' && href !== '') out = `[${out}](${href})`
  }
  return out
}

/** Every text node under this one, concatenated: a code block's own content. */
function plainText(node: AdfNode): string {
  if (typeof node.text === 'string') return node.text
  return children(node)
    .map((child) => plainText(child))
    .join('')
}
