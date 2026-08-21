import { describe, expect, it } from 'vitest'
import { boxHeight, CEILING_HEIGHT, RESTING_HEIGHT } from './composer-height'

describe('the composer box height', () => {
  it('rests at 46px for anything shorter than resting', () => {
    expect(boxHeight(0)).toBe(RESTING_HEIGHT)
    expect(boxHeight(21)).toBe(RESTING_HEIGHT)
    expect(boxHeight(RESTING_HEIGHT)).toBe(RESTING_HEIGHT)
  })

  it('tracks the content between resting and the ceiling', () => {
    expect(boxHeight(47)).toBe(47)
    expect(boxHeight(180)).toBe(180)
    expect(boxHeight(CEILING_HEIGHT)).toBe(CEILING_HEIGHT)
  })

  it('stops at 300px however long the draft gets', () => {
    expect(boxHeight(301)).toBe(CEILING_HEIGHT)
    expect(boxHeight(12_000)).toBe(CEILING_HEIGHT)
  })

  it('rounds a fractional line height up rather than clipping it', () => {
    expect(boxHeight(94.5)).toBe(95)
  })

  it('rests when there is no measurement to be had', () => {
    expect(boxHeight(Number.NaN)).toBe(RESTING_HEIGHT)
  })
})
