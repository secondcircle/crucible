import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '../agent/port'
import { RUN_MESSAGE_PREFIX } from '../workflows/run'
import { renderConversation, RESULT_LINES_KEPT } from './transcript'

const lines = (count: number): string =>
  Array.from({ length: count }, (_unused, at) => `line ${at + 1}`).join('\n')

describe('the conversation as a document', () => {
  it('names who spoke and nests tool calls under the reply that made them', () => {
    const doc = renderConversation({
      items: [
        { kind: 'user', text: 'Fix the flaky test.' },
        { kind: 'assistant', markdown: 'Looking at it.' },
        { kind: 'tool', name: 'Read', summary: 'src/x.test.ts', ok: true, output: 'it(...)' },
        { kind: 'assistant', markdown: 'Fixed.' }
      ]
    })
    expect(doc).toBe(
      [
        '# Conversation',
        '## Messages',
        '### User\n\nFix the flaky test.',
        '### Assistant\n\nLooking at it.',
        '#### Tool call: Read\n\nsrc/x.test.ts\n\nResult (ok):\n\n```\nit(...)\n```',
        '### Assistant\n\nFixed.'
      ].join('\n\n')
    )
  })

  it('leaves thinking, earlier summaries and transcript furniture out', () => {
    const doc = renderConversation({
      items: [
        { kind: 'thinking', text: 'private' },
        { kind: 'summary', text: 'an old summary' },
        { kind: 'cacheMiss', miss: {} as never },
        { kind: 'stopped' },
        { kind: 'user', text: 'hello' }
      ]
    })
    expect(doc).not.toContain('private')
    expect(doc).not.toContain('an old summary')
    expect(doc).toContain('### User\n\nhello')
  })

  // Results are most of a conversation's tokens; the opening lines say what
  // the file held, and the count says how much there was.
  it('keeps the opening lines of a result and counts the rest', () => {
    const doc = renderConversation({
      items: [
        { kind: 'tool', name: 'Bash', summary: 'ls -R', ok: false, output: lines(100) }
      ]
    })
    expect(doc).toContain(`line ${RESULT_LINES_KEPT}\n(60 more lines)`)
    expect(doc).not.toContain(`line ${RESULT_LINES_KEPT + 1}\n`)
    expect(doc).toContain('Result (failed)')
  })

  it('keeps a person’s message whole, however long', () => {
    const doc = renderConversation({ items: [{ kind: 'user', text: lines(300) }] })
    expect(doc).toContain('line 300')
    expect(doc).not.toContain('more lines')
  })

  // A run's report arrives in the user's role, but nobody typed it and every
  // fact in it is on the run's record.
  it('names Crucible’s own messages as Crucible’s, cut like a result', () => {
    const doc = renderConversation({
      items: [{ kind: 'user', text: `${RUN_MESSAGE_PREFIX} 4cc6 (build) completed\n${lines(80)}` }]
    })
    expect(doc).toContain('### Message from Crucible')
    expect(doc).not.toContain('### User')
    expect(doc).toContain('(41 more lines)')
  })

  it('fences a result with more backticks than it contains', () => {
    const doc = renderConversation({
      items: [{ kind: 'tool', name: 'Read', summary: 'a.md', ok: true, output: '```js\nx\n```' }]
    })
    expect(doc).toContain('````\n```js\nx\n```\n````')
  })

  it('puts the previous summary first when there is one', () => {
    const doc = renderConversation({
      previousSummary: 'What came before.',
      items: [{ kind: 'user', text: 'and now' }] as TranscriptItem[]
    })
    expect(doc.indexOf('What came before.')).toBeLessThan(doc.indexOf('## Messages'))
  })
})
