import type { Unsubscribe } from '../agent/port'
import type { ExhibitKeyEvent } from './channels'

/**
 * Keys that come out of an exhibit guest. One way and one member: the renderer
 * asks nothing of it, and nothing about the panel's state goes back.
 */
export interface ExhibitKeysService {
  onEvent(listener: (event: ExhibitKeyEvent) => void): Unsubscribe
}
