// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { checkVerdict } from './verdict'

// The subset the shipped workflows actually declare: an object of required
// properties, an enum verdict, a string reason.
const BUILD_VERDICT = {
  type: 'object',
  required: ['verdict', 'reason'],
  properties: {
    verdict: { enum: ['approved', 'changes-required'] },
    reason: { type: 'string' }
  }
}

describe('checkVerdict', () => {
  it('accepts a matching verdict', () => {
    expect(
      checkVerdict(BUILD_VERDICT, { verdict: 'approved', reason: 'holds up' })
    ).toEqual([])
  })

  it('names a missing required property', () => {
    const problems = checkVerdict(BUILD_VERDICT, { verdict: 'approved' })
    expect(problems.join(' ')).toContain('reason')
  })

  it('refuses a value outside the enum', () => {
    const problems = checkVerdict(BUILD_VERDICT, { verdict: 'maybe', reason: 'hmm' })
    expect(problems.join(' ')).toContain('must be one of')
  })

  it('refuses the wrong type and says what it got', () => {
    const problems = checkVerdict({ type: 'object' }, 'a string')
    expect(problems.join(' ')).toContain('must be an object')
  })

  it('checks nested properties and array items', () => {
    const schema = {
      type: 'object',
      properties: {
        findings: { type: 'array', items: { type: 'string' } }
      }
    }
    expect(checkVerdict(schema, { findings: ['one', 'two'] })).toEqual([])
    expect(checkVerdict(schema, { findings: ['one', 2] }).join(' ')).toContain('findings[1]')
  })

  it('ignores keywords it does not know rather than refusing them', () => {
    expect(checkVerdict({ type: 'string', format: 'email' }, 'not-an-email')).toEqual([])
  })
})
