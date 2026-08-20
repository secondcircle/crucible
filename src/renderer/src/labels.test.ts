import { describe, expect, it } from 'vitest'
import { elapsedTime } from './labels'

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
