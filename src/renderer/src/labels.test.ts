import { describe, expect, it } from 'vitest'
import { agoLabel, elapsedTime, issueAge } from './labels'

// The version strip's second line: when the registry was last asked.
describe('agoLabel', () => {
  const now = Date.parse('2026-08-20T10:00:00.000Z')
  const ago = (ms: number): number => now - ms

  it('says just now for the first minute, then counts', () => {
    expect(agoLabel(ago(0), now)).toBe('just now')
    expect(agoLabel(ago(59_000), now)).toBe('just now')
    expect(agoLabel(ago(4 * 60_000), now)).toBe('4 min ago')
    expect(agoLabel(ago(90 * 60_000), now)).toBe('1 hr ago')
    expect(agoLabel(ago(50 * 60 * 60_000), now)).toBe('2 d ago')
  })

  it('floors at zero, because a clock behind the stamp is a rounding artifact', () => {
    expect(agoLabel(now + 5000, now)).toBe('just now')
  })
})

// The sidebar's running counter. Seconds while a turn is short, m:ss for as
// long as anyone watches the seconds, hours and minutes after that.
describe('elapsedTime', () => {
  const now = Date.parse('2026-08-20T10:00:00.000Z')
  const ago = (seconds: number): string => new Date(now - seconds * 1000).toISOString()

  it('counts seconds for the first minute', () => {
    expect(elapsedTime(ago(0), now)).toBe('0s')
    expect(elapsedTime(ago(8), now)).toBe('8s')
    expect(elapsedTime(ago(59), now)).toBe('59s')
  })

  it('counts m:ss up to the hour, zero-padded so it never shifts width', () => {
    expect(elapsedTime(ago(60), now)).toBe('1:00')
    expect(elapsedTime(ago(134), now)).toBe('2:14')
    expect(elapsedTime(ago(2840), now)).toBe('47:20')
    expect(elapsedTime(ago(3599), now)).toBe('59:59')
  })

  it('drops the seconds past an hour, because nobody is watching them', () => {
    expect(elapsedTime(ago(3600), now)).toBe('1h 0m')
    expect(elapsedTime(ago(4327), now)).toBe('1h 12m')
    expect(elapsedTime(ago(86_400), now)).toBe('24h 0m')
  })

  // A clock behind the stamp is a rounding artifact, not a negative turn.
  it('floors at zero and says nothing about a time it cannot read', () => {
    expect(elapsedTime(new Date(now + 5000).toISOString(), now)).toBe('0s')
    expect(elapsedTime('not a time', now)).toBe('')
  })
})

// The issue board's age column, three characters wide at most.
describe('issueAge', () => {
  const now = Date.parse('2026-08-20T10:00:00.000Z')
  const HOUR = 60 * 60 * 1000
  const DAY = 24 * HOUR
  const ago = (ms: number): string => new Date(now - ms).toISOString()

  it('counts minutes, then hours, on the day the issue moved', () => {
    expect(issueAge(ago(0), now)).toBe('0m')
    expect(issueAge(ago(40 * 60 * 1000), now)).toBe('40m')
    expect(issueAge(ago(6 * HOUR), now)).toBe('6h')
    expect(issueAge(ago(23 * HOUR), now)).toBe('23h')
  })

  it('counts days for a fortnight, which is as long as a day still means one', () => {
    expect(issueAge(ago(DAY), now)).toBe('1d')
    expect(issueAge(ago(13 * DAY), now)).toBe('13d')
  })

  it('counts weeks, then years, past that', () => {
    expect(issueAge(ago(14 * DAY), now)).toBe('2w')
    expect(issueAge(ago(90 * DAY), now)).toBe('12w')
    expect(issueAge(ago(400 * DAY), now)).toBe('1y')
  })

  it('floors at zero and says nothing about a time it cannot read', () => {
    expect(issueAge(new Date(now + 5000).toISOString(), now)).toBe('0m')
    expect(issueAge('not a time', now)).toBe('')
  })
})
