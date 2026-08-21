import { app, BrowserWindow, Notification } from 'electron'
import type { SessionId } from '../../shared/agent/port'
import type { Flavor } from '../agent/select-adapter'
import type { LogSink } from '../log/sink'
import {
  createNeedsYouService,
  stillNeedsYouService,
  type LiveNeedsYouService,
  type NeedsYouDesk
} from './service'

export type NeedsYouServiceKind = 'quiet' | 'live'

// Pure, so the rule is testable without constructing anything. A fake-flavor
// launch stays quiet: those windows are driven by agents, and every banner one
// posted would land in the human's notification centre from an app they are
// not using.
export function needsYouServiceKind(flavor: Flavor): NeedsYouServiceKind {
  return flavor === 'sdk' ? 'live' : 'quiet'
}

export function selectNeedsYouService(
  flavor: Flavor,
  window: BrowserWindow,
  log: LogSink,
  open: (sessionId: SessionId) => void
): LiveNeedsYouService {
  const kind = needsYouServiceKind(flavor)
  log.append({ source: 'main', event: 'needs_you_service_selected', service: kind })
  if (kind === 'quiet') return stillNeedsYouService()
  return createNeedsYouService(electronDesk(window, open))
}

// The whole of what this feature touches of the OS: a number on the dock icon,
// and a banner that plays macOS's default notification sound unless the burst
// guard has already spent the chime on a banner just before it. Non-silent
// hands the sound to macOS, so System Settings › Notifications › Crucible is
// what turns it off.
function electronDesk(window: BrowserWindow, open: (sessionId: SessionId) => void): NeedsYouDesk {
  return {
    focused: () => window.isFocused(),

    onFocusChanged(listener) {
      const focused = (): void => listener(true)
      const blurred = (): void => listener(false)
      window.on('focus', focused)
      window.on('blur', blurred)
      return () => {
        window.off('focus', focused)
        window.off('blur', blurred)
      }
    },

    badge(count: number) {
      // Electron reads 0 as "no badge", which is the clearing we want.
      app.setBadgeCount(count)
    },

    notify(session, sound, onOpen) {
      if (!Notification.isSupported()) return
      const banner = new Notification({
        title: `${session.workspace} · finished`,
        body: session.title,
        silent: !sound
      })
      banner.on('click', onOpen)
      banner.show()
    },

    open(sessionId: SessionId) {
      // Forward first, so the session the banner named is on screen in a
      // window the user can see.
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
      open(sessionId)
    }
  }
}
