import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { EVENT_CHANNEL, PROMPT_CHANNEL } from '../shared/agent/channels'
import type { PortEvent, TurnId } from '../shared/agent/port'

/**
 * The preload surface: one object, `window.crucible`, with one member (D7).
 *
 * This is the whole of what the sandboxed renderer can reach of Electron —
 * deliberately not the `window.electron.ipcRenderer` passthrough the scaffolds
 * ship, which Electron's own context-isolation documentation calls the unsafe
 * pattern. Two operations, shaped like the agent port they serve, are all the
 * IPC client needs; nothing else is exposed and nothing here is a general
 * channel.
 *
 * `onEvent` forwards the payload only. The Electron event object is named here
 * and dropped here, so nothing carrying a `sender` — a handle onto the whole of
 * `webContents` — ever crosses into the renderer's world.
 *
 * The file is bundled to one file so it loads under `sandbox: true` (D2, A5):
 * its two imports are Crucible's own, one of them types alone, so nothing but
 * `electron` is required at runtime.
 */
contextBridge.exposeInMainWorld('crucible', {
  agent: {
    prompt: (text: string): Promise<TurnId> => ipcRenderer.invoke(PROMPT_CHANNEL, text),

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
