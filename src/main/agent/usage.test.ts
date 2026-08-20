// @vitest-environment node
//
// π reports usage per message and keeps no ledger; this is Crucible's
// arithmetic, proven without constructing an SDK adapter.
import { describe, expect, it } from 'vitest'
import { sumUsage, type StoredUsage } from './usage'

function turn(scale: number): StoredUsage {
  return {
    input: 100 * scale,
    output: 20 * scale,
    cacheRead: 300 * scale,
    cacheWrite: 10 * scale,
    totalTokens: 430 * scale,
    cost: {
      input: 0.01 * scale,
      output: 0.02 * scale,
      cacheRead: 0.003 * scale,
      cacheWrite: 0.007 * scale,
      total: 0.04 * scale
    }
  }
}

describe('summing what π reported', () => {
  it('is nothing at all when no message has reported usage', () => {
    expect(sumUsage([])).toBeUndefined()
    expect(sumUsage([undefined, undefined])).toBeUndefined()
  })

  it('adds every usage-bearing message, line by line', () => {
    const summed = sumUsage([turn(1), undefined, turn(2)])

    expect(summed?.messages).toBe(2)
    expect(summed?.totalTokens).toBe(1290)
    expect(summed?.input.tokens).toBe(300)
    expect(summed?.output.tokens).toBe(60)
    expect(summed?.cacheRead.tokens).toBe(900)
    expect(summed?.cacheWrite.tokens).toBe(30)
    // Dollars are added exactly as π reported them, tails and all: the two
    // decimals a person sees are the display's rounding, never the sum's.
    expect(summed?.input.cost).toBeCloseTo(0.03, 10)
    expect(summed?.output.cost).toBeCloseTo(0.06, 10)
    expect(summed?.cacheRead.cost).toBeCloseTo(0.009, 10)
    expect(summed?.cacheWrite.cost).toBeCloseTo(0.021, 10)
    expect(summed?.totalCost).toBeCloseTo(0.12, 10)
  })

  it('adds the parts up itself where π gave no totals, and invents nothing', () => {
    const summed = sumUsage([
      { input: 10, output: 5, cost: { input: 0.5, output: 0.25 } },
      { output: 1 }
    ])

    expect(summed).toEqual({
      messages: 2,
      input: { tokens: 10, cost: 0.5 },
      output: { tokens: 6, cost: 0.25 },
      cacheRead: { tokens: 0, cost: 0 },
      cacheWrite: { tokens: 0, cost: 0 },
      totalTokens: 16,
      totalCost: 0.75
    })
  })

  it('counts a message that reported zeros, because it did report', () => {
    expect(sumUsage([{ totalTokens: 0, cost: { total: 0 } }])).toMatchObject({
      messages: 1,
      totalTokens: 0,
      totalCost: 0
    })
  })
})
