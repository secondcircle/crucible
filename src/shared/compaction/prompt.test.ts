import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '../agent/port'
import { compactionInstruction, readCompactionReply } from './prompt'

const ITEMS: readonly TranscriptItem[] = [
  { kind: 'user', text: 'Make the two clients agree.' },
  { kind: 'assistant', markdown: 'Reading both first.' },
  { kind: 'tool', name: 'Read', summary: 'src/a.ts', ok: true, output: 'export const a = 1' }
]

describe('what the model is asked at a compaction', () => {
  it('is the conversation as a document, then one plain instruction', () => {
    const asked = compactionInstruction({ items: ITEMS })
    expect(asked).toContain('### User\n\nMake the two clients agree.')
    expect(asked).toContain('### Assistant\n\nReading both first.')
    expect(asked).toContain('#### Tool call: Read\n\nsrc/a.ts')
    expect(asked).toContain('continue the conversation as if no compaction had happened')
    expect(asked).toContain('Leave out information that no longer bears on the conversation')
  })

  // The previous summary is part of what is summarized, so the next one is
  // written over both and summaries never stack.
  it('puts the previous summary ahead of the messages that followed it', () => {
    const asked = compactionInstruction({ previousSummary: 'Standing here.', items: ITEMS })
    expect(asked.indexOf('Standing here.')).toBeLessThan(asked.indexOf('### User'))
    expect(asked).toContain('## Summary of the conversation before this point')
  })

  // The strike list, the numbered skeleton and the answer tags of the build
  // before this one are gone: the reply is the summary and nothing is
  // dictated about its shape.
  it('dictates nothing about the shape of the answer', () => {
    const asked = compactionInstruction({ items: ITEMS })
    expect(asked).not.toContain('<trajectory>')
    expect(asked).not.toContain('<strike>')
    expect(asked).not.toContain('DEAD LINES')
  })
})

describe('reading the model’s answer', () => {
  it('is the whole reply, trimmed', () => {
    expect(readCompactionReply('\n\nWhere we are.\n')).toBe('Where we are.')
  })

  it('is nothing where the model wrote nothing', () => {
    expect(readCompactionReply('   \n')).toBeUndefined()
  })
})
