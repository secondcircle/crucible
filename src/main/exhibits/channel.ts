import type { BrowserWindow, Event, Input, WebContents } from 'electron'
import { EXHIBIT_KEY_EVENT_CHANNEL } from '../../shared/exhibits/channels'
import { watchExhibitKeys, type GuestKeys } from './guest-keys'

// Plumbing only, exactly as the other channels are: which key crosses is the
// watcher's rule, and this is the host it reads one window's guests through.

export interface ExhibitKeyChannel {
  dispose(): void
}

export function serveExhibitKeyChannel(window: BrowserWindow): ExhibitKeyChannel {
  // What dispose has to guarantee is that nothing is announced afterwards: the
  // guests and their listeners go with the window that owned them.
  let serving = true

  watchExhibitKeys({
    onGuestAttached: (hear) => {
      window.webContents.on('did-attach-webview', (_event: Event, guest: WebContents) => {
        const keys: GuestKeys = {
          onInput: (heard) => {
            // Never `preventDefault`: the press is copied to the window, not
            // taken from the page.
            guest.on('before-input-event', (_pressed: Event, input: Input) =>
              heard({ type: input.type, key: input.key })
            )
          }
        }
        hear(keys)
      })
    },
    announce: (event) => window.webContents.send(EXHIBIT_KEY_EVENT_CHANNEL, event),
    gone: () => !serving || window.isDestroyed()
  })

  function dispose(): void {
    serving = false
  }

  window.on('closed', dispose)

  return { dispose }
}
