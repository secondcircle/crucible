import { isNewerVersion } from '../../shared/app-update/semver'
import type {
  AppUpdateService,
  AppVersionListener,
  AppVersionState,
  UpdateStatus,
  Unsubscribe
} from '../../shared/app-update/service'

// The installed app's updater. "Ready" means the new version is staged and
// assembled into this very bundle — on disk and a restart away, never an
// instruction to go run npm by hand. Every collaborator is injected; the
// renderer learns none of them, seeing one snapshot and one button.

export interface MainAppUpdateService extends AppUpdateService {
  dispose(): void
}

/** Every 15 minutes while the app runs, and once at launch. */
const POLL_MS = 15 * 60 * 1000

export interface AppUpdateOptions {
  /** What this process is running: the bundled package.json CI published. */
  readonly version: string
  /**
   * The bundle to refresh — the running app's own root, walked up from its
   * executable. The updater always knows it exactly, so the assembler never
   * derives an install location for an app that is already installed.
   */
  readonly bundleRoot: string
  readonly registry: { latest(): Promise<string> }
  /** Fetches a version onto disk; answers the tree the assembler is handed. */
  readonly stage: (version: string) => Promise<string>
  /** Refreshes the bundle's contents in place from that tree. */
  readonly assemble: (tree: string, target: string) => Promise<void>
  /** `app.relaunch()` + `app.quit()`, injected so this file needs no electron. */
  readonly relaunch: () => void
  readonly now?: () => number
  readonly intervalMs?: number
  /** Failures are quiet: they go to the run log and the next poll retries. */
  readonly onFailure?: (message: string) => void
}

export function createAppUpdateService(options: AppUpdateOptions): MainAppUpdateService {
  const listeners = new Set<AppVersionListener>()
  const now = options.now ?? Date.now
  let update: UpdateStatus = { kind: 'unchecked' }
  let checking = false
  let disposed = false

  function snapshot(): AppVersionState {
    return { kind: 'installed', version: options.version, update }
  }

  function announce(next: UpdateStatus): void {
    update = next
    const state = snapshot()
    for (const listener of [...listeners]) listener(state)
  }

  async function check(): Promise<void> {
    // One check at a time: staging takes minutes, and a second poll landing
    // mid-download would fetch the same version twice.
    if (checking || disposed) return
    checking = true
    try {
      const latest = await options.registry.latest()

      if (!isNewerVersion(latest, options.version)) {
        // At or below what runs: current, and never a downgrade. A version
        // already staged stays reported — the bundle really does hold it, and
        // saying "up to date" over it would be a lie the strip repeats.
        if (update.kind !== 'ready') announce({ kind: 'current', checkedAt: now() })
        return
      }

      // Newer than the running version, but not newer than what is already
      // waiting on disk: nothing to do and nothing to say.
      if (update.kind === 'ready' && !isNewerVersion(latest, update.version)) return

      const tree = await options.stage(latest)
      await options.assemble(tree, options.bundleRoot)
      if (disposed) return
      // Announced last, and only here: on disk, and a restart away.
      announce({ kind: 'ready', version: latest })
    } catch (cause) {
      // Unreachable registry, failed download, failed assembly: the reported
      // state stays exactly as it was and the next poll tries again. No
      // dialog, no red, no pill for a failure.
      options.onFailure?.(cause instanceof Error ? cause.message : String(cause))
    } finally {
      checking = false
    }
  }

  const timer = setInterval(() => void check(), options.intervalMs ?? POLL_MS)
  timer.unref()
  // At launch too: an app opened after a week of updates should not wait a
  // quarter of an hour to notice.
  void check()

  return {
    state: async () => snapshot(),
    restart: async () => options.relaunch(),
    onEvent(listener: AppVersionListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      disposed = true
      clearInterval(timer)
      listeners.clear()
    }
  }
}
