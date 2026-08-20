import type { CommandInfo, CommandService, Expansion } from './service'
import { expandBody, splitInvocation } from './template'

// Reads no folder and imports neither Electron nor Node, so an agent-driven
// check and every test cost nothing.

interface CannedCommand extends CommandInfo {
  /** Real template text, expanded by the same code the real service uses. */
  readonly body: string
}

// All three origins and both hint styles, so the popover's badges, hints and
// filtering are drivable for free.
export const CANNED_COMMANDS: readonly CannedCommand[] = [
  {
    name: 'align',
    description: 'Grill an idea into shared understanding, ending in an intent brief',
    argumentHint: '[subject]',
    origin: 'built-in',
    body:
      'Interview me about ${@:-(none given — make asking for it your first question)} ' +
      'until we reach shared understanding, then write the intent brief.'
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
    description: 'Review a pull request with structured issue and code analysis',
    argumentHint: '<PR-URL>',
    origin: 'user',
    body: 'Review the pull request at $1. Report bugs, security issues and gaps in error handling.'
  },
  {
    name: 'standup',
    description: 'Summarize yesterday, today and blockers from git',
    origin: 'workspace',
    body: 'Read the last day of git history in this workspace and write the standup.'
  }
]

/** The one draft this fake refuses, so the failure path is drivable too. */
export const FAKE_UNREADABLE_COMMAND = 'vanished'

export function createFakeCommandService(): CommandService {
  return {
    // The same canned set in every workspace, so the argument is not read.
    async list(): Promise<readonly CommandInfo[]> {
      return CANNED_COMMANDS.map(
        ({ name, description, argumentHint, origin }): CommandInfo => ({
          name,
          description,
          ...(argumentHint === undefined ? {} : { argumentHint }),
          origin
        })
      )
    },

    async expand(_workspacePath: string, draft: string): Promise<Expansion> {
      const invocation = splitInvocation(draft)
      if (invocation === undefined) return { kind: 'plain' }
      if (invocation.name === FAKE_UNREADABLE_COMMAND) {
        throw new Error('That command file could not be read.')
      }
      const found = CANNED_COMMANDS.find((command) => command.name === invocation.name)
      // A draft that names no command is text, never an error.
      if (found === undefined) return { kind: 'plain' }
      return {
        kind: 'command',
        name: found.name,
        origin: found.origin,
        text: expandBody({ body: found.body }, invocation.args)
      }
    }
  }
}
