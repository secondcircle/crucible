import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// Spelled with its extension so plain Node can load this module too, which is
// how `prove:sdk` composes the same prompt the app composes.
import { composeSystemPrompt } from './agent/system-prompt.ts'

// The one module that knows where the app keeps the files it ships; everything
// else takes those as an injected path or as text.

const SHIPPED_DIRECTORY = 'resources'

/** `root` is the app's own directory, which in dev is the repository. */
export function shippedCommandsPath(root: string): string {
  return join(root, SHIPPED_DIRECTORY, 'commands')
}

/** The index the role prompt points at; the agent reads docs when asked. */
export function shippedDocsIndexPath(root: string): string {
  return join(root, SHIPPED_DIRECTORY, 'agent-docs', 'index.md')
}

export function shippedRolePromptPath(root: string): string {
  return join(root, SHIPPED_DIRECTORY, 'prompts', 'role-coding-agent.md')
}

export function shippedStandingPromptPath(root: string): string {
  return join(root, SHIPPED_DIRECTORY, 'prompts', 'standing.md')
}

export function readShippedRolePrompt(root: string): string {
  return read(shippedRolePromptPath(root))
}

export function readShippedStandingPrompt(root: string): string {
  return read(shippedStandingPromptPath(root))
}

/**
 * The whole system prompt of every agent this launch starts, read from the
 * files that ship with the app. A missing file throws: falling back would hand
 * the agent π's own prompt, which is the thing this prompt replaces.
 */
export function shippedSystemPrompt(root: string): string {
  return composeSystemPrompt({
    role: readShippedRolePrompt(root),
    standing: readShippedStandingPrompt(root),
    docsIndexPath: shippedDocsIndexPath(root)
  })
}

/** The error names the file, because the launch that failed cannot show one. */
function read(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (cause) {
    throw new Error(`Crucible ships ${path} and could not read it.`, { cause })
  }
}
