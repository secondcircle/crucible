// What crosses out of an exhibit guest, against a fake window: one key, one
// direction, and the page keeps every press it was given.
import { describe, expect, it } from 'vitest'
import type { ExhibitKeyEvent } from '../../shared/exhibits/channels'
import {
  exhibitKeyOf,
  watchExhibitKeys,
  type ExhibitKeyHost,
  type GuestInput,
  type GuestKeys
} from './guest-keys'

interface FakeHost extends ExhibitKeyHost {
  /** A guest attaching to the window, as electron announces one. */
  attach(): (input: GuestInput) => void
  readonly announced: readonly ExhibitKeyEvent[]
  destroy(): void
}

function fakeHost(): FakeHost {
  const announced: ExhibitKeyEvent[] = []
  let hearGuest: ((guest: GuestKeys) => void) | undefined
  let destroyed = false

  return {
    onGuestAttached: (hear) => {
      hearGuest = hear
    },
    announce: (event) => announced.push(event),
    gone: () => destroyed,
    announced,

    attach(): (input: GuestInput) => void {
      let heard: ((input: GuestInput) => void) | undefined
      hearGuest?.({
        onInput: (hear) => {
          heard = hear
        }
      })
      if (heard === undefined) throw new Error('nothing is watching for guests')
      return heard
    },

    destroy(): void {
      destroyed = true
    }
  }
}

describe('which key crosses', () => {
  it('is Escape, on the way down', () => {
    expect(exhibitKeyOf({ type: 'keyDown', key: 'Escape' })).toEqual({ key: 'escape' })
  })

  it('is nothing else at all', () => {
    for (const key of ['Enter', 'Tab', 'r', 'R', 'a', ' ', 'Backspace', 'escape', 'Esc', 'F5']) {
      expect(exhibitKeyOf({ type: 'keyDown', key })).toBeUndefined()
    }
  })

  it('is not the way back up, so one press is one event', () => {
    expect(exhibitKeyOf({ type: 'keyUp', key: 'Escape' })).toBeUndefined()
    expect(exhibitKeyOf({ type: 'char', key: 'Escape' })).toBeUndefined()
  })
})

describe('watching a window\u2019s guests', () => {
  it('announces the guest\u2019s Escape to the window, once per press', () => {
    const host = fakeHost()
    watchExhibitKeys(host)
    const press = host.attach()

    press({ type: 'keyDown', key: 'Escape' })
    press({ type: 'keyUp', key: 'Escape' })
    press({ type: 'keyDown', key: 'Escape' })

    expect(host.announced).toEqual([{ key: 'escape' }, { key: 'escape' }])
  })

  it('says nothing about any other key the page was given', () => {
    const host = fakeHost()
    watchExhibitKeys(host)
    const press = host.attach()

    for (const key of ['a', 'Enter', 'Tab', 'r', 'ArrowDown']) {
      press({ type: 'keyDown', key })
    }

    expect(host.announced).toEqual([])
  })

  it('watches every guest the window attaches, not only the first', () => {
    const host = fakeHost()
    watchExhibitKeys(host)
    const first = host.attach()
    const second = host.attach()

    first({ type: 'keyDown', key: 'Escape' })
    second({ type: 'keyDown', key: 'Escape' })

    expect(host.announced).toHaveLength(2)
  })

  // The press is copied to the window, never taken from the page: what main
  // hands over carries no way to consume it, and nothing here reaches for one.
  it('leaves the press with the page', () => {
    const host = fakeHost()
    watchExhibitKeys(host)
    const press = host.attach()
    let consumed = false
    const pressed = {
      type: 'keyDown',
      key: 'Escape',
      preventDefault: () => {
        consumed = true
      }
    }

    press(pressed)

    expect(host.announced).toEqual([{ key: 'escape' }])
    expect(consumed).toBe(false)
  })

  it('says nothing to a window that has gone', () => {
    const host = fakeHost()
    watchExhibitKeys(host)
    const press = host.attach()
    host.destroy()

    press({ type: 'keyDown', key: 'Escape' })

    expect(host.announced).toEqual([])
  })
})
