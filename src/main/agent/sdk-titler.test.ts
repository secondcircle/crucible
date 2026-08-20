// @vitest-environment node
//
// The two halves of titling that need no model: what the titler is allowed to
// see, and what is made of whatever it answers.
import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '../../shared/agent/port'
import { sanitizeTitle, TITLE_INSTRUCTION, titleInput } from './sdk-titler'

describe('what the titler sees', () => {
  it('is what the two speakers said and the summaries standing in for it', () => {
    const items: TranscriptItem[] = [
      { kind: 'user', text: 'rebuild the composer footer' },
      { kind: 'thinking', text: 'the mock says the row keeps its height' },
      { kind: 'tool', name: 'read', summary: 'composer.css', ok: true, output: '.esc { }' },
      { kind: 'bashRun', command: 'npm test', output: '651 passed' },
      { kind: 'summary', text: 'the branch so far' },
      { kind: 'assistant', markdown: 'The hints are gone and the row reserves its height.' },
      { kind: 'stopped' },
      { kind: 'error', message: 'that turn failed' }
    ]

    const input = titleInput(items) ?? ''

    expect(input).toContain('user: rebuild the composer footer')
    expect(input).toContain('assistant: The hints are gone')
    expect(input).toContain('summary: the branch so far')
    expect(input).not.toContain('the mock says')
    expect(input).not.toContain('composer.css')
    expect(input).not.toContain('npm test')
    expect(input).not.toContain('that turn failed')
  })

  it('can name a compacted conversation by its summary alone', () => {
    // Right after a compaction the summary may be all there is: the titler
    // reading nothing here is how a session once earned the title "I need
    // more context to name this conversation".
    const input = titleInput([
      { kind: 'summary', text: 'we rebuilt the sidebar tree and its tests' }
    ])

    expect(input).toBe('summary: we rebuilt the sidebar tree and its tests')
  })


  it('keeps the conversation oldest first', () => {
    const input =
      titleInput([
        { kind: 'user', text: 'first' },
        { kind: 'assistant', markdown: 'second' }
      ]) ?? ''

    expect(input.indexOf('first')).toBeLessThan(input.indexOf('second'))
  })

  it('clips a long message rather than letting it fill the whole input', () => {
    const input = titleInput([{ kind: 'user', text: 'x'.repeat(2_000) }]) ?? ''

    expect(input.length).toBeLessThan(600)
    expect(input).toContain('…')
  })

  it('drops the oldest messages once the whole is too long', () => {
    const many: TranscriptItem[] = Array.from({ length: 40 }, (_, at) => ({
      kind: 'user',
      text: `${at === 0 ? 'oldest' : 'later'} ${'y'.repeat(400)}`
    }))

    const input = titleInput(many) ?? ''

    expect(input).not.toContain('oldest')
    expect(input.length).toBeLessThanOrEqual(4_600)
  })

  it('has nothing to say about a conversation with no messages in it', () => {
    expect(titleInput([])).toBeUndefined()
    expect(titleInput([{ kind: 'stopped' }])).toBeUndefined()
  })

  it('reads a prompt the conversation does not hold yet', () => {
    // The first seconds of a session: the turn has started and nothing of it
    // has reached the conversation.
    const input = titleInput([], 'rewrite the sidebar tree') ?? ''

    expect(input).toBe('user: rewrite the sidebar tree')
  })

  it('puts that prompt after everything already said', () => {
    const input =
      titleInput(
        [
          { kind: 'user', text: 'first' },
          { kind: 'assistant', markdown: 'second' }
        ],
        'third'
      ) ?? ''

    expect(input.indexOf('second')).toBeLessThan(input.indexOf('third'))
  })

  it('says a prompt the conversation caught up with only once', () => {
    const input = titleInput([{ kind: 'user', text: 'catch up' }], 'catch up') ?? ''

    expect(input).toBe('user: catch up')
  })

  it('asks for what the sidebar has room for', () => {
    expect(TITLE_INSTRUCTION).toContain('5-8 word')
  })
})

describe('what is made of the answer', () => {
  it('is the first line, unquoted and single-spaced', () => {
    expect(sanitizeTitle('"Removing  the composer hint bar"\n\nAnything after it')).toBe(
      'Removing the composer hint bar'
    )
  })

  it('strips the curly quotes a model reaches for too', () => {
    expect(sanitizeTitle('“Naming sessions from their messages”')).toBe(
      'Naming sessions from their messages'
    )
  })

  it('is absent when the model answered with nothing at all', () => {
    expect(sanitizeTitle('')).toBeUndefined()
    expect(sanitizeTitle('   \n  ')).toBeUndefined()
    expect(sanitizeTitle('""')).toBeUndefined()
  })

  it('is absent when the model talked instead of naming', () => {
    expect(
      sanitizeTitle(
        'I need more context to name this conversation. Could you tell me what it is about?'
      )
    ).toBeUndefined()
  })

  it('still allows a name a few words past the ask', () => {
    expect(sanitizeTitle('Fixing the titler so a refusal never becomes a title')).toBe(
      'Fixing the titler so a refusal never becomes a title'
    )
  })
})
