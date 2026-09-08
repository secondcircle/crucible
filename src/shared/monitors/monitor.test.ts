import { describe, expect, it } from 'vitest'
import {
  boundOutput,
  RETAINED_OUTPUT_CHARS,
  WAKE_OUTPUT_CHARS,
  INTERVAL_DEFAULT_MS,
  INTERVAL_FLOOR_MS,
  TIMEOUT_CEILING_MS,
  TIMEOUT_DEFAULT_MS,
  TIMEOUT_FLOOR_MS,
  timingInForce
} from './monitor'

// The bounds and the truncation, tested where they are decided: one function
// constructs a timing, so nothing downstream can hold an out-of-range one.

describe('the timing in force', () => {
  it('defaults to 30 seconds and 30 minutes when nothing was asked for', () => {
    expect(timingInForce({})).toEqual({
      intervalMs: INTERVAL_DEFAULT_MS,
      timeoutMs: TIMEOUT_DEFAULT_MS
    })
    expect(INTERVAL_DEFAULT_MS).toBe(30_000)
    expect(TIMEOUT_DEFAULT_MS).toBe(30 * 60_000)
  })

  it('takes what was asked for when it is inside the bounds', () => {
    expect(timingInForce({ intervalSeconds: 45, timeoutSeconds: 600 })).toEqual({
      intervalMs: 45_000,
      timeoutMs: 600_000
    })
  })

  it('clamps rather than refuses, so a hurried agent is never left with no monitor', () => {
    expect(timingInForce({ intervalSeconds: 1 }).intervalMs).toBe(INTERVAL_FLOOR_MS)
    expect(INTERVAL_FLOOR_MS).toBe(5_000)
    expect(timingInForce({ timeoutSeconds: 60 * 60 * 48 }).timeoutMs).toBe(TIMEOUT_CEILING_MS)
    expect(TIMEOUT_CEILING_MS).toBe(24 * 60 * 60_000)
  })

  it('refuses to make a timeout of nothing', () => {
    expect(timingInForce({ timeoutSeconds: 0 }).timeoutMs).toBe(TIMEOUT_FLOOR_MS)
    expect(timingInForce({ timeoutSeconds: -5 }).timeoutMs).toBe(TIMEOUT_FLOOR_MS)
  })

  it('reads a nonsense number as no answer at all', () => {
    expect(timingInForce({ intervalSeconds: Number.NaN }).intervalMs).toBe(INTERVAL_DEFAULT_MS)
    expect(timingInForce({ timeoutSeconds: Number.POSITIVE_INFINITY }).timeoutMs).toBe(
      TIMEOUT_DEFAULT_MS
    )
  })
})

describe('what a check\u2019s output is kept as', () => {
  it('keeps a short output whole and says it was not cut', () => {
    expect(boundOutput('in_progress\n', 100)).toEqual({ text: 'in_progress', truncated: false })
  })

  it('keeps at least as much as a wake carries, so the detail is never the poorer', () => {
    expect(RETAINED_OUTPUT_CHARS).toBeGreaterThanOrEqual(WAKE_OUTPUT_CHARS)
  })

  it('keeps the head of a long one and says so, because errors come first', () => {
    const cut = boundOutput(`${'a'.repeat(50)}${'b'.repeat(50)}`, 50)
    expect(cut.text).toBe('a'.repeat(50))
    expect(cut.truncated).toBe(true)
  })
})
