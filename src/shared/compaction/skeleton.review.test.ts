// Review 2, finding 1. Delete this file with the fix.
//
// The ruling: the skeleton holds "the user's and the agent's words verbatim",
// and "user messages are never dropped from the skeleton without high
// confidence that they are dead". `LINE_LIMIT` clips both at 600 characters
// before the model ever sees them, so a pasted spec or a long instruction
// leaves the window with no model judgment involved and no way back.
import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '../agent/port'
import { skeletonOf } from './skeleton'

const SPEC = `Rewrite the importer so it reads the ledger in one pass. ${'The ledger rows carry a provider, a model and a cost. '.repeat(40)}Stop once the tests pass.`

describe('what the skeleton keeps of what was said', () => {
  it('keeps a long user message verbatim', () => {
    const span: readonly TranscriptItem[] = [{ kind: 'user', text: SPEC }]

    const [line] = skeletonOf(span)

    expect(line).toEqual({ kind: 'user', text: SPEC })
  })

  it('keeps a long assistant message verbatim', () => {
    const span: readonly TranscriptItem[] = [{ kind: 'assistant', markdown: SPEC }]

    const [line] = skeletonOf(span)

    expect(line).toEqual({ kind: 'assistant', text: SPEC })
  })
})
