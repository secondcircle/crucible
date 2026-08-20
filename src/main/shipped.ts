import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The one module that knows where the app keeps the files it ships; everything
// else takes those as an injected path or as text.

const SHIPPED_DIRECTORY = 'resources'

/** `root` is the app's own directory, which in dev is the repository. */
export function shippedCommandsPath(root: string): string {
  return join(root, SHIPPED_DIRECTORY, 'commands')
}

export function shippedAgentDocPath(root: string): string {
  return join(root, SHIPPED_DIRECTORY, 'agent-docs', 'commands.md')
}

/**
 * An unreadable doc is not worth failing a launch over: the session runs
 * without it, and the caller decides whether to say so.
 */
export function readShippedAgentDoc(root: string): string | undefined {
  try {
    return readFileSync(shippedAgentDocPath(root), 'utf8')
  } catch {
    return undefined
  }
}
