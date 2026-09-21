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

  // An account whose closing tag never came is a reply the provider cut, and
  // what is missing is its end: what comes next and the files that matter.
  // Accepting one replaced a 1,000-word account with its first 89 words in a
  // real session, and the compaction after that rewrote from the fragment.
  it('refuses an account that was cut before its closing tag', () => {
    expect(
      readCompactionReply(
        '<trajectory>\nWHERE WE ARE\n\nRepo `x`, main pushed. Standing rules from the cost (~$2,080; rec'
      ).trajectory
    ).toBe('')
  })

  it('refuses an account cut inside the strike list as well', () => {
    const reply = readCompactionReply('<trajectory>whole account</trajectory>\n<strike>3, 7-')
    expect(reply.trajectory).toBe('whole account')
    // A cut strike list strikes nothing: unsure lines stay.
    expect(reply.strike).toEqual([])
  })

  it('answers with nothing where the model wrote no account at all', () => {
    expect(readCompactionReply('I could not do that.')).toEqual({ trajectory: '', strike: [] })
  })

  it('strikes nothing where the model struck nothing', () => {
    expect(readCompactionReply('<trajectory>x</trajectory><strike></strike>').strike).toEqual([])
  })
})
