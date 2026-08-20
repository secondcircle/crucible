// @vitest-environment node
//
// One fact governs both channels — whether the window has focus — so these
// tests are mostly about that fact changing under them.
import { describe, expect, it } from 'vitest'
import type { WaitingSession } from '../../shared/needs-you/service'
import { createNeedsYouService, type NeedsYouDesk, stillNeedsYouService } from './service'

const FINISHED: WaitingSession = {
  sessionId: 's2',
  workspace: 'crucible',
  title: 'Quota strip rounds the wrong way past $10'
}

function desk(startFocused: boolean): {
  readonly desk: NeedsYouDesk
  readonly badges: number[]
  readonly banners: WaitingSession[]
  readonly opened: string[]
  click(): void
  focus(focused: boolean): void
} {
  let focused = startFocused
  const listeners = new Set<(focused: boolean) => void>()
  const badges: number[] = []
  const banners: WaitingSession[] = []
  const opened: string[] = []
  let clicked: (() => void) | undefined

  return {
    desk: {
      focused: () => focused,
      onFocusChanged(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      badge: (count) => badges.push(count),
      notify(session, onOpen) {
        banners.push(session)
        clicked = onOpen
      },
      open: (sessionId) => opened.push(sessionId)
    },
    badges,
    banners,
    opened,
    click: () => clicked?.(),
    focus(next: boolean) {
      focused = next
      for (const listener of listeners) listener(next)
    }
  }
}

describe('the dock badge', () => {
  it('stays off while the window has focus, however many are waiting', async () => {
    const bench = desk(true)
    const service = createNeedsYouService(bench.desk)

    await service.waiting(3)

    expect(bench.badges).toEqual([0])
  })

  it('carries what was already waiting the moment the window is left', async () => {
    const bench = desk(true)
    const service = createNeedsYouService(bench.desk)
    await service.waiting(3)

    bench.focus(false)

    expect(bench.badges.at(-1)).toBe(3)
  })

  it('clears when the window comes back', async () => {
    const bench = desk(false)
    const service = createNeedsYouService(bench.desk)
    await service.waiting(2)

    bench.focus(true)

    expect(bench.badges.at(-1)).toBe(0)
  })

  it('leaves nothing on the dock icon when the launch ends', () => {
    const bench = desk(false)
    const service = createNeedsYouService(bench.desk)

    service.dispose()

    expect(bench.badges.at(-1)).toBe(0)
  })

  it('is deaf to focus once disposed', () => {
    const bench = desk(true)
    const service = createNeedsYouService(bench.desk)
    service.dispose()
    const after = bench.badges.length

    bench.focus(false)

    expect(bench.badges.length).toBe(after)
  })
})

describe('the banner', () => {
  it('does not appear while the user is looking at the app', async () => {
    const bench = desk(true)

    await createNeedsYouService(bench.desk).announce(FINISHED)

    expect(bench.banners).toEqual([])
  })

  it('names the workspace and the session when the app is behind something', async () => {
    const bench = desk(false)

    await createNeedsYouService(bench.desk).announce(FINISHED)

    expect(bench.banners).toEqual([FINISHED])
  })

  it('opens the session it was about when it is clicked', async () => {
    const bench = desk(false)
    await createNeedsYouService(bench.desk).announce(FINISHED)

    bench.click()

    expect(bench.opened).toEqual(['s2'])
  })
})

describe('a quiet launch', () => {
  it('answers every question without a dock or a Notification to reach for', async () => {
    const service = stillNeedsYouService()

    await expect(service.waiting(4)).resolves.toBeUndefined()
    await expect(service.announce(FINISHED)).resolves.toBeUndefined()
    expect(() => service.dispose()).not.toThrow()
  })
})
