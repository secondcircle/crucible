import { describe, expect, it } from 'vitest'
import { compactionInstruction, readCompactionReply } from './prompt'
import type { SkeletonLine } from './skeleton'

const AGED: readonly SkeletonLine[] = [
  { kind: 'user', text: 'Make the two clients agree.' },
  { kind: 'call', name: 'read', handle: 'src/a.ts', ok: true, tokens: 900 }
]

describe('what the model is asked at a compaction', () => {
  it('offers the newly aged lines, numbered from one on a first compaction', () => {
    const asked = compactionInstruction({ aged: AGED, carried: 0 })
    expect(asked).toContain('1. [user] Make the two clients agree.')
    expect(asked).toContain('2. [read] src/a.ts → ok · 900 tok dropped')
    expect(asked).toContain('Here is that skeleton')
  })

  // The earlier skeleton is already in the window, numbered; only what is new
  // is re-sent, and it continues that numbering so one strike list covers both.
  it('continues an earlier skeleton’s numbering rather than re-sending it', () => {
    const asked = compactionInstruction({ aged: AGED, carried: 40 })
    expect(asked).toContain('41. [user] Make the two clients agree.')
    expect(asked).toContain('The skeleton opens this conversation')
  })

  // Left unsaid, the model reads the carried block as settled and strikes
  // only among the new lines.
  it('says the carried lines may be struck too, and only when there are any', () => {
    expect(compactionInstruction({ aged: AGED, carried: 40 })).toContain(
      'The lines of the opening skeleton count too'
    )
    expect(compactionInstruction({ aged: AGED, carried: 0 })).not.toContain('opening skeleton')
  })

  it('names the two things it wants and the exact shape of the answer', () => {
    const asked = compactionInstruction({ aged: AGED, carried: 0 })
    expect(asked).toContain('WHERE WE ARE')
    expect(asked).toContain('DEAD LINES')
    expect(asked).toContain('<trajectory>')
    expect(asked).toContain('<strike>')
  })
})

describe('reading the model’s answer', () => {
  it('takes the account and the struck numbers', () => {
    expect(
      readCompactionReply('<trajectory>\nWhere we are.\n</trajectory>\n<strike>3, 7</strike>')
    ).toEqual({ trajectory: 'Where we are.', strike: [3, 7] })
  })

  it('expands ranges, however they were written', () => {
    expect(readCompactionReply('<trajectory>x</trajectory><strike>2-4, 9 to 10</strike>').strike).toEqual(
      [2, 3, 4, 9, 10]
    )
  })

  it('ignores a range wide enough to have been a typo', () => {
    expect(readCompactionReply('<trajectory>x</trajectory><strike>1-99999</strike>').strike).toEqual([])
  })

  it('reads an unclosed account when the strike list follows it', () => {
    expect(readCompactionReply('<trajectory>Where we are.\n<strike>2</strike>')).toEqual({
      trajectory: 'Where we are.',
      strike: [2]
    })
  })

  // Seen on a real session: the provider stopped a third of the way into
  // the account, and the conversation landed on it.
  it('treats an account with neither its close nor a strike list as cut off', () => {
    expect(readCompactionReply('<trajectory>Where we are, cut mid-sent')).toEqual({
      trajectory: '',
      strike: []
    })
  })

  it('answers with nothing where the model wrote no account at all', () => {
    expect(readCompactionReply('I could not do that.')).toEqual({ trajectory: '', strike: [] })
  })

  it('strikes nothing where the model struck nothing', () => {
    expect(readCompactionReply('<trajectory>x</trajectory><strike></strike>').strike).toEqual([])
  })
})
