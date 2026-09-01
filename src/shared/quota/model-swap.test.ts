// @vitest-environment node
//
// The rule that takes a node off a model whose own week is running ahead.
import { describe, expect, it } from 'vitest'
import { outrunsTheWeek, swapModel } from './model-swap'
import type { ProviderQuota, QuotaMeter, QuotaSnapshot } from './types'

const NOW = Date.UTC(2026, 7, 15, 12, 0, 0)
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const FABLE = 'anthropic/claude-fable-5-1'
const OPUS = 'anthropic/claude-opus-5'

function meters(week: number, fable: number): QuotaMeter[] {
  return [
    { kind: 'session', label: '5H', usedPercent: 19, resetsAt: NOW + HOUR },
    { kind: 'weekly', label: '7D', usedPercent: week, resetsAt: NOW + 3 * DAY },
    {
      kind: 'weekly_scoped',
      label: 'FABLE',
      scopeName: 'Fable',
      usedPercent: fable,
      resetsAt: NOW + 3 * DAY
    }
  ]
}

function snapshot(anthropic: Partial<ProviderQuota> & { meters: readonly QuotaMeter[] }): QuotaSnapshot {
  return {
    providers: {
      anthropic: { providerId: 'anthropic', fetchedAt: NOW, ...anthropic }
    },
    fetchedAt: NOW
  }
}

describe('swapping a model whose week is running ahead', () => {
  it('sends a fable node to opus once fable has outrun the account week', () => {
    expect(swapModel(FABLE, snapshot({ meters: meters(67, 92) }), NOW)).toBe(OPUS)
  })

  it('keeps the thinking level, which is the workflow s call and not the meters', () => {
    expect(swapModel(`${FABLE}:high`, snapshot({ meters: meters(67, 92) }), NOW)).toBe(
      `${OPUS}:high`
    )
  })

  it('leaves the node on fable while the account week is the heavier of the two', () => {
    expect(swapModel(FABLE, snapshot({ meters: meters(92, 67) }), NOW)).toBe(FABLE)
  })

  it('leaves the node on fable when the two meters are level, so equality never flips it', () => {
    expect(swapModel(FABLE, snapshot({ meters: meters(67, 67) }), NOW)).toBe(FABLE)
  })

  it('sends the previous fable to opus under the same pressure, both wear the meter\u2019s label', () => {
    expect(swapModel('anthropic/claude-fable-5', snapshot({ meters: meters(67, 92) }), NOW)).toBe(
      OPUS
    )
  })

  it('swaps nothing else, however far ahead fable runs', () => {
    const pressed = snapshot({ meters: meters(67, 92) })
    expect(swapModel(OPUS, pressed, NOW)).toBe(OPUS)
    expect(swapModel('anthropic/claude-haiku-4-5', pressed, NOW)).toBe('anthropic/claude-haiku-4-5')
  })

  it('stands on the declared model when the reading is stale, absent or failing', () => {
    const stale = snapshot({ meters: meters(67, 92), fetchedAt: NOW - 10 * 60 * 1000 })
    const failing = snapshot({ meters: meters(67, 92), error: 'unavailable' })
    const empty: QuotaSnapshot = { providers: {}, fetchedAt: NOW }

    expect(swapModel(FABLE, stale, NOW)).toBe(FABLE)
    expect(swapModel(FABLE, failing, NOW)).toBe(FABLE)
    expect(swapModel(FABLE, empty, NOW)).toBe(FABLE)
  })

  it('ignores a meter whose window has already turned over', () => {
    const expired = snapshot({
      meters: [
        { kind: 'weekly', label: '7D', usedPercent: 67, resetsAt: NOW + 3 * DAY },
        { kind: 'weekly_scoped', label: 'FABLE', usedPercent: 92, resetsAt: NOW - HOUR }
      ]
    })

    expect(outrunsTheWeek(FABLE, expired, NOW)).toBe(false)
  })

  it('says nothing about a provider that meters no scoped week at all', () => {
    const unscoped = snapshot({
      meters: [{ kind: 'weekly', label: '7D', usedPercent: 67, resetsAt: NOW + 3 * DAY }]
    })

    expect(outrunsTheWeek(FABLE, unscoped, NOW)).toBe(false)
  })
})
