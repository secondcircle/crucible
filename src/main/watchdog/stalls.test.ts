import { describe, expect, it } from 'vitest'
import { createMemorySink } from '../log/sink'
import {
  type CpuProfile,
  heaviestStack,
  stallFrames,
  type StallProfiler,
  startStallWatchdog
} from './stalls'

// A profile of 10 samples at 100ms each: the first six idle, the last four
// inside `readFileSync` called from `load`, called from `open`.
const profile: CpuProfile = {
  startTime: 1_000_000,
  endTime: 2_000_000,
  nodes: [
    { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, children: [2, 3] },
    { id: 2, callFrame: { functionName: '(idle)', url: '', lineNumber: -1 } },
    {
      id: 3,
      callFrame: { functionName: 'open', url: 'file:///app/shell.js', lineNumber: 9 },
      children: [4]
    },
    {
      id: 4,
      callFrame: { functionName: 'load', url: 'file:///app/store.js', lineNumber: 41 },
      children: [5]
    },
    { id: 5, callFrame: { functionName: 'readFileSync', url: 'node:fs', lineNumber: 0 } }
  ],
  samples: [2, 2, 2, 2, 2, 2, 5, 5, 5, 4],
  timeDeltas: [0, 100_000, 100_000, 100_000, 100_000, 100_000, 100_000, 100_000, 100_000, 100_000]
}

describe('stallFrames', () => {
  it('sums self time by frame inside the stall window, heaviest first', () => {
    expect(stallFrames(profile, 400)).toEqual([
      { frame: 'readFileSync node:fs:1', ms: 300 },
      { frame: 'load /app/store.js:42', ms: 100 }
    ])
  })

  it('ignores samples before the window', () => {
    expect(stallFrames(profile, 100)).toEqual([{ frame: 'load /app/store.js:42', ms: 100 }])
  })
})

describe('heaviestStack', () => {
  it('walks up from the node with the most samples in the window', () => {
    expect(heaviestStack(profile, 400)).toEqual([
      'readFileSync node:fs:1',
      'load /app/store.js:42',
      'open /app/shell.js:10'
    ])
  })
})

interface Clock {
  at: number
  ticks: (() => void)[]
  advance(ms: number): void
}

function clock(): Clock {
  const state: Clock = {
    at: 0,
    ticks: [],
    advance(ms) {
      state.at += ms
      for (const tick of state.ticks) tick()
    }
  }
  return state
}

function fakeProfiler(handed: CpuProfile | undefined): StallProfiler & { starts: number } {
  const profiler = {
    starts: 0,
    start() {
      profiler.starts += 1
    },
    async stop() {
      return handed
    },
    dispose() {}
  }
  return profiler
}

describe('startStallWatchdog', () => {
  it('says nothing while ticks arrive on time', () => {
    const log = createMemorySink()
    const time = clock()
    startStallWatchdog({
      log,
      now: () => time.at,
      setInterval: (fn) => time.ticks.push(fn),
      clearInterval: () => {}
    })
    for (let i = 0; i < 20; i++) time.advance(50)
    expect(log.lines).toEqual([])
  })

  it('logs a stall with the frames that held the loop, then profiles again', async () => {
    const log = createMemorySink()
    const time = clock()
    const profiler = fakeProfiler(profile)
    const written: string[] = []
    startStallWatchdog({
      log,
      profiler,
      profileDir: '/logs',
      writeProfile: (path) => {
        written.push(path)
      },
      now: () => time.at,
      setInterval: (fn) => time.ticks.push(fn),
      clearInterval: () => {}
    })
    expect(profiler.starts).toBe(1)
    time.advance(50)
    time.advance(450)
    await Promise.resolve()
    await Promise.resolve()

    expect(log.lines).toHaveLength(1)
    const record = JSON.parse(log.lines[0] ?? '{}') as Record<string, unknown>
    expect(record.event).toBe('main_stalled')
    expect(record.ms).toBe(400)
    expect(record.top).toEqual([
      { frame: 'readFileSync node:fs:1', ms: 300 },
      { frame: 'load /app/store.js:42', ms: 100 }
    ])
    expect(record.stack).toEqual([
      'readFileSync node:fs:1',
      'load /app/store.js:42',
      'open /app/shell.js:10'
    ])
    expect(record.profile).toMatch(/^\/logs\/stall-.*\.cpuprofile$/)
    expect(written).toHaveLength(1)
    expect(profiler.starts).toBe(2)
  })

  it('measures without attributing when there is no profiler', async () => {
    const log = createMemorySink()
    const time = clock()
    startStallWatchdog({
      log,
      now: () => time.at,
      setInterval: (fn) => time.ticks.push(fn),
      clearInterval: () => {}
    })
    time.advance(1000)
    await Promise.resolve()
    expect(log.lines).toHaveLength(1)
    expect(JSON.parse(log.lines[0] ?? '{}')).toMatchObject({ event: 'main_stalled', ms: 950 })
  })

  it('rotates the profile when nothing stalled for long enough', async () => {
    const log = createMemorySink()
    const time = clock()
    const profiler = fakeProfiler(profile)
    startStallWatchdog({
      log,
      profiler,
      rotateMs: 1000,
      now: () => time.at,
      setInterval: (fn) => time.ticks.push(fn),
      clearInterval: () => {}
    })
    for (let i = 0; i < 21; i++) time.advance(50)
    await Promise.resolve()
    await Promise.resolve()
    expect(profiler.starts).toBe(2)
    expect(log.lines).toEqual([])
  })

  it('stops ticking and profiling on dispose', () => {
    const cleared: unknown[] = []
    let disposed = false
    const watchdog = startStallWatchdog({
      log: createMemorySink(),
      profiler: { ...fakeProfiler(undefined), dispose: () => (disposed = true) },
      setInterval: () => 'handle',
      clearInterval: (handle) => cleared.push(handle)
    })
    watchdog.dispose()
    expect(cleared).toEqual(['handle'])
    expect(disposed).toBe(true)
  })
})
