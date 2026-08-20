import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  EVENT_CHANNEL,
  REQUEST_CHANNEL,
  type PortRequest,
  type PortResult
} from '../shared/agent/channels'
import type { PortEvent } from '../shared/agent/port'

// The whole of what the sandboxed renderer can reach of Electron. Two members,
// no general `ipcRenderer` passthrough, and payloads only: nothing carrying a
// `sender` may cross into the renderer's world.
//
// Bundled to a single file so it loads under `sandbox: true`.
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

// The one signal that the bundled preload loaded at all, which is otherwise
// invisible in a running app.
console.info('[crucible] preload loaded')
