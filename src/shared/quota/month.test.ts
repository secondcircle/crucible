// @vitest-environment node
//
// The one place the calendar month is computed, so this is the one place the
// month arithmetic is checked: no payload, no clock, no document.
import { describe, expect, it } from 'vitest'
import { monthlyResetAfter, monthWindowStart } from './month'

const iso = (ms: number): string => new Date(ms).toISOString()

describe('the monthly reset', () => {
  it('is midnight UTC on the first of the next month', () => {
    expect(iso(monthlyResetAfter(Date.UTC(2026, 7, 15, 12, 0, 0)))).toBe('2026-09-01T00:00:00.000Z')
    expect(iso(monthlyResetAfter(Date.UTC(2026, 1, 1, 0, 0, 0)))).toBe('2026-03-01T00:00:00.000Z')
    // A day short of the reset, and a millisecond short of it.
    expect(iso(monthlyResetAfter(Date.UTC(2026, 8, 30, 23, 59, 59)))).toBe(
      '2026-10-01T00:00:00.000Z'
    )
    expect(iso(monthlyResetAfter(Date.UTC(2026, 9, 1) - 1))).toBe('2026-10-01T00:00:00.000Z')
  })

  it('rolls into the new year without arithmetic of its own', () => {
    expect(iso(monthlyResetAfter(Date.UTC(2026, 11, 20, 8, 0, 0)))).toBe('2027-01-01T00:00:00.000Z')
  })

  it('is always ahead of the instant it was computed at', () => {
    for (let month = 0; month < 12; month += 1) {
      const now = Date.UTC(2027, month, 17, 4, 30, 0)
      expect(monthlyResetAfter(now)).toBeGreaterThan(now)
    }
  })
})

describe('the window that reset closes', () => {
  it('starts one calendar month earlier, however long that month is', () => {
    const days = (resetsAt: number): number =>
      (resetsAt - monthWindowStart(resetsAt)) / (24 * 60 * 60 * 1000)

    expect(days(Date.UTC(2026, 8, 1))).toBe(31) // August
    expect(days(Date.UTC(2026, 6, 1))).toBe(30) // June
    expect(days(Date.UTC(2026, 2, 1))).toBe(28) // February 2026
    expect(days(Date.UTC(2028, 2, 1))).toBe(29) // February 2028, a leap year
  })

  it('rolls back over the new year', () => {
    expect(iso(monthWindowStart(Date.UTC(2027, 0, 1)))).toBe('2026-12-01T00:00:00.000Z')
  })
})
