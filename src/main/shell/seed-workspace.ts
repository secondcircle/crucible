import { statSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The workspace a launch is told to open, if it was told (WS-7).
 *
 * This is the only reader of `CRUCIBLE_WORKSPACE`, for the same reason
 * `selectAdapter` is the only reader of `CRUCIBLE_AGENT`: an environment
 * variable read in one place is a question one module answers, rather than a
 * fact every caller has to know about.
 *
 * It exists so an agent-driven check can reach a chattable state without an OS
 * dialog — the folder is ensured present and active exactly as if it had been
 * picked. A variable naming something that is not a directory is ignored: a
 * launch that cannot honor it opens as it otherwise would rather than failing.
 */
export function seedWorkspacePath(named = process.env.CRUCIBLE_WORKSPACE): string | undefined {
  if (named === undefined || named.trim() === '') return undefined
  const path = resolve(named.trim())
  try {
    return statSync(path).isDirectory() ? path : undefined
  } catch {
    return undefined
  }
}
