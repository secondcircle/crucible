// @vitest-environment node
//
// One fact governs both channels — whether the window has focus — so these
// tests are mostly about that fact changing under them.
import { describe, expect, it } from 'vitest'
import type { WaitingSession } from '../../shared/needs-you/service'
import {
  BURST_WINDOW_MS,
  createNeedsYouService,
  type NeedsYouDesk,
  stillNeedsYouService
} from './service'

const FINISHED: WaitingSession = {
  sessionId: 's2',
  workspace: 'crucible',
  title: 'Quota strip rounds the wrong way past $10'
}

function desk(startFocused: boolean): {
  readonly desk: NeedsYouDesk
  readonly badges: number[]
  readonly banners: WaitingSession[]
  /** One entry per banner, in step with `banners`: did it sound? */
  readonly sounds: boolean[]
  readonly opened: string[]
  click(): void
  focus(focused: boolean): void
  /** The clock the service reads, in milliseconds. */
  now(): number
  wait(ms: number): void
} {
  let focused = startFocused
  let clock = 1_000
  const listeners = new Set<(focused: boolean) => void>()
  const badges: number[] = []
  const banners: WaitingSession[] = []
  const sounds: boolean[] = []
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
      notify(session, sound, onOpen) {
        banners.push(session)
        sounds.push(sound)
        clicked = onOpen
      },
      open: (sessionId) => opened.push(sessionId)
    },
    badges,
    banners,
    sounds,
    opened,
    click: () => clicked?.(),
    focus(next: boolean) {
      focused = next
      for (const listener of listeners) listener(next)
    },
    now: () => clock,
    wait(ms: number) {
      clock += ms
    }
  }
}

function finish(n: number): WaitingSession {
  return { ...FINISHED, sessionId: `s${n}`, title: `Finish ${n}` }
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

describe('the sound', () => {
  it('plays on a finish that nothing has sounded before', async () => {
    const bench = desk(false)

    await createNeedsYouService(bench.desk, bench.now).announce(FINISHED)

    expect(bench.sounds).toEqual([true])
  })

  it('is spent for the burst: the ones close behind arrive silent', async () => {
    const bench = desk(false)
    const service = createNeedsYouService(bench.desk, bench.now)

    await service.announce(finish(1))
    bench.wait(BURST_WINDOW_MS - 1)
    await service.announce(finish(2))

    expect(bench.sounds).toEqual([true, false])
  })

  it('plays again for a finish later than the burst window', async () => {
    const bench = desk(false)
    const service = createNeedsYouService(bench.desk, bench.now)

    await service.announce(finish(1))
    bench.wait(BURST_WINDOW_MS)
    await service.announce(finish(2))

    expect(bench.sounds).toEqual([true, true])
  })

  it('measures the window from the last banner that sounded, not the last one posted', async () => {
    const bench = desk(false)
    const service = createNeedsYouService(bench.desk, bench.now)

    // Three inside one window, then one just past it: the silenced pair in the
    // middle must not push the window along.
    await service.announce(finish(1))
    bench.wait(BURST_WINDOW_MS - 2)
    await service.announce(finish(2))
    bench.wait(1)
    await service.announce(finish(3))
    bench.wait(1)
    await service.announce(finish(4))

    expect(bench.sounds).toEqual([true, false, false, true])
  })

  it('silences a burst without swallowing any of it', async () => {
    const bench = desk(false)
    const service = createNeedsYouService(bench.desk, bench.now)

    // A lunch break: four sessions finish within seconds of each other.
    for (const n of [1, 2, 3, 4]) {
      await service.announce(finish(n))
      bench.wait(500)
    }

    expect(bench.banners.map((session) => session.sessionId)).toEqual(['s1', 's2', 's3', 's4'])
    expect(bench.sounds).toEqual([true, false, false, false])
  })

  it('leaves the guard untouched by finishes the user was already looking at', async () => {
    const bench = desk(true)
    const service = createNeedsYouService(bench.desk, bench.now)

    // Focused: no banner, no sound, and nothing spent. Leaving the window and
    // finishing again must still sound.
    await service.announce(finish(1))
    bench.focus(false)
    await service.announce(finish(2))

    expect(bench.sounds).toEqual([true])
  })

  it('reads the wall clock when no time source is handed to it', async () => {
    const bench = desk(false)

    const service = createNeedsYouService(bench.desk)
    await service.announce(finish(1))
    await service.announce(finish(2))

    expect(bench.sounds).toEqual([true, false])
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
