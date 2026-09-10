import type { Unsubscribe } from '../../../shared/agent/port'
import type { ExhibitKeyEvent } from '../../../shared/exhibits/channels'
import type { ExhibitKeysService } from '../../../shared/exhibits/service'

// jsdom hosts no webview guest, so this stands where one would: a test presses
// Escape in the page and the document hears exactly what main would say.

export interface ScriptedExhibitKeys extends ExhibitKeysService {
  pressEscape(): void
}

export function createScriptedExhibitKeys(): ScriptedExhibitKeys {
  const listeners = new Set<(event: ExhibitKeyEvent) => void>()

  return {
    onEvent(listener: (event: ExhibitKeyEvent) => void): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    pressEscape(): void {
      for (const listener of [...listeners]) listener({ key: 'escape' })
    }
  }
}
