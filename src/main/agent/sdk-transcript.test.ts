// @vitest-environment node
//
// Fake messages of the shapes π stores, never a session, so this suite makes no
// paid call.
import { describe, expect, it } from 'vitest'
import { toTranscript, type StoredMessage } from './sdk-transcript'

function messages(...stored: unknown[]): StoredMessage[] {
  return stored as StoredMessage[]
}

describe('a restored conversation', () => {
  it('reads back as the sequence that happened', () => {
    const items = toTranscript(
      messages(
        { role: 'user', content: 'Render the palette as tokens.' },
        {
          role: 'assistant',
          stopReason: 'toolUse',
          content: [
            { type: 'thinking', thinking: 'one file, referenced everywhere' },
            { type: 'text', text: 'Reading the mock first.' },
            { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'mock-a.html' } }
          ]
        },
        {
          role: 'toolResult',
          toolCallId: 'c1',
          toolName: 'read',
          isError: false,
          content: [{ type: 'text', text: '--accent:#e07a4f' }]
        },
        {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'Done: `--accent` is the one accent.' }]
        }
      )
    )

    expect(items).toEqual([
      { kind: 'user', text: 'Render the palette as tokens.' },
      { kind: 'thinking', text: 'one file, referenced everywhere' },
      { kind: 'assistant', markdown: 'Reading the mock first.' },
      { kind: 'tool', name: 'read', summary: 'mock-a.html', ok: true, output: '--accent:#e07a4f' },
      { kind: 'assistant', markdown: 'Done: `--accent` is the one accent.' }
    ])
  })

  it('closes an aborted message with the same quiet stopped marker', () => {
    const items = toTranscript(
      messages({
        role: 'assistant',
        stopReason: 'aborted',
        content: [{ type: 'text', text: 'Half a sen' }]
      })
    )

    expect(items).toEqual([
      { kind: 'assistant', markdown: 'Half a sen' },
      { kind: 'stopped' }
    ])
  })

  it('closes a failed message with a display-safe error item', () => {
    const items = toTranscript(
      messages({
        role: 'assistant',
        stopReason: 'error',
        errorMessage: '500 {"request_id":"req-secret"}',
        content: []
      })
    )

    expect(items).toEqual([{ kind: 'error', message: 'The turn failed.' }])
  })

  it('marks a failed tool result as failed', () => {
    const items = toTranscript(
      messages({
        role: 'toolResult',
        toolCallId: 'c9',
        toolName: 'bash',
        isError: true,
        content: [{ type: 'text', text: 'exit 1' }]
      })
    )

    expect(items).toEqual([
      { kind: 'tool', name: 'bash', summary: '', ok: false, output: 'exit 1' }
    ])
  })

  it('drops what a transcript item cannot carry', () => {
    const items = toTranscript(
      messages(
        { role: 'custom', customType: 'x', content: 'internal' },
        { role: 'user', content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] },
        { role: 'user', content: [{ type: 'text', text: 'and a question' }] }
      )
    )

    expect(items).toEqual([{ kind: 'user', text: 'and a question' }])
  })
})
