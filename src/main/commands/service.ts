import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  CommandInfo,
  CommandOrigin,
  CommandService,
  Expansion
} from '../../shared/commands/service'
import {
  describe,
  expandBody,
  parseCommandFile,
  splitInvocation
} from '../../shared/commands/template'

// Reads folders and nothing else: the format, the grammar and the precedence
// rule live in the shared template module, so the fake and this cannot drift.
//
// The three roots are injected, which is what lets a unit test point the whole
// service at temp directories.

export interface CommandRoots {
  /** The built-ins shipped with the app. */
  readonly builtIn: string
  /** `~/.crucible/commands`. */
  readonly user: string
}

export interface CommandFolder {
  readonly origin: CommandOrigin
  readonly path: string
}

/** Workspace beats user beats built-in, so the winner is the last one found. */
export function foldersFor(roots: CommandRoots, workspacePath: string): readonly CommandFolder[] {
  return [
    { origin: 'built-in', path: roots.builtIn },
    { origin: 'user', path: roots.user },
    { origin: 'workspace', path: join(workspacePath, '.crucible', 'commands') }
  ]
}

export interface CommandServiceOptions {
  readonly roots: CommandRoots
  /** Where a file that cannot be read is reported; discovery never crashes. */
  readonly onUnreadable?: (path: string, cause: unknown) => void
}

interface Found {
  readonly name: string
  readonly origin: CommandOrigin
  readonly path: string
}

export function createCommandService({
  roots,
  onUnreadable
}: CommandServiceOptions): CommandService {
  // Every call reads the folders again: a command an agent writes mid-session
  // is in the very next popover (CMD-8).
  function discover(workspacePath: string): Map<string, Found> {
    const winners = new Map<string, Found>()
    for (const folder of foldersFor(roots, workspacePath)) {
      for (const name of markdownNames(folder.path)) {
        winners.set(name, {
          name,
          origin: folder.origin,
          path: join(folder.path, `${name}.md`)
        })
      }
    }
    return winners
  }

  return {
    async list(workspacePath: string): Promise<readonly CommandInfo[]> {
      const listed: CommandInfo[] = []
      for (const found of discover(workspacePath).values()) {
        const text = read(found.path)
        // A file that cannot be read at all is skipped and reported; it never
        // takes the rest of the folder down with it.
        if (text === undefined) {
          onUnreadable?.(found.path, new Error('the file could not be read'))
          continue
        }
        const file = parseCommandFile(text)
        listed.push({
          name: found.name,
          description: describe(file),
          ...(file.argumentHint === undefined ? {} : { argumentHint: file.argumentHint }),
          origin: found.origin
        })
      }
      return listed.sort((left, right) => left.name.localeCompare(right.name))
    },

    async expand(workspacePath: string, draft: string): Promise<Expansion> {
      const invocation = splitInvocation(draft)
      if (invocation === undefined) return { kind: 'plain' }
      const found = discover(workspacePath).get(invocation.name)
      // A leading `/` that names no command is just text.
      if (found === undefined) return { kind: 'plain' }

      const text = read(found.path)
      if (text === undefined) {
        throw new Error(`The file behind /${found.name} could not be read.`)
      }
      return {
        kind: 'command',
        name: found.name,
        origin: found.origin,
        text: expandBody(parseCommandFile(text), invocation.args)
      }
    }
  }

  function read(path: string): string | undefined {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  }
}

// Non-recursive, `*.md` only, and a missing folder contributes nothing: π's
// rule, adopted (CMD-7). Discovery never creates a folder.
function markdownNames(folder: string): readonly string[] {
  let entries: readonly string[]
  try {
    entries = readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => entry.name.slice(0, -'.md'.length))
  } catch {
    return []
  }
  return entries.filter((name) => name !== '')
}
