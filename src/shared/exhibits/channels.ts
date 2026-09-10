// Preload and main have to agree letter for letter here, as on every channel.
export const EXHIBIT_KEY_EVENT_CHANNEL = 'crucible:exhibits:key'

/**
 * A key an exhibit guest pressed that the window is told about. One variant,
 * on purpose: Escape is the only key the app takes from a page, and adding a
 * second is a deliberate edit at both ends of the channel.
 */
export interface ExhibitKeyEvent {
  readonly key: 'escape'
}
