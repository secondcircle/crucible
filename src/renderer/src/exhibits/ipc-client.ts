import type { Unsubscribe } from '../../../shared/agent/port'
import type { ExhibitKeyEvent } from '../../../shared/exhibits/channels'
import type { ExhibitKeysService } from '../../../shared/exhibits/service'
import { exhibitKeysBridge } from '../bridge'

// The renderer's side of the exhibit-key channel. It holds nothing: main
// announces a press and the document decides what it means.

export function createExhibitKeysClient(): ExhibitKeysService {
  const bridge = exhibitKeysBridge()
  return {
    onEvent: (listener: (event: ExhibitKeyEvent) => void): Unsubscribe => bridge.onEvent(listener)
  }
}
