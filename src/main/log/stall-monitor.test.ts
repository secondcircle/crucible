// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createMemorySink } from './sink'
import { startStallMonitor } from './stall-monitor'

// A hand-driven clock and timer: the test decides how late each wake-up is,
// which is the whole of what the monitor measures.
function clockwork() {
  let time = 0
  const due: { at: number; fire: () => void }[] = []
  return {
    now: () => time,
    schedule(callback: () => void, ms: number) {
      const entry = { at: time + ms, fire: callback }
      due.push(entry)
      return () => {
        const at = due.indexOf(entry)
        if (at >= 0) due.splice(at, 1)
      }
    },
    /** The loop runs on time: the next timer fires exactly when it asked to. */
    tickOnTime() {
      const next = due.shift()
      if (next === undefined) throw new Error('nothing scheduled')
      time = next.at
      next.fire()
    },
    /** The loop was held: the next timer fires `heldMs` after it asked to. */
    tickHeld(heldMs: number) {
      const next = due.shift()
      if (next === undefined) throw new Error('nothing scheduled')
      time = next.at + heldMs
      next.fire()
    },
    pending: () => due.length
  }
}

function stalls(lines: readonly string[]): number[] {
  return lines
    .map((line) => JSON.parse(line) as { event: string; stalledMs?: number })
    .filter((record) => record.event === 'main_stalled')
    .map((record) => record.stalledMs ?? -1)
}

describe('stall monitor', () => {
  it('says nothing while the loop wakes on time or a little late', () => {
    const sink = createMemorySink()
    const clock = clockwork()
    startStallMonitor({ log: sink, now: clock.now, schedule: clock.schedule, thresholdMs: 1000 })

    clock.tickOnTime()
    clock.tickHeld(200)
    clock.tickHeld(999)

    expect(stalls(sink.lines)).toEqual([])
  })

  it('writes main_stalled with how long the loop was held', () => {
    const sink = createMemorySink()
    const clock = clockwork()
    startStallMonitor({ log: sink, now: clock.now, schedule: clock.schedule, thresholdMs: 1000 })

    clock.tickHeld(5140)
    clock.tickOnTime()
    clock.tickHeld(1000)

    expect(stalls(sink.lines)).toEqual([5140, 1000])
  })

  it('keeps sampling after a stall, and stops when told', () => {
    const sink = createMemorySink()
    const clock = clockwork()
    const monitor = startStallMonitor({ log: sink, now: clock.now, schedule: clock.schedule })

    clock.tickHeld(3000)
    expect(clock.pending()).toBe(1)

    monitor.stop()
    expect(clock.pending()).toBe(0)
  })
})
