import { join, resolve } from 'node:path'

// Crucible's own folders, computed and never discovered: π's `~/.pi/agent` is
// not read for resources and not written to for sessions. Pure, so the home
// directory is injected rather than looked up here.

/**
 * Where a Crucible launch keeps everything an agent session reads from a
 * global folder: settings, the global context file, sessions.
 */
export function crucibleAgentDir(home: string): string {
  return join(home, '.crucible', 'agent')
}

/**
 * One folder of conversations per workspace, named by π's own encoding of a
 * working directory, which π does not export. Deterministic, and distinct for
 * distinct workspace paths.
 */
export function workspaceSessionDir(agentDir: string, workspacePath: string): string {
  const encoded = resolve(workspacePath).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')
  return join(agentDir, 'sessions', `--${encoded}--`)
}
