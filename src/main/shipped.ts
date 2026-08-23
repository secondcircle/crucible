import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// Extension spelled out so plain Node loads this module too, not only the
// bundler.
import { composeSystemPrompt } from './agent/system-prompt.ts'

// The one module that knows where the app keeps the files it ships; everything
// else takes those as an injected path or as text.

const SHIPPED_DIRECTORY = 'resources'

/** `root` is the app's own directory, which in dev is the repository. */
export function shippedCommandsPath(root: string): string {
  return join(root, SHIPPED_DIRECTORY, 'commands')
}

/** The built-in origin: skills that ship inside the app, read-only. */
export function shippedSkillsPath(root: string): string {
  return join(root, SHIPPED_DIRECTORY, 'skills')
}

export function shippedDocsIndexPath(root: string): string {
  return join(root, SHIPPED_DIRECTORY, 'agent-docs', 'index.md')
}

export function shippedWorkflowsPath(root: string): string {
  return join(root, SHIPPED_DIRECTORY, 'workflows')
}

/** The authoring module workflow files import as `crucible:workflow`. */
export function shippedWorkflowLibPath(root: string): string {
  return join(root, SHIPPED_DIRECTORY, 'workflows', 'lib', 'workflow.ts')
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

/** A missing file throws: a fallback would hand the agent π's own prompt. */
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
