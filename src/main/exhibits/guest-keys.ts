import type { ExhibitKeyEvent } from '../../shared/exhibits/channels'

// An exhibit guest is a webContents of its own, so a key pressed inside a page
// never reaches the window's document. Exactly one key is carried across, and
// it is carried rather than taken: the page keeps the press as well.

export interface GuestInput {
  readonly type: string
  readonly key: string
}

export interface GuestKeys {
  onInput(hear: (input: GuestInput) => void): void
}

export interface ExhibitKeyHost {
  /** Called once per guest attached, for as long as the window lives. */
  onGuestAttached(hear: (guest: GuestKeys) => void): void
  announce(event: ExhibitKeyEvent): void
  /** Whether the window has gone; nothing is announced after it has. */
  gone(): boolean
}

/**
 * Escape and nothing else, modifiers ignored, key-down only. The press is
 * never consumed, so the page sees it too and keeps every other key it would
 * get.
 */
export function exhibitKeyOf(input: GuestInput): ExhibitKeyEvent | undefined {
  if (input.type !== 'keyDown') return undefined
  if (input.key !== 'Escape') return undefined
  return { key: 'escape' }
}

export function watchExhibitKeys(host: ExhibitKeyHost): void {
  host.onGuestAttached((guest) => {
    guest.onInput((input) => {
      const event = exhibitKeyOf(input)
      if (event === undefined) return
      if (host.gone()) return
      host.announce(event)
    })
  })
}
