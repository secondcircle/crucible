import { join } from 'node:path'

// The cache ledger is Crucible's alone and lives directly under Crucible's own
// state directory, which is already flavor-scoped: installed, dev, and a
// per-worktree directory for runs. Nothing under `.pi` is read or written
// (ADR 0015), and there is one file per installation rather than one per
// workspace, because the pattern being hunted crosses workspaces (ADR 0019).

export const LEDGER_FILE_NAME = 'cache-misses.jsonl'

// Set once at startup from Electron's userData, exactly as the quota cache's
// directory is, so this module stays free of Electron and a test runs against
// a temp dir.
let configured: string | undefined

/** Called by main before the recording service is built. */
export function useCacheLedgerDir(dir: string): void {
  configured = dir
}

/** `dir` is the state directory itself, which is how a test stays off the real one. */
export function cacheLedgerPath(dir?: string): string {
  const root = dir ?? configured
  if (root === undefined) {
    // Nobody has said where Crucible's state lives, so there is no honest
    // answer. Guessing a path is how an app ends up writing somebody else's
    // directory — and this file is never pruned, so a wrong guess persists.
    throw new Error('cache ledger directory was never set: call useCacheLedgerDir first')
  }
  return join(root, LEDGER_FILE_NAME)
}
