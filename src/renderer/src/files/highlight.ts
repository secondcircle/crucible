// Source coloring for the panel's source view. Pure: a string and a file
// extension in, tokens per line out, so the rule can be pinned without a DOM.
//
// Deliberately coarse. It colors what every language agrees on — comments,
// strings, numbers, keywords — and never claims to parse anything.

export type TokenKind = 'plain' | 'keyword' | 'string' | 'comment' | 'number' | 'type'

export interface Token {
  readonly kind: TokenKind
  readonly text: string
}

/** Which comment and string rules a file follows. */
type Grammar = 'braces' | 'hash' | 'none'

/** Where a line starts, when the line above left something open. */
type Carry = 'code' | 'block' | 'template'

const BRACES = new Set([
  'as',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'declare',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'func',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'of',
  'package',
  'private',
  'protected',
  'public',
  'readonly',
  'return',
  'static',
  'struct',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'var',
  'void',
  'while',
  'yield'
])

const HASH = new Set([
  'and',
  'case',
  'class',
  'def',
  'do',
  'elif',
  'else',
  'esac',
  'export',
  'false',
  'fi',
  'for',
  'from',
  'function',
  'if',
  'import',
  'in',
  'lambda',
  'local',
  'none',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'self',
  'then',
  'true',
  'try',
  'while',
  'with'
])

const BRACE_FILES = new Set([
  'c',
  'cc',
  'cpp',
  'cs',
  'css',
  'go',
  'h',
  'hpp',
  'java',
  'js',
  'json',
  'jsonc',
  'jsx',
  'kt',
  'less',
  'm',
  'mjs',
  'cjs',
  'php',
  'rs',
  'scala',
  'scss',
  'swift',
  'ts',
  'tsx'
])

const HASH_FILES = new Set([
  'bash',
  'cfg',
  'conf',
  'fish',
  'gitignore',
  'ini',
  'ps1',
  'py',
  'rb',
  'sh',
  'toml',
  'yaml',
  'yml',
  'zsh'
])

// Long enough that a minified bundle is one line rather than a thousand: past
// this a line is shown as it is, because coloring it helps nobody.
const COLORING_LIMIT = 2000

export function grammarFor(extension: string): Grammar {
  const named = extension.toLowerCase()
  if (BRACE_FILES.has(named)) return 'braces'
  if (HASH_FILES.has(named)) return 'hash'
  return 'none'
}

/**
 * The source, line by line, each line a run of tokens. Line endings are gone:
 * the view numbers what it is given and draws nothing for them. A file's final
 * newline ends its last line rather than starting another, which is what every
 * editor's line count says too.
 */
export function highlight(source: string, extension: string): readonly (readonly Token[])[] {
  const grammar = grammarFor(extension)
  const text = source.endsWith('\n') ? source.slice(0, -1) : source
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
  let carry: Carry = 'code'
  return lines.map((line) => {
    if (grammar === 'none' || line.length > COLORING_LIMIT) return [{ kind: 'plain', text: line }]
    const read = tokenize(line, grammar, carry)
    carry = read.carry
    return read.tokens
  })
}

function tokenize(
  line: string,
  grammar: Grammar,
  opened: Carry
): { readonly tokens: readonly Token[]; readonly carry: Carry } {
  const tokens: Token[] = []
  let plain = ''
  let carry: Carry = opened
  let at = 0

  function flush(): void {
    if (plain === '') return
    tokens.push({ kind: 'plain', text: plain })
    plain = ''
  }

  function take(kind: TokenKind, text: string): void {
    flush()
    tokens.push({ kind, text })
  }

  while (at < line.length) {
    const rest = line.slice(at)

    if (carry === 'block') {
      const end = rest.indexOf('*/')
      if (end === -1) {
        take('comment', rest)
        return { tokens, carry }
      }
      take('comment', rest.slice(0, end + 2))
      at += end + 2
      carry = 'code'
      continue
    }

    if (carry === 'template') {
      const closed = scanString(rest, '`')
      take('string', closed.text)
      at += closed.text.length
      carry = closed.open ? 'template' : 'code'
      continue
    }

    if (grammar === 'braces' && rest.startsWith('//')) {
      take('comment', rest)
      return { tokens, carry }
    }
    if (grammar === 'hash' && rest.startsWith('#')) {
      take('comment', rest)
      return { tokens, carry }
    }
    if (grammar === 'braces' && rest.startsWith('/*')) {
      carry = 'block'
      continue
    }

    const quote = rest[0]
    if (quote === '"' || quote === "'" || (grammar === 'braces' && quote === '`')) {
      const scanned = scanString(rest, quote)
      take('string', scanned.text)
      at += scanned.text.length
      if (scanned.open && quote === '`') carry = 'template'
      continue
    }

    const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest)?.[0]
    if (word !== undefined) {
      const keywords = grammar === 'braces' ? BRACES : HASH
      if (keywords.has(word)) take('keyword', word)
      // A capitalized name is a type often enough to be worth the color, and
      // being wrong about one costs nothing but a tint.
      else if (grammar === 'braces' && /^[A-Z]/.test(word)) take('type', word)
      else plain += word
      at += word.length
      continue
    }

    const number = /^\d[\d._a-fA-FxX]*/.exec(rest)?.[0]
    if (number !== undefined) {
      take('number', number)
      at += number.length
      continue
    }

    plain += line[at] ?? ''
    at += 1
  }

  flush()
  return { tokens, carry }
}

/** From the opening quote to its match, escapes honored; `open` ran off the end. */
function scanString(rest: string, quote: string): { readonly text: string; readonly open: boolean } {
  let at = 1
  while (at < rest.length) {
    const character = rest[at]
    if (character === '\\') {
      at += 2
      continue
    }
    if (character === quote) return { text: rest.slice(0, at + 1), open: false }
    at += 1
  }
  return { text: rest, open: true }
}
