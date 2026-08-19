import { statSync } from 'node:fs'
import { resolve } from 'node:path'

// The only reader of `CRUCIBLE_WORKSPACE`, so no caller has to know the
// variable exists. It lets an agent-driven check reach a chattable state
// without an OS dialog; a value that is not a directory is ignored rather than
// failing the launch.
export function seedWorkspacePath(named = process.env.CRUCIBLE_WORKSPACE): string | undefined {
  if (named === undefined || named.trim() === '') return undefined
  const path = resolve(named.trim())
  try {
    return statSync(path).isDirectory() ? path : undefined
  } catch {
    return undefined
  }
}
