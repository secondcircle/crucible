import { describe, expect, it } from 'vitest'
import {
  DEFAULT_COMPACTION_SETTINGS,
  MAX_THRESHOLD_K,
  MIN_THRESHOLD_K,
  readCompactionSettings,
  thresholdTokens
} from './settings'

describe('the compaction setting', () => {
  it('is on at 200k out of the box', () => {
    expect(DEFAULT_COMPACTION_SETTINGS).toEqual({ enabled: true, thresholdK: 200 })
    expect(thresholdTokens(DEFAULT_COMPACTION_SETTINGS)).toBe(200_000)
  })

  it('reads a stored record, and a file written before it existed as the default', () => {
    expect(readCompactionSettings({ enabled: false, thresholdK: 120 })).toEqual({
      enabled: false,
      thresholdK: 120
    })
    expect(readCompactionSettings(undefined)).toEqual(DEFAULT_COMPACTION_SETTINGS)
    expect(readCompactionSettings('nonsense')).toEqual(DEFAULT_COMPACTION_SETTINGS)
  })

  it('clamps a threshold no conversation could live with, however it arrived', () => {
    expect(readCompactionSettings({ thresholdK: 1 }).thresholdK).toBe(MIN_THRESHOLD_K)
    expect(readCompactionSettings({ thresholdK: 9e9 }).thresholdK).toBe(MAX_THRESHOLD_K)
    expect(readCompactionSettings({ thresholdK: 150.6 }).thresholdK).toBe(151)
    expect(readCompactionSettings({ thresholdK: Number.NaN }).thresholdK).toBe(200)
    expect(readCompactionSettings({ thresholdK: '300' }).thresholdK).toBe(200)
  })

  it('treats anything but a plain false as on, so a half-written record still compacts', () => {
    expect(readCompactionSettings({}).enabled).toBe(true)
    expect(readCompactionSettings({ enabled: false }).enabled).toBe(false)
  })
})
