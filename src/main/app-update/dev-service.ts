import { execFileSync } from 'node:child_process'
import type { MainAppUpdateService } from './service'

// What a dev launch serves. It answers the one fact a dev launch has — which
// checkout is running — and can never carry an update state at all, because
// the snapshot type has no room for one. Updates are not checked in dev, and
// nothing here has to remember that.

export function createDevVersionService(options: {
  readonly version: string
  /** The checkout's short commit, read once. Absent when git cannot answer. */
  readonly commit?: string
}): MainAppUpdateService {
  const state = {
    kind: 'dev' as const,
    version: options.version,
    ...(options.commit === undefined ? {} : { commit: options.commit })
  }
  return {
    state: async () => state,
    // A dev launch has nothing to restart into, and the strip that would ask
    // for one is uninteractive there.
    restart: async () => {},
    onEvent: () => () => {},
    dispose: () => {}
  }
}

/**
 * The checkout's short commit. Read once at launch, and absent rather than
 * guessed when git is not there — the strip's amber mark is then `dev` alone.
 */
export function checkoutCommit(cwd: string): string | undefined {
  try {
    const said = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    return said === '' ? undefined : said
  } catch {
    return undefined
  }
}
