import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  EVENT_CHANNEL,
  REQUEST_CHANNEL,
  type PortRequest,
  type PortResult
} from '../shared/agent/channels'
import type { PortEvent } from '../shared/agent/port'

/**
 * The preload surface: one object, `window.crucible`, shaped like the agent
 * port and forwarding payloads only.
 *
 * This is the whole of what the sandboxed renderer can reach of Electron —
 * deliberately not the `window.electron.ipcRenderer` passthrough the scaffolds
 * ship, which Electron's own context-isolation documentation calls the unsafe
 * pattern. Two members are all the IPC client needs: `request`, which carries
 * one named port operation, and `onEvent`. Nothing else is exposed, and nothing
 * here is a general channel: an operation main does not serve is refused by
 * main, not by a check duplicated here.
 *
 * `onEvent` forwards the payload only. The Electron event object is named here
 * and dropped here, so nothing carrying a `sender` — a handle onto the whole of
 * `webContents` — ever crosses into the renderer's world.
 *
 * The file is bundled to one file so it loads under `sandbox: true`: its two
 * imports are Crucible's own, one of them types alone, so nothing but
 * `electron` is required at runtime.
 */
contextBridge.exposeInMainWorld('crucible', {
  agent: {
    request: (request: PortRequest): Promise<PortResult> =>
      ipcRenderer.invoke(REQUEST_CHANNEL, request),

    onEvent: (listener: (event: PortEvent) => void): (() => void) => {
      // Never `ipcRenderer.on(EVENT_CHANNEL, listener)`: that hands the caller
      // the Electron event as its first argument.
      const forward = (_electronEvent: IpcRendererEvent, event: PortEvent): void => {
        listener(event)
      }
      ipcRenderer.on(EVENT_CHANNEL, forward)
      return () => {
        ipcRenderer.off(EVENT_CHANNEL, forward)
      }
    }
  }
})

// How a running app shows the bundled preload was loaded: it appears in the
// renderer's console, before anything the renderer itself says.
console.info('[crucible] preload loaded')
