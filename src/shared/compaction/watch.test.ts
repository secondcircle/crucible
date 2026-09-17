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

// A fixed setting, or a function where a test moves the switch under a
// conversation that is already being watched.
function watching(
  settings: CompactionSettings | (() => CompactionSettings) = ON,
  retention: '1h' | '5m' = '1h'
): void {
  watch = createCompactionWatch({
    settings: typeof settings === 'function' ? settings : () => settings,
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

  // The size rules are not rules about the cache: a provider that reports no
  // prefix still gets its threshold and its window edge.
  it('runs on a size reported without any cache instant', () => {
    watching()
    watch.saw('a', { usedTokens: 210_000, contextWindow: 1_000_000 })
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

  // A compaction takes the recent span as it finds it. One that lands still
  // over the threshold — a single turn bigger than the setting — would keep
  // the same span and report the same size on every pass.
  it('does not compact a conversation its own compaction left over the threshold', () => {
    watching({ enabled: true, thresholdK: 40 })
    watch.saw('a', { lastRequestAt: 0, usedTokens: 210_000, contextWindow: 1_000_000 })
    expect(fired).toHaveLength(1)

    watch.saw('a', { lastRequestAt: 0, usedTokens: 60_000, contextWindow: 1_000_000 })
    watch.saw('a', { lastRequestAt: 0, usedTokens: 60_000, contextWindow: 1_000_000 })
    expect(fired).toHaveLength(1)
  })

  it('compacts again once the conversation has grown past what that left', () => {
    watching({ enabled: true, thresholdK: 40 })
    watch.saw('a', { lastRequestAt: 0, usedTokens: 210_000, contextWindow: 1_000_000 })
    watch.saw('a', { lastRequestAt: 0, usedTokens: 60_000, contextWindow: 1_000_000 })

    watch.saw('a', { lastRequestAt: 0, usedTokens: 90_000, contextWindow: 1_000_000 })
    expect(fired).toHaveLength(2)
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

  // Nothing was reported to be holding a prefix, so there is no lapse to run
  // ahead of and no timer worth arming.
  it('does not run on a conversation that reported no cache instant', () => {
    watching()
    watch.saw('a', { usedTokens: 120_000, contextWindow: 1_000_000 })
    expect(clock.pending()).toBe(0)
    clock.advance(4 * 60 * 60 * 1000)
    expect(fired).toEqual([])
  })

  it('does not exist under five-minute retention', () => {
    watching(ON, '5m')
    watch.saw('a', { lastRequestAt: 0, usedTokens: 120_000, contextWindow: 1_000_000 })
    clock.advance(4 * 60 * 60 * 1000)
    expect(fired).toEqual([])
  })

  // An idle compaction is a paid background request that rewrites what the
  // agent reads. The switch is the switch for the feature, and the one thing
  // ruled to survive it being off is the model's own window edge.
  it('does not run with the switch off', () => {
    watching({ enabled: false, thresholdK: 200 })
    watch.saw('a', { lastRequestAt: 0, usedTokens: 120_000, contextWindow: 1_000_000 })
    clock.advance(51 * 60 * 1000)
    expect(fired).toEqual([])
  })

  // The setting is read when the clock strikes, not when it was armed: a
  // conversation left sitting under a switch that was on is governed by the
  // switch as it stands now.
  it('is called off by a switch turned off while the conversation sat', () => {
    let settings: CompactionSettings = ON
    watching(() => settings)
    watch.saw('a', { lastRequestAt: 0, usedTokens: 120_000, contextWindow: 1_000_000 })
    settings = { enabled: false, thresholdK: 200 }
    clock.advance(51 * 60 * 1000)
    expect(fired).toEqual([])
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
