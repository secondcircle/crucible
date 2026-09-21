import { beforeEach, describe, expect, it } from 'vitest'
import { MIN_THRESHOLD_K, type CompactionSettings } from './settings'
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
// The lowest the field goes, where a compaction's own result sits closest to
// the threshold that asked for it.
const LOW: CompactionSettings = { enabled: true, thresholdK: MIN_THRESHOLD_K }

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

  // The skeleton may not drop what the user said unless the model strikes
  // it. A compaction that lands still over the threshold — a conversation
  // whose words alone are bigger than the setting — would write the same
  // skeleton and report the same size on every pass. The guard is not
  // "has it grown": one token of growth is growth, and the turn after a
  // compaction always has some, so a build that asked that would compact on
  // every turn from there on, forever.
  it('does not compact again on the turns after a compaction that landed over the threshold', () => {
    watching(LOW)
    watch.saw('a', { lastRequestAt: 0, usedTokens: 300_000, contextWindow: 1_000_000 })
    expect(fired).toHaveLength(1)

    // The compaction's own result, reported with every size after it because
    // it is written down with the conversation, then ordinary turns on top.
    watch.compacted('a')
    const after = { contextWindow: 1_000_000, compactedTo: 100_000 }
    watch.saw('a', { lastRequestAt: 1, usedTokens: 100_000, ...after })
    watch.saw('a', { lastRequestAt: 2, usedTokens: 101_000, ...after })
    watch.saw('a', { lastRequestAt: 3, usedTokens: 118_000, ...after })
    expect(fired).toHaveLength(1)
  })

  // The launch that compacted is not the only one that has to know. A
  // conversation restored next launch reports what its own last compaction
  // left it at along with its size — the number is on the conversation, not in
  // a map that died with the app — so the rule answers the same way on a
  // watch that has never seen it before.
  it('refuses a conversation restored on a compaction it has never seen', () => {
    watching(LOW)

    watch.saw('restored', {
      lastRequestAt: 0,
      usedTokens: 110_595,
      contextWindow: 1_000_000,
      compactedTo: 110_595
    })

    expect(fired).toEqual([])
  })

  // Nothing was rewritten — there was no boundary to cut at, or the model call
  // failed — so the conversation is exactly what it was and the rules judge it
  // as they did before. Remembering a failure as a result would leave a
  // conversation that could not be compacted once uncompactable for good,
  // which at the window edge is the dead conversation the last resort exists
  // to prevent.
  it('holds nothing against a conversation whose compaction never landed', () => {
    watching(LOW)
    watch.saw('a', { lastRequestAt: 0, usedTokens: 300_000, contextWindow: 1_000_000 })
    expect(fired).toHaveLength(1)

    watch.compacted('a')
    // Nothing was written, so the conversation reports no compaction of its
    // own to be weighed against.
    watch.saw('a', { lastRequestAt: 1, usedTokens: 301_000, contextWindow: 1_000_000 })
    expect(fired).toHaveLength(2)
  })

  // Between asking for a compaction and hearing what it did, there is no size
  // to judge: the conversation is being rewritten underneath the facts.
  it('fires nothing for a conversation whose compaction is still out', () => {
    watching(LOW)
    watch.saw('a', { lastRequestAt: 0, usedTokens: 300_000, contextWindow: 1_000_000 })

    watch.saw('a', { lastRequestAt: 1, usedTokens: 300_000, contextWindow: 1_000_000 })
    watch.settled('a')
    expect(fired).toHaveLength(1)
  })

  // The turn that crossed the threshold reports its size once more as it
  // ends, after the ask has gone out, and π reports nothing for the rewritten
  // conversation until it has answered a request. So the next turn's end is
  // the first settle after the compaction, and the only facts in hand are the
  // old conversation's. A build that judged them compacted a 207k conversation
  // and then, one turn later, the 68k one it left behind.
  it('drops the facts of the conversation a compaction rewrote', () => {
    watching()
    watch.saw('a', { lastRequestAt: 0, usedTokens: 207_000, contextWindow: 1_000_000 })
    watch.settled('a')
    expect(fired).toHaveLength(1)

    // The turn-end report of the conversation being rewritten.
    watch.saw('a', { lastRequestAt: 1, usedTokens: 207_000, contextWindow: 1_000_000 })
    watch.compacted('a')

    // The next turn: π has no size to give until its answer lands, so the
    // turn settles on no fresh facts at all.
    watch.settled('a')
    expect(fired).toHaveLength(1)

    // The rewritten conversation's own size, once π knows it.
    watch.saw('a', {
      lastRequestAt: 2,
      usedTokens: 68_000,
      contextWindow: 1_000_000,
      compactedTo: 42_000
    })
    watch.settled('a')
    expect(fired).toHaveLength(1)
  })

  // Rare and large: the next one waits until there is a whole compacted
  // window's worth of new conversation for it to take away.
  it('compacts again once there is as much to take away as the last one left', () => {
    watching(LOW)
    watch.saw('a', { lastRequestAt: 0, usedTokens: 300_000, contextWindow: 1_000_000 })
    watch.compacted('a')
    const after = { contextWindow: 1_000_000, compactedTo: 100_000 }
    watch.saw('a', { lastRequestAt: 1, usedTokens: 100_000, ...after })

    watch.saw('a', { lastRequestAt: 2, usedTokens: 199_000, ...after })
    expect(fired).toHaveLength(1)

    watch.saw('a', { lastRequestAt: 3, usedTokens: 200_000, ...after })
    expect(fired).toHaveLength(2)
  })

  // "Compacts once as a last resort" means once. A conversation its own
  // compaction left at the model's window edge cannot be moved by another
  // one; every send from there would buy the same window again.
  it('compacts at the window edge once, not on every send after it', () => {
    watching({ enabled: false, thresholdK: 200 })
    watch.saw('a', { lastRequestAt: 0, usedTokens: 190_000, contextWindow: 200_000 })
    expect(fired).toEqual([{ id: 'a', trigger: 'windowEdge' }])

    // The words alone fill the window: what it wrote is still at the edge.
    watch.compacted('a')
    const edge = { contextWindow: 200_000, compactedTo: 188_000 }
    watch.saw('a', { lastRequestAt: 1, usedTokens: 188_000, ...edge })
    watch.saw('a', { lastRequestAt: 2, usedTokens: 189_000, ...edge })
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
