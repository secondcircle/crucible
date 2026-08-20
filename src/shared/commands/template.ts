import type { CommandInfo } from './service'

// The command file format and the `$`-argument grammar, in one place so the
// real service, the fake and the popover can never drift into two readings of
// the same file. Imports nothing but the seam's own types: main and the
// renderer both load this module.
//
// The semantics deliberately copy π's prompt templates, so a file moves
// between the two systems unchanged. The spec is Crucible's (ADR 0007).

export interface CommandFile {
  /** The body with the frontmatter removed; substitution happens in it alone. */
  readonly body: string
  readonly description?: string
  readonly argumentHint?: string
}

const FENCE = '---'

/**
 * Frontmatter is optional, and a block that does not parse costs only itself:
 * the body still expands and the command still lists (CMD-4).
 */
export function parseCommandFile(text: string): CommandFile {
  const withoutBom = text.startsWith('\ufeff') ? text.slice(1) : text
  const lines = withoutBom.split('\n')
  if (lines[0]?.trim() !== FENCE) return { body: withoutBom }

  const closing = lines.findIndex((line, at) => at > 0 && line.trim() === FENCE)
  // An unterminated fence is not frontmatter at all; the opener is still a
  // fence, so it leaves with the block it failed to open.
  if (closing === -1) return { body: lines.slice(1).join('\n') }

  const body = lines.slice(closing + 1).join('\n')
  const fields = parseFields(lines.slice(1, closing))
  if (fields === undefined) return { body }

  return {
    body,
    ...(fields.description === undefined ? {} : { description: fields.description }),
    ...(fields['argument-hint'] === undefined ? {} : { argumentHint: fields['argument-hint'] })
  }
}

// The subset of YAML a command file uses: `key: value` lines, blank lines and
// `#` comments. Anything else means the block did not parse.
function parseFields(lines: readonly string[]): Record<string, string> | undefined {
  const fields: Record<string, string> = {}
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const colon = line.indexOf(':')
    if (colon <= 0) return undefined
    fields[line.slice(0, colon).trim()] = unquote(line.slice(colon + 1).trim())
  }
  return fields
}

function unquote(value: string): string {
  const quoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  return quoted ? value.slice(1, -1) : value
}

/** π's rule, adopted: the description falls back to the first non-empty line. */
export function describe(file: CommandFile): string {
  if (file.description !== undefined && file.description !== '') return file.description
  for (const line of file.body.split('\n')) {
    const text = line.trim()
    if (text !== '') return text
  }
  return ''
}

/**
 * The name and the argument string of a draft, or nothing when the draft is
 * not an invocation. The first character alone decides (COMP-1).
 */
export function splitInvocation(draft: string): { name: string; args: string } | undefined {
  if (!draft.startsWith('/')) return undefined
  const rest = draft.slice(1)
  const boundary = rest.search(/\s/)
  const name = boundary === -1 ? rest : rest.slice(0, boundary)
  if (name === '') return undefined
  return { name, args: boundary === -1 ? '' : rest.slice(boundary + 1) }
}

/**
 * The command name still being typed, or nothing once the draft has moved on
 * to the arguments: the popover belongs to the name alone (COMP-2).
 */
export function commandFragment(draft: string): string | undefined {
  if (!draft.startsWith('/')) return undefined
  const rest = draft.slice(1)
  return /\s/.test(rest) ? undefined : rest
}

/**
 * Whitespace separates, a double-quoted span is one token with the quotes
 * stripped, and everything else is literal (CMD-10).
 */
export function tokenize(args: string): readonly string[] {
  const tokens: string[] = []
  let token = ''
  let started = false
  let quoted = false

  for (const character of args) {
    if (character === '"') {
      quoted = !quoted
      started = true
      continue
    }
    if (!quoted && /\s/.test(character)) {
      if (started) tokens.push(token)
      token = ''
      started = false
      continue
    }
    token += character
    started = true
  }
  if (started) tokens.push(token)
  return tokens
}

// Every form CMD-11 names, and nothing else: text that resembles the grammar
// without matching it stays literal, and there is no escaping in v1.
const SUBSTITUTION =
  /\$(?:\{(?:(?<defaultOf>\d+):-(?<positionalDefault>[^}]*)|(?:@|ARGUMENTS):-(?<allDefault>[^}]*)|(?:@|ARGUMENTS):(?<from>\d+)(?::(?<length>\d+))?)\}|(?<positional>\d+)|(?:@|ARGUMENTS))/g

/** The body with every `$`-form replaced from the tokens (CMD-11). */
export function substitute(body: string, tokens: readonly string[]): string {
  const all = tokens.join(' ')

  return body.replace(SUBSTITUTION, (whole, ...rest) => {
    const groups = rest.at(-1) as Record<string, string | undefined>
    const { defaultOf, positionalDefault, allDefault, from, length, positional } = groups

    if (defaultOf !== undefined) {
      const token = tokens[Number(defaultOf) - 1] ?? ''
      return token === '' ? (positionalDefault ?? '') : token
    }
    if (allDefault !== undefined) return all === '' ? allDefault : all
    if (from !== undefined) {
      const start = Math.max(0, Number(from) - 1)
      const taken =
        length === undefined ? tokens.slice(start) : tokens.slice(start, start + Number(length))
      return taken.join(' ')
    }
    if (positional !== undefined) return tokens[Number(positional) - 1] ?? ''
    // `$@` and `$ARGUMENTS`, the only forms left.
    return whole === '$@' || whole === '$ARGUMENTS' ? all : whole
  })
}

/** What crosses the agent port: body, substituted, trimmed (CMD-3). */
export function expandBody(file: CommandFile, args: string): string {
  return substitute(file.body, tokenize(args)).trim()
}

/**
 * The popover's filter: a case-insensitive subsequence of the command name
 * (COMP-2). Order is the service's, which is alphabetical.
 */
export function filterCommands(
  commands: readonly CommandInfo[],
  fragment: string
): readonly CommandInfo[] {
  const wanted = fragment.trim().toLowerCase()
  if (wanted === '') return commands
  return commands.filter((command) => subsequence(command.name.toLowerCase(), wanted))
}

function subsequence(name: string, wanted: string): boolean {
  let at = 0
  for (const character of wanted) {
    at = name.indexOf(character, at)
    if (at === -1) return false
    at += 1
  }
  return true
}
