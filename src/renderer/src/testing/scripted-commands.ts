import type { CommandInfo, CommandService, Expansion } from '../../../shared/commands/service'
import { expandBody, splitInvocation } from '../../../shared/commands/template'

// Answers the way main's command service does, from a list a test writes, and
// expands with the very same code the real service uses. Reads no folder, so a
// component test is about the composer rather than about the filesystem.

export interface ScriptedCommand extends CommandInfo {
  /** The template text; absent means the file cannot be read at expansion time. */
  readonly body?: string
}

export interface ScriptedCommands extends CommandService {
  readonly calls: ReadonlyArray<{ readonly op: string; readonly args: readonly unknown[] }>
  /** What `list` answers with; a test may change it between openings. */
  commands: readonly ScriptedCommand[]
}

/** Enough of a set that badges, hints and filtering all have something to show. */
export const SCRIPTED_COMMANDS: readonly ScriptedCommand[] = [
  {
    name: 'align',
    description: 'Grill an idea into shared understanding',
    argumentHint: '[subject]',
    origin: 'built-in',
    body: 'Interview me about ${@:-(nothing given)} until we agree.'
  },
  {
    name: 'component',
    description: 'Create a React component',
    argumentHint: '<name> [features…]',
    origin: 'workspace',
    body: 'Create a React component named $1 with features: ${@:2}'
  },
  {
    name: 'review',
    description: 'Review a pull request',
    argumentHint: '<PR-URL>',
    origin: 'user',
    body: 'Review the pull request at $1.'
  }
]

export function createScriptedCommands(
  commands: readonly ScriptedCommand[] = SCRIPTED_COMMANDS
): ScriptedCommands {
  const calls: Array<{ op: string; args: readonly unknown[] }> = []

  const service: ScriptedCommands = {
    calls,
    commands,

    list(workspacePath: string): Promise<readonly CommandInfo[]> {
      calls.push({ op: 'list', args: [workspacePath] })
      return Promise.resolve(
        [...service.commands]
          .map(({ name, description, argumentHint, origin }): CommandInfo => ({
            name,
            description,
            ...(argumentHint === undefined ? {} : { argumentHint }),
            origin
          }))
          .sort((left, right) => left.name.localeCompare(right.name))
      )
    },

    expand(workspacePath: string, draft: string): Promise<Expansion> {
      calls.push({ op: 'expand', args: [workspacePath, draft] })
      const invocation = splitInvocation(draft)
      if (invocation === undefined) return Promise.resolve({ kind: 'plain' })
      const found = service.commands.find((command) => command.name === invocation.name)
      if (found === undefined) return Promise.resolve({ kind: 'plain' })
      // A command whose file has gone since the popover listed it: the only
      // thing `expand` ever rejects for.
      if (found.body === undefined) {
        return Promise.reject(new Error(`The file behind /${found.name} could not be read.`))
      }
      return Promise.resolve({
        kind: 'command',
        name: found.name,
        origin: found.origin,
        text: expandBody({ body: found.body }, invocation.args)
      })
    }
  }

  return service
}
