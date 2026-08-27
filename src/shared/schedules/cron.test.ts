// @vitest-environment node
//
// The dialect a schedule speaks. Every answer here is a function of the
// instants it is given, so "fires at 9am daily" is checkable without waiting
// until 9am.
import { describe, expect, it } from 'vitest'
import { cadenceText, cronDue, cronMatches, nextCronSlot, parseCron } from './cron'

/** A local instant, written the way a person reads a schedule. */
function at(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0
): Date {
  return new Date(year, month - 1, day, hour, minute)
}

describe('parsing', () => {
  it('takes the whole dialect: stars, lists, ranges, steps and plain numbers', () => {
    expect(parseCron('0 9 * * *')?.hours).toEqual([9])
    expect(parseCron('0,30 * * * *')?.minutes).toEqual([0, 30])
    expect(parseCron('0 9-11 * * *')?.hours).toEqual([9, 10, 11])
    expect(parseCron('*/15 * * * *')?.minutes).toEqual([0, 15, 30, 45])
    expect(parseCron('0 0-23/6 * * *')?.hours).toEqual([0, 6, 12, 18])
    expect(parseCron('0 9 1,15 * *')?.daysOfMonth).toEqual([1, 15])
  })

  it('reads both 0 and 7 as Sunday', () => {
    expect(parseCron('0 9 * * 0')?.daysOfWeek).toEqual([0])
    expect(parseCron('0 9 * * 7')?.daysOfWeek).toEqual([0])
    expect(parseCron('0 9 * * 0,7')?.daysOfWeek).toEqual([0])
  })

  it('refuses everything that is not five numeric fields', () => {
    expect(parseCron('0 9 * *')).toBeUndefined()
    expect(parseCron('0 9 * * * *')).toBeUndefined()
    expect(parseCron('')).toBeUndefined()
    expect(parseCron('every morning')).toBeUndefined()
    // No names for days or months: numeric values only.
    expect(parseCron('0 9 * * MON')).toBeUndefined()
    expect(parseCron('60 9 * * *')).toBeUndefined()
    expect(parseCron('0 24 * * *')).toBeUndefined()
    expect(parseCron('0 9 * * 8')).toBeUndefined()
    expect(parseCron('0 9 0 * *')).toBeUndefined()
    expect(parseCron('*/0 * * * *')).toBeUndefined()
    expect(parseCron('0 11-9 * * *')).toBeUndefined()
  })
})

describe('matching', () => {
  it('matches a daily slot on its minute and no other', () => {
    const daily = parseCron('0 9 * * *')
    expect(daily).toBeDefined()
    if (daily === undefined) return
    expect(cronMatches(daily, at(2026, 8, 24, 9, 0))).toBe(true)
    expect(cronMatches(daily, at(2026, 8, 24, 9, 1))).toBe(false)
    expect(cronMatches(daily, at(2026, 8, 24, 8, 0))).toBe(false)
  })

  // The rule every cron implementation shares, and the one most often got
  // wrong: with both day fields restricted, either matching is a match.
  it('takes day-of-month or day-of-week when both are restricted', () => {
    const both = parseCron('0 9 1 * 1')
    expect(both).toBeDefined()
    if (both === undefined) return
    // 1 September 2026 is a Tuesday: the day-of-month clause carries it.
    expect(cronMatches(both, at(2026, 9, 1, 9, 0))).toBe(true)
    // 7 September 2026 is a Monday: the day-of-week clause carries it.
    expect(cronMatches(both, at(2026, 9, 7, 9, 0))).toBe(true)
    expect(cronMatches(both, at(2026, 9, 8, 9, 0))).toBe(false)
  })
})

describe('the next slot', () => {
  it('is the next one strictly after the instant given', () => {
    expect(nextCronSlot('0 9 * * *', at(2026, 8, 24, 8, 59))).toEqual(at(2026, 8, 24, 9, 0))
    // Standing exactly on a slot: the next one is tomorrow's, never this one
    // again.
    expect(nextCronSlot('0 9 * * *', at(2026, 8, 24, 9, 0))).toEqual(at(2026, 8, 25, 9, 0))
    expect(nextCronSlot('*/5 * * * *', at(2026, 8, 24, 9, 1))).toEqual(at(2026, 8, 24, 9, 5))
  })

  it('crosses days, months and weeks to find one', () => {
    // Monday 07:00, asked on a Friday.
    expect(nextCronSlot('0 7 * * 1', at(2026, 8, 21, 12, 0))).toEqual(at(2026, 8, 24, 7, 0))
    expect(nextCronSlot('0 0 1 * *', at(2026, 8, 24, 12, 0))).toEqual(at(2026, 9, 1, 0, 0))
  })

  it('has none for an expression whose slot never comes, and none for a bad one', () => {
    expect(nextCronSlot('0 0 30 2 *', at(2026, 8, 24))).toBeUndefined()
    expect(nextCronSlot('nonsense', at(2026, 8, 24))).toBeUndefined()
  })
})

describe('dueness', () => {
  it('is one answer however many slots passed', () => {
    const last = at(2026, 8, 20, 9, 0).getTime()
    // Four days of missed 9am slots is still just "due".
    expect(cronDue('0 9 * * *', last, at(2026, 8, 24, 10, 0).getTime())).toBe(true)
    expect(cronDue('0 9 * * *', last, at(2026, 8, 20, 23, 0).getTime())).toBe(false)
  })

  it('is false for an expression nothing can fire', () => {
    expect(cronDue('every 5 minutes', 0, Date.now())).toBe(false)
  })
})

describe('the human reading', () => {
  it('recognizes every-N-minutes, daily and weekly, and nothing else', () => {
    expect(cadenceText('*/5 * * * *')).toBe('every 5 min')
    expect(cadenceText('* * * * *')).toBe('every minute')
    expect(cadenceText('0 9 * * *')).toBe('daily 09:00')
    expect(cadenceText('0 7 * * 1')).toBe('weekly Mon 07:00')
    expect(cadenceText('0 16 * * 5')).toBe('weekly Fri 16:00')
    expect(cadenceText('0 9 * * 7')).toBe('weekly Sun 09:00')
    // Recognized shapes only: everything else shows the raw cron alone.
    expect(cadenceText('0 9 1 * *')).toBeUndefined()
    expect(cadenceText('0 9,17 * * *')).toBeUndefined()
    expect(cadenceText('0 9 * * 1,3')).toBeUndefined()
    expect(cadenceText('nonsense')).toBeUndefined()
  })
})
