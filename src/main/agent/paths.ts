import { join, resolve } from 'node:path'

// Computed rather than asked of π, so no session reads π's global resources
// or writes conversations where π's own sessions live.

export function crucibleAgentDir(home: string): string {
  return join(home, '.crucible', 'agent')
}

/** Reimplements π's encoding of a working directory, which π does not export. */
export function workspaceSessionDir(agentDir: string, workspacePath: string): string {
  const encoded = resolve(workspacePath).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')
  return join(agentDir, 'sessions', `--${encoded}--`)
}
