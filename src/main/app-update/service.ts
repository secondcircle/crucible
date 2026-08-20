import { readFileSync } from 'node:fs'
import type {
  AppUpdateListener,
  AppUpdateService,
  Unsubscribe
} from '../../shared/app-update/service'

// install-stable replaces /Applications/Crucible.app while the app runs; the
// running process keeps its loaded code, but the stamp file on disk now names
// the newer build. Polling that one file is the whole detection: no feed, no
// server, no signature to check — the file is inside our own bundle.

export interface MainAppUpdateService extends AppUpdateService {
  dispose(): void
}

/** How often the stamp is read. Cheap: one small file, already-cached inode. */
const POLL_MS = 15_000

export function createAppUpdateService(options: {
  /** `<appPath>/out/build-stamp.json`, written by install-stable. */
  readonly stampPath: string
  /** `app.relaunch()` + `app.quit()`, injected so this file needs no electron. */
  readonly relaunch: () => void
  readonly intervalMs?: number
}): MainAppUpdateService {
  const listeners = new Set<AppUpdateListener>()

  function readCommit(): string | null {
    // Unreadable covers the install window itself (the bundle is mid-replace)
    // as well as a build without a stamp; both mean "nothing to say yet".
    try {
      const parsed: unknown = JSON.parse(readFileSync(options.stampPath, 'utf8'))
      const commit = (parsed as { commit?: unknown }).commit
      return typeof commit === 'string' && commit !== '' ? commit : null
    } catch {
      return null
    }
  }

  // The build this process is actually running. If the stamp is unreadable at
  // launch, the first readable one is adopted as the baseline instead of being
  // announced: a stamp appearing is not an update, only a stamp changing is.
  let baseline = readCommit()
  let announced: string | null = null

  const timer = setInterval(() => {
    const commit = readCommit()
    if (commit === null) return
    if (baseline === null) {
      baseline = commit
      return
    }
    if (commit === baseline || commit === announced) return
    announced = commit
    for (const listener of [...listeners]) listener({ type: 'update_ready', commit })
  }, options.intervalMs ?? POLL_MS)
  timer.unref()

  return {
    pending: async () => announced,
    restart: async () => options.relaunch(),
    onEvent(listener: AppUpdateListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      clearInterval(timer)
      listeners.clear()
    }
  }
}

/**
 * What a dev launch serves: never an update, and a restart that does nothing,
 * because the pill that would ask for one can never appear.
 */
export function stillAppUpdateService(): MainAppUpdateService {
  return {
    pending: async () => null,
    restart: async () => {},
    onEvent: () => () => {},
    dispose: () => {}
  }
}
