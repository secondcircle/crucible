// Just enough of a TypeScript lexer to answer two questions about a workflow
// file without running it: where a top-level declaration ends, and which
// characters of a template literal are `${…}` interpolations, filled in only
// when the run builds the prompt. Strings, comments and nested templates are
// honoured; regular expression literals are not, which no prompt needs.

type Frame = { readonly kind: 'code'; depth: number } | { readonly kind: 'template' }

interface Position {
  /** Outside every bracket and every template: where a statement can end. */
  readonly topLevel: boolean
  /** Inside an interpolation of the outermost template, delimiters included. */
  readonly filled: boolean
}

/** Visits every character from `start`; a visitor answering true stops the walk. */
function walk(text: string, start: number, visit: (index: number, at: Position) => boolean): void {
  const stack: Frame[] = [{ kind: 'code', depth: 0 }]
  const position = (): Position => {
    const outer = stack.findIndex((frame) => frame.kind === 'template')
    const bottom = stack[0]
    return {
      topLevel: stack.length === 1 && bottom.kind === 'code' && bottom.depth === 0,
      filled: outer !== -1 && stack.length > outer + 1
    }
  }
  const emit = (index: number): boolean => visit(index, position())

  let i = start
  while (i < text.length) {
    const c = text[i]
    const next = text[i + 1]
    const frame = stack[stack.length - 1]

    if (frame.kind === 'template') {
      if (c === '\\') {
        if (emit(i) || (i + 1 < text.length && emit(i + 1))) return
        i += 2
        continue
      }
      if (c === '`') {
        if (emit(i)) return
        stack.pop()
        i += 1
        continue
      }
      if (c === '$' && next === '{') {
        stack.push({ kind: 'code', depth: 0 })
        if (emit(i) || emit(i + 1)) return
        i += 2
        continue
      }
      if (emit(i)) return
      i += 1
      continue
    }

    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') {
        if (emit(i)) return
        i += 1
      }
      continue
    }
    if (c === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2)
      const stop = close === -1 ? text.length : close + 2
      for (; i < stop; i += 1) if (emit(i)) return
      continue
    }
    if (c === "'" || c === '"') {
      if (emit(i)) return
      i += 1
      while (i < text.length && text[i] !== c && text[i] !== '\n') {
        if (text[i] === '\\' && i + 1 < text.length) {
          if (emit(i)) return
          i += 1
        }
        if (emit(i)) return
        i += 1
      }
      if (i < text.length && text[i] === c) {
        if (emit(i)) return
        i += 1
      }
      continue
    }
    if (c === '`') {
      stack.push({ kind: 'template' })
      if (emit(i)) return
      i += 1
      continue
    }
    if (c === '{' || c === '(' || c === '[') {
      frame.depth += 1
      if (emit(i)) return
      i += 1
      continue
    }
    if (c === '}' || c === ')' || c === ']') {
      if (c === '}' && frame.depth === 0 && stack.length > 1) {
        // The brace that closes an interpolation belongs to it.
        if (emit(i)) return
        stack.pop()
        i += 1
        continue
      }
      frame.depth = Math.max(0, frame.depth - 1)
      if (emit(i)) return
      i += 1
      continue
    }
    if (emit(i)) return
    i += 1
  }
}

/** One run of a quoted line, either as written or filled in at run time. */
export interface QuoteSegment {
  readonly text: string
  readonly filled: boolean
}

/**
 * Lines `start`–`end` (1-based, inclusive) of a file, each cut where an
 * interpolation begins and ends. The whole file up to the range is walked, so
 * a range that opens inside a template still knows it is in one.
 */
export function quotedLines(
  text: string,
  start: number,
  end: number
): readonly (readonly QuoteSegment[])[] {
  const offsets = lineOffsets(text)
  const from = offsets[start - 1] ?? text.length
  const to = end < offsets.length ? offsets[end] - 1 : text.length
  const flags: boolean[] = []
  walk(text, 0, (index, at) => {
    if (index >= to) return true
    if (index >= from) flags[index - from] = at.filled
    return false
  })

  const lines: QuoteSegment[][] = []
  let line: QuoteSegment[] = []
  let run = ''
  let runFilled = false
  const close = (): void => {
    if (run !== '') line.push({ text: run, filled: runFilled })
    run = ''
  }
  for (let index = 0; index < to - from; index += 1) {
    const c = text[from + index]
    if (c === '\n') {
      close()
      lines.push(line)
      line = []
      continue
    }
    const filled = flags[index] === true
    if (filled !== runFilled) {
      close()
      runFilled = filled
    }
    run += c
  }
  close()
  lines.push(line)
  return lines
}

const CONTINUES_AFTER = /(=>|[=+\-*/?:,([{.]|&&|\|\||\?\?)$/
const CONTINUES_BEFORE = /^(\.|\?|:|\+|-|\*|\/|&&|\|\||\?\?|\)|\]|\})/

/** Where a top-level declaration of `name` sits, as 1-based inclusive lines. */
export function declarationRange(
  text: string,
  name: string
): { readonly start: number; readonly end: number } | undefined {
  const lines = text.split('\n')
  const declares = new RegExp(
    `^\\s*(?:export\\s+)?(?:(?:const|let|var)\\s+${escaped(name)}\\b|(?:async\\s+)?function\\s+${escaped(name)}\\b)`
  )
  const at = lines.findIndex((line) => declares.test(line))
  if (at === -1) return undefined
  const offsets = lineOffsets(text)
  let end: number | undefined
  walk(text, offsets[at], (index, position) => {
    if (!position.topLevel) return false
    const c = text[index]
    if (c === ';') {
      end = lineOf(offsets, index)
      return true
    }
    if (c !== '\n') return false
    const line = lineOf(offsets, index)
    const said = stripLineComment(lines[line]).trim()
    if (said === '' || CONTINUES_AFTER.test(said)) return false
    const following = lines.slice(line + 1).find((candidate) => !silent(candidate))
    if (following !== undefined && CONTINUES_BEFORE.test(following.trim())) return false
    end = line
    return true
  })
  return { start: at + 1, end: (end ?? lines.length - 1) + 1 }
}

/** The string a single-line `const NAME = '…'` holds, and the line it is on. */
export function constantString(
  text: string,
  name: string
): { readonly value: string; readonly line: number } | undefined {
  const pattern = new RegExp(
    `^\\s*(?:export\\s+)?const\\s+${escaped(name)}\\s*(?::[^=]+)?=\\s*(['"\`])([^'"\`]*)\\1`
  )
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    const match = pattern.exec(line)
    if (match !== null) return { value: match[2], line: index + 1 }
  }
  return undefined
}

function lineOffsets(text: string): number[] {
  const offsets = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') offsets.push(index + 1)
  }
  return offsets
}

/** The 0-based line holding a character. */
function lineOf(offsets: readonly number[], index: number): number {
  let low = 0
  let high = offsets.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (offsets[middle] <= index) low = middle
    else high = middle - 1
  }
  return low
}

/** A line that cannot continue a statement: blank, or a comment. */
function silent(line: string): boolean {
  const said = line.trim()
  return said === '' || said.startsWith('//') || said.startsWith('/*') || said.startsWith('*')
}

function stripLineComment(line: string): string {
  const at = line.indexOf('//')
  return at === -1 ? line : line.slice(0, at)
}

function escaped(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
