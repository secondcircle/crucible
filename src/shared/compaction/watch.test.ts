import { beforeEach, describe, expect, it } from 'vitest'
import type { CompactionSettings } from './settings'
import type { CompactionTrigger } from './record'
import { createCompactionWatch, type CompactionWatch } from './watch'

// A hand-cranked clock and timer, so the idle rule is tested at the minute it
// is written for rather than by waiting fifty of them.
function timers(): {
  readonly now: () => number
  readonly setTimer: (run: () => void, ms: number) => unknown
  readonly clearTimer: (handle: unknown) => void
  advance: (ms: number) => void
  readonly pending: () => number
} {
  let clock = 0
  const armed = new Map<number, { at: number; run: () => void }>()
  let minted = 0
  return {
    now: () => clock,
    setTimer: (run, ms) => {
      minted += 1
      armed.set(minted, { at: clock + ms, run })
      return minted
    },
    clearTimer: (handle) => {
      armed.delete(handle as number)
    },
    advance: (ms) => {
      clock += ms
      for (const [id, timer] of [...armed]) {
        if (timer.at > clock) continue
        armed.delete(id)
        timer.run()
      }
    },
    pending: () => armed.size
  }
}

const ON: CompactionSettings = { enabled: true, thresholdK: 200 }

let clock: ReturnType<typeof timers>
let fired: { id: string; trigger: CompactionTrigger }[]
let busy: Set<string>
let watch: CompactionWatch

function watching(settings: CompactionSettings = ON, retention: '1h' | '5m' = '1h'): void {
  watch = createCompactionWatch({
    settings: () => settings,
    retention,
    idle: (id) => !busy.has(id),
    compact: (id, trigger) => fired.push({ id, trigger }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  })
}

beforeEach(() => {
  clock = timers()
  fired = []
  busy = new Set()
})

describe('the size rules', () => {
  it('compacts as soon as the reported size calls for it', () => {
    watching()
    watch.saw('a', { lastRequestAt: 0, usedTokens: 210_000, contextWindow: 1_000_000 })
    expect(fired).toEqual([{ id: 'a', trigger: 'threshold' }])
  })

  // A compaction takes the conversation away from whoever is using it, so the
  // trigger waits for the turn rather than landing inside it.
  it('holds a trigger that came due mid-turn until the turn ends', () => {
    watching()
    busy.add('a')
    watch.saw('a', { lastRequestAt: 0, usedTokens: 210_000, contextWindow: 1_000_000 })
    expect(fired).toEqual([])

    busy.delete('a')
    watch.settled('a')
    expect(fired).toEqual([{ id: 'a', trigger: 'threshold' }])
  })

  // Right after a compaction π reports no size at all; the old facts would
  // fire again forever.
  it('fires once and then waits for facts that describe the new conversation', () => {
    watching()
    watch.saw('a', { lastRequestAt: 0, usedTokens: 210_000, contextWindow: 1_000_000 })
    watch.settled('a')
    watch.settled('a')
    expect(fired).toHaveLength(1)
  })
})

describe('the idle clock', () => {
  it('fires fifty minutes after the last billed request', () => {
    watching()
    watch.saw('a', { lastRequestAt: 0, usedTokens: 120_000, contextWindow: 1_000_000 })
    clock.advance(49 * 60 * 1000)
    expect(fired).toEqual([])

    clock.advance(60 * 1000)
    expect(fired).toEqual([{ id: 'a', trigger: 'idle' }])
  })

  // The deadline belongs to the cache, not to the timer: a turn at minute 30
  // moves it to minute 80, not to minute 50 plus thirty.
  it('re-arms from the newest request rather than from now', () => {
    watching()
    watch.saw('a', { lastRequestAt: 0, usedTokens: 120_000, contextWindow: 1_000_000 })
    clock.advance(30 * 60 * 1000)
    watch.saw('a', {
      lastRequestAt: clock.now(),
      usedTokens: 140_000,
      contextWindow: 1_000_000
    })
    clock.advance(45 * 60 * 1000)
    expect(fired).toEqual([])
    clock.advance(6 * 60 * 1000)
    expect(fired).toEqual([{ id: 'a', trigger: 'idle' }])
  })

  it('does not exist under five-minute retention', () => {
    watching(ON, '5m')
    watch.saw('a', { lastRequestAt: 0, usedTokens: 120_000, contextWindow: 1_000_000 })
    clock.advance(4 * 60 * 60 * 1000)
    expect(fired).toEqual([])
  })

  it('runs with the switch off, because it is about the cache and not the size', () => {
    watching({ enabled: false, thresholdK: 200 })
    watch.saw('a', { lastRequestAt: 0, usedTokens: 120_000, contextWindow: 1_000_000 })
    clock.advance(51 * 60 * 1000)
    expect(fired).toEqual([{ id: 'a', trigger: 'idle' }])
  })

  it('leaves a working conversation alone when its moment comes', () => {
    watching()
    watch.saw('a', { lastRequestAt: 0, usedTokens: 120_000, contextWindow: 1_000_000 })
    busy.add('a')
    clock.advance(51 * 60 * 1000)
    expect(fired).toEqual([])
  })

  it('outlives no conversation and no shell', () => {
    watching()
    watch.saw('a', { lastRequestAt: 0, usedTokens: 120_000, contextWindow: 1_000_000 })
    watch.saw('b', { lastRequestAt: 0, usedTokens: 120_000, contextWindow: 1_000_000 })
    watch.forget('a')
    watch.dispose()
    expect(clock.pending()).toBe(0)
    clock.advance(4 * 60 * 60 * 1000)
    expect(fired).toEqual([])
  })
})
