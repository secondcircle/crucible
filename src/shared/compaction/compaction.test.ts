import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '../agent/port'
import { planCompaction, settleCompaction } from './compaction'

const AGED: readonly TranscriptItem[] = [
  { kind: 'user', text: 'Rewrite the retry policy.' },
  { kind: 'thinking', text: 'private' },
  {
    kind: 'tool',
    name: 'read',
    summary: 'src/retry.ts',
    ok: true,
    output: 'z'.repeat(8_000)
  }
]

describe('planning a compaction', () => {
  it('asks about the aged span, with the previous summary ahead of it', () => {
    const plan = planCompaction('An older summary.', AGED)
    expect(plan.instruction).toContain('An older summary.')
    expect(plan.instruction).toContain('Rewrite the retry policy.')
    expect(plan.instruction).not.toContain('private')
  })

  it('has no previous summary to offer on a first compaction', () => {
    expect(planCompaction(undefined, AGED).instruction).not.toContain(
      '## Summary of the conversation before this point'
    )
  })
})

describe('settling one', () => {
  it('is the model’s summary, whole', () => {
    const settled = settleCompaction(planCompaction(undefined, AGED), '\nWhere the work stands.\n')
    expect(settled).toEqual({ text: 'Where the work stands.' })
  })

  // Refused rather than settled, so the compaction cancels and whatever the
  // model reads now stands.
  it('refuses a reply that wrote nothing', () => {
    expect(settleCompaction(planCompaction(undefined, AGED), '  \n')).toBeUndefined()
  })

  // The end of a summary is where what comes next lives. A model that wrote a
  // long summary wrote a long one, not a bad one, and nothing it wrote is cut.
  it('keeps a summary whole however long it ran', () => {
    const account = `${'word '.repeat(40_000)}THE LAST THING IT SAID`
    const settled = settleCompaction(planCompaction(undefined, AGED), account)
    expect(settled?.text.endsWith('THE LAST THING IT SAID')).toBe(true)
  })
})
