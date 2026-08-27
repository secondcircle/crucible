// @vitest-environment node
//
// The complete_node parameter schema is where a node's verdict contract
// becomes enforceable: π validates tool arguments against it and hands the
// model a precise error naming the received arguments. Loose here meant a
// mangled call arrived as a plausible object with the verdict silently
// missing, failed one engine turn later with less to go on, and burned the
// node's retries (run 779a died exactly this way).
import { describe, expect, it } from 'vitest'
import { completeNodeParameters } from './sdk-node-session'

describe('completeNodeParameters', () => {
  it('leaves verdict optional and untyped when the node declares no schema', () => {
    expect(completeNodeParameters(undefined)).toEqual({
      type: 'object',
      required: ['summary'],
      properties: {
        summary: { type: 'string', description: 'One-paragraph summary of what was done.' },
        verdict: { description: 'Verdict matching the declared schema.' }
      }
    })
  })

  it('splices a declared schema in and marks verdict required', () => {
    const schema = {
      type: 'object',
      required: ['verdict', 'reason'],
      properties: {
        verdict: { enum: ['approved', 'changes-required'] },
        reason: { type: 'string' }
      }
    }
    expect(completeNodeParameters(schema)).toEqual({
      type: 'object',
      required: ['summary', 'verdict'],
      properties: {
        summary: { type: 'string', description: 'One-paragraph summary of what was done.' },
        verdict: { description: 'Verdict matching the declared schema.', ...schema }
      }
    })
  })

  it("lets the schema's own description win over the boilerplate one", () => {
    const schema = { type: 'string', description: 'yes or no' }
    const parameters = completeNodeParameters(schema) as {
      properties: { verdict: { description: string } }
    }
    expect(parameters.properties.verdict.description).toBe('yes or no')
  })
})
