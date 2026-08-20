import type { SessionId } from '../../shared/agent/port'
import type { NeedsYouService, WaitingSession } from '../../shared/needs-you/service'

// Both channels outside the window are gated on one fact: whether Crucible has
// focus. A focused window gets the sidebar mark alone — the user is already
// looking, and a banner about the app they are in is noise.
//
// Electron lives in the desk, so the rules below are testable without an app.

export interface NeedsYouDesk {
  focused(): boolean
  /** Fires on both edges, which is what re-applies the badge on blur. */
  onFocusChanged(listener: (focused: boolean) => void): () => void
  /** Zero means no badge at all, not a badge reading "0". */
  badge(count: number): void
  /** No sound, ever. `onOpen` is the click. */
  notify(session: WaitingSession, onOpen: () => void): void
  /** Brings the window forward on that session. */
  open(sessionId: SessionId): void
}

export interface LiveNeedsYouService extends NeedsYouService {
  dispose(): void
}

export function createNeedsYouService(desk: NeedsYouDesk): LiveNeedsYouService {
  // The last count the renderer reported, whether or not it was shown. The
  // badge is re-applied from it the moment the window loses focus, so leaving
  // Crucible reveals what was already waiting.
  let waitingCount = 0
  let alive = true

  const unsubscribe = desk.onFocusChanged((focused) => {
    if (!alive) return
    desk.badge(focused ? 0 : waitingCount)
  })

  function show(): void {
    desk.badge(desk.focused() ? 0 : waitingCount)
  }

  return {
    async waiting(count: number): Promise<void> {
      waitingCount = Math.max(0, Math.trunc(count))
      show()
    },

    async announce(session: WaitingSession): Promise<void> {
      // Nothing leaves a window the user is looking at.
      if (desk.focused()) return
      desk.notify(session, () => desk.open(session.sessionId))
    },

    dispose(): void {
      if (!alive) return
      alive = false
      unsubscribe()
      // Nothing of this launch is left on the dock icon.
      desk.badge(0)
    }
  }
}

// A launch that should stay quiet: the fake flavor, where an agent driving the
// window would otherwise post banners onto the human's machine.
export function stillNeedsYouService(): LiveNeedsYouService {
  return {
    async waiting(): Promise<void> {},
    async announce(): Promise<void> {},
    dispose(): void {}
  }
}
