// @vitest-environment node
//
// π reports usage per message and keeps no ledger; this is Crucible's
// arithmetic, proven without constructing an SDK adapter.
import { describe, expect, it } from 'vitest'
import { createUsageCache, sumUsage, type StoredUsage } from './usage'

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

// The Usage pane re-asks for every session in the workspace after every turn,
// and an unbound session costs a whole file parse to answer. The sum is a
// pure function of the file, so it is kept against the file's revision.
describe('the usage cache', () => {
  it('parses a conversation once while its file stands still', () => {
    const revisions = new Map([['/s/one.jsonl', 'dev:1:400:100']])
    const cache = createUsageCache((path) => revisions.get(path))
    let parses = 0
    const compute = (): ReturnType<typeof sumUsage> => {
      parses += 1
      return sumUsage([turn(1)])
    }

    const first = cache.of('/s/one.jsonl', compute)
    const second = cache.of('/s/one.jsonl', compute)

    expect(parses).toBe(1)
    expect(second).toEqual(first)
  })

  it('parses it again the moment the file grows', () => {
    const revisions = new Map([['/s/one.jsonl', 'dev:1:400:100']])
    const cache = createUsageCache((path) => revisions.get(path))
    let parses = 0
    const compute = (): ReturnType<typeof sumUsage> => {
      parses += 1
      return sumUsage(Array.from({ length: parses }, () => turn(1)))
    }

    expect(cache.of('/s/one.jsonl', compute)?.messages).toBe(1)
    revisions.set('/s/one.jsonl', 'dev:1:800:200')

    expect(cache.of('/s/one.jsonl', compute)?.messages).toBe(2)
    expect(parses).toBe(2)
  })

  it('keeps one answer per conversation', () => {
    const cache = createUsageCache((path) => `rev-of-${path}`)
    let parses = 0
    const compute = (): ReturnType<typeof sumUsage> => {
      parses += 1
      return sumUsage([turn(parses)])
    }

    const one = cache.of('/s/one.jsonl', compute)
    const two = cache.of('/s/two.jsonl', compute)

    expect(parses).toBe(2)
    expect(cache.of('/s/one.jsonl', compute)).toEqual(one)
    expect(cache.of('/s/two.jsonl', compute)).toEqual(two)
    expect(parses).toBe(2)
  })

  // A file nothing can stat is a file with no revision to key on: answering
  // from memory there would mean answering for a conversation that may have
  // been replaced.
  it('remembers nothing about a file it cannot stat', () => {
    const cache = createUsageCache(() => undefined)
    let parses = 0
    const compute = (): ReturnType<typeof sumUsage> => {
      parses += 1
      return sumUsage([turn(1)])
    }

    cache.of('/s/gone.jsonl', compute)
    cache.of('/s/gone.jsonl', compute)

    expect(parses).toBe(2)
  })
})
