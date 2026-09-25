import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// What the file tree and `@file` search list beyond git's say, and what they
// never list at all: `.crucible/files.json` in the workspace.
//
//   { "show": ["repos/**"], "hide": ["node_modules"] }
//
// `show` is for what git leaves out that a person still wants to open: a
// folder of nested repositories, which git lists as one opaque entry, or a
// file the .gitignore names. A shown folder is walked on its own terms, so a
// nested repository's own .gitignore still applies inside it. `hide` wins over
// everything, git's own listing included, and defaults to `node_modules` when
// the file does not say.

export const FILE_VIEW_CONFIG = '.crucible/files.json'

const DEFAULT_HIDE = ['node_modules'] as const

export interface FileViewConfig {
  readonly show: readonly Glob[]
  readonly hide: readonly Glob[]
}

export interface Glob {
  /** The folder a walk for this pattern starts in: everything before the first wildcard. */
  readonly base: string
  readonly test: RegExp
}

/** No file, an unreadable file, or a file that is not JSON: nothing extra shown. */
export async function readFileViewConfig(directory: string): Promise<FileViewConfig> {
  let text: string
  try {
    text = await readFile(join(directory, FILE_VIEW_CONFIG), 'utf8')
  } catch {
    return parseFileViewConfig(undefined)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  return parseFileViewConfig(parsed)
}

export function parseFileViewConfig(value: unknown): FileViewConfig {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const show = strings(record.show) ?? []
  const hide = strings(record.hide) ?? DEFAULT_HIDE
  return { show: show.map(glob), hide: hide.map(glob) }
}

function strings(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
}

/**
 * gitignore-flavored: `*` and `?` stay inside one folder, `**` crosses
 * folders, a pattern with no `/` matches a name at any depth, and a pattern
 * names a folder's whole contents as well as the folder itself — so
 * `node_modules` and `repos/kairos` need no `/**` on the end.
 */
export function glob(pattern: string): Glob {
  const trimmed = pattern.trim().replace(/^\.\//, '').replace(/\/+$/, '')
  const anchored = trimmed.includes('/')
  const cleaned = trimmed.replace(/^\/+/, '')
  const segments = cleaned.split('/')
  const firstWild = segments.findIndex((segment) => /[*?]/.test(segment))
  const fixed = firstWild < 0 ? segments : segments.slice(0, firstWild)
  // A bare name matches at any depth, so its walk starts at the top.
  const base = anchored ? fixed.join('/') : ''

  let source = ''
  for (let at = 0; at < cleaned.length; at += 1) {
    const character = cleaned[at]
    if (character === '*' && cleaned[at + 1] === '*') {
      const slash = cleaned[at + 2] === '/'
      source += slash ? '(?:.*/)?' : '.*'
      at += slash ? 2 : 1
    } else if (character === '*') source += '[^/]*'
    else if (character === '?') source += '[^/]'
    else source += character.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  const lead = anchored ? '^' : '(?:^|/)'
  return { base, test: new RegExp(`${lead}${source}(?:/.*)?$`) }
}

export function matches(globs: readonly Glob[], path: string): boolean {
  return globs.some((one) => one.test.test(path))
}
