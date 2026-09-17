import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '../agent/port'
import { planCompaction, settleCompaction, type CompactionState } from './compaction'
import { SUMMARY_BUDGET_TOKENS } from './window'

const AGED: readonly TranscriptItem[] = [
  { kind: 'user', text: 'Rewrite the retry policy.' },
  { kind: 'thinking', text: 'private' },
  { kind: 'tool', name: 'read', summary: 'src/retry.ts', ok: true, output: 'z'.repeat(8_000) }
]

const CARRIED: CompactionState = {
  skeleton: [{ kind: 'user', text: 'An older ask, from before the last compaction.' }]
}

const reply = (trajectory: string, strike = ''): string =>
  `<trajectory>${trajectory}</trajectory><strike>${strike}</strike>`

describe('planning a compaction', () => {
  it('asks about the newly aged span and carries the earlier skeleton whole', () => {
    const plan = planCompaction(CARRIED, AGED)
    expect(plan.lines).toHaveLength(3)
    expect(plan.lines[0]).toEqual(CARRIED.skeleton[0])
    // Numbered where the window left off, so one strike list covers both.
    expect(plan.instruction).toContain('2. [user] Rewrite the retry policy.')
    expect(plan.instruction).not.toContain('An older ask')
  })
})

describe('settling one', () => {
  it('composes the window from the account and what survived pruning', () => {
    const plan = planCompaction(CARRIED, AGED)
    const settled = settleCompaction(plan, reply('Where the work stands.', '1'))
    if (settled === undefined) throw new Error('the compaction should have settled')

    expect(settled.text).toContain('## Where we are')
    expect(settled.text).toContain('Where the work stands.')
    expect(settled.text).toContain('## What happened before this point')
    // Struck by the model, so it is not in the window and not carried on.
    expect(settled.text).not.toContain('An older ask')
    expect(settled.state.skeleton).toHaveLength(2)
    expect(settled.text).toContain('[read] src/retry.ts → ok · 2,000 tok dropped')
  })

  // A window of handles with no account is an agent that knows what it touched
  // and not what it was doing, which is the one outcome worth refusing.
  it('refuses a reply that wrote no account', () => {
    expect(settleCompaction(planCompaction(undefined, AGED), 'no tags here')).toBeUndefined()
  })

  it('holds the skeleton under its budget however much aged out', () => {
    const many: readonly TranscriptItem[] = Array.from({ length: 4_000 }, (_unused, at) => ({
      kind: 'tool' as const,
      name: 'read',
      summary: `src/deep/nested/path/to/file-${at}.ts`,
      ok: true,
      output: 'x'.repeat(2_000)
    }))
    const settled = settleCompaction(planCompaction(undefined, many), reply('Standing here.'))
    if (settled === undefined) throw new Error('the compaction should have settled')
    expect(settled.state.skeleton.length).toBeLessThan(many.length)
  })

  it('clips an account that ignored the word count rather than refusing it', () => {
    const settled = settleCompaction(
      planCompaction(undefined, AGED),
      reply('word '.repeat(40_000))
    )
    if (settled === undefined) throw new Error('the compaction should have settled')
    expect(settled.text.length).toBeLessThan(SUMMARY_BUDGET_TOKENS * 4 + 4_000)
  })

  it('leaves out the skeleton heading when the model struck everything', () => {
    const plan = planCompaction(undefined, [{ kind: 'user', text: 'one thing' }])
    const settled = settleCompaction(plan, reply('Standing here.', '1'))
    expect(settled?.text).not.toContain('## What happened before this point')
  })
})
