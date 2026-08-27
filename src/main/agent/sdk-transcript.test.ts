// @vitest-environment node
//
// Fake messages of the shapes π stores, never a session, so this suite makes no
// paid call.
import { describe, expect, it } from 'vitest'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import {
  deliveredBashRunId,
  pathSeams,
  toTranscript,
  type StoredMessage
} from './sdk-transcript'
import { titleInput } from './sdk-titler'
import { markTurnContext } from './turn-context'

function messages(...stored: unknown[]): StoredMessage[] {
  return stored as StoredMessage[]
}

function delivered(event: unknown): string | undefined {
  return deliveredBashRunId(event as AgentSessionEvent)
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

  // Turn-start context reaches the model inside the user message π stored, and
  // no surface may show it. This is the whole of that guarantee at the pure
  // translation layer: no SDK, no session.
  it('shows the user’s message without the turn-start context that rode it', () => {
    const asked = markTurnContext(
      'Crucible status update — run 45c8 (build) — interrupted · app quit',
      'how is the build going?'
    )
    const items = toTranscript(
      messages(
        { role: 'user', content: asked },
        { role: 'user', content: [{ type: 'text', text: asked }] }
      )
    )

    expect(items).toEqual([
      { kind: 'user', text: 'how is the build going?' },
      { kind: 'user', text: 'how is the build going?' }
    ])
    // And the titler, which reads user text through the same translation.
    expect(titleInput(items) ?? '').not.toContain('interrupted')
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

  it('drops what a transcript item cannot carry, and keeps the images that were sent', () => {
    const items = toTranscript(
      messages(
        { role: 'custom', customType: 'x', content: 'internal' },
        { role: 'user', content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] },
        { role: 'user', content: [{ type: 'text', text: 'and a question' }] }
      )
    )

    expect(items).toEqual([
      // An extension's own custom entry is not conversation, and is dropped;
      // an image that was genuinely sent is, and renders again.
      { kind: 'user', text: '', images: [{ mimeType: 'image/png', data: 'AAAA' }] },
      { kind: 'user', text: 'and a question' }
    ])
  })

  it('reads branch and compaction summaries back as context, never dropped', () => {
    const items = toTranscript(
      messages(
        { role: 'branchSummary', summary: 'The abandoned branch tried a modal.', fromId: 'x1' },
        { role: 'compactionSummary', summary: 'Earlier: tokens were discussed.', tokensBefore: 9 },
        { role: 'user', content: 'Continue.' }
      )
    )

    expect(items).toEqual([
      { kind: 'summary', text: 'The abandoned branch tried a modal.' },
      { kind: 'summary', text: 'Earlier: tokens were discussed.' },
      { kind: 'user', text: 'Continue.' }
    ])
  })

  it('reads a shared bash run back as a run, not as prose', () => {
    const items = toTranscript(
      messages({
        role: 'custom',
        customType: 'crucible.bashRun',
        content: 'the text the model saw',
        details: { id: 'share-1', command: 'git status', output: 'clean\n', exitCode: 0 }
      })
    )

    expect(items).toEqual([
      { kind: 'bashRun', command: 'git status', output: 'clean\n', exitCode: 0 }
    ])
  })
})

// Watching any other event is watching for one that never comes, which would
// report an answered run as still local.
describe('the delivery point of a shared run', () => {
  it('is the message_end \u03c0 emits at the boundary that took it', () => {
    expect(
      delivered({
        type: 'message_end',
        message: {
          role: 'custom',
          customType: 'crucible.bashRun',
          content: 'the text the model saw',
          details: { id: 'share-2', command: 'git status', output: 'clean\n', exitCode: 0 }
        }
      })
    ).toBe('share-2')
  })

  it('is nothing else: not another run\u2019s message, not another kind of event', () => {
    expect(
      delivered({
        type: 'message_start',
        message: { role: 'custom', customType: 'crucible.bashRun', details: { id: 'share-2' } }
      })
    ).toBeUndefined()
    expect(
      delivered({
        type: 'message_end',
        message: { role: 'custom', customType: 'x', details: { id: 'share-2' } }
      })
    ).toBeUndefined()
    expect(
      delivered({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } })
    ).toBeUndefined()
    expect(
      delivered({
        type: 'message_end',
        message: { role: 'custom', customType: 'crucible.bashRun' }
      })
    ).toBeUndefined()
  })
})

// The numbers below are the review's own demonstration, run through the same
// mirror: A1 caches 10k, A2 (a branch later abandoned) reads it back, and A3
// re-bills 2k on the path the user jumped to. π compares A3 against A2 — the
// request that was really billed before it — not against A1, which is what a
// path-only scan would compare it against.
const A1 = {
  role: 'assistant',
  provider: 'anthropic',
  model: 'opus',
  timestamp: 1000,
  stopReason: 'stop',
  content: [{ type: 'text', text: 'the first answer' }],
  usage: {
    input: 200,
    cacheRead: 0,
    cacheWrite: 10_000,
    cost: { input: 0.01, cacheRead: 0, cacheWrite: 0.05 }
  }
}

const A2 = {
  role: 'assistant',
  provider: 'anthropic',
  model: 'opus',
  timestamp: 2000,
  stopReason: 'stop',
  content: [{ type: 'text', text: 'the answer on the branch that was left' }],
  usage: {
    input: 200,
    cacheRead: 10_000,
    cacheWrite: 20_000,
    cost: { input: 0.01, cacheRead: 0.003, cacheWrite: 0.1 }
  }
}

const A3 = {
  role: 'assistant',
  provider: 'anthropic',
  model: 'opus',
  timestamp: 3000,
  stopReason: 'stop',
  content: [{ type: 'text', text: 'the answer after the jump' }],
  usage: {
    input: 2000,
    cacheRead: 10_000,
    cacheWrite: 0,
    cost: { input: 0.03, cacheRead: 0.003, cacheWrite: 0 }
  }
}

const asked = (text: string): unknown => ({ role: 'user', content: text })

function entriesOf(...messages: readonly unknown[]): unknown[] {
  return messages.map((message) => ({ type: 'message', message }))
}

describe('the seams of a restored path', () => {
  it('compares each message against the request that was really billed before it', () => {
    const path = messages(asked('again'), A1, asked('and again'), A3)
    const seams = pathSeams(entriesOf(asked('again'), A1, asked('and again'), A2, A3), path)

    // A3 is the fourth item of the path, and it paid: 2000 tokens re-billed,
    // exactly what the live turn announced and the ledger recorded.
    expect([...seams.keys()]).toEqual([3])
    expect(seams.get(3)?.missedTokens).toBe(2000)
  })

  it('leaves the abandoned branch\u2019s own seams off the path it is not on', () => {
    const path = messages(A1, A2)
    const seams = pathSeams(entriesOf(A1, A2, A3), path)

    // A2 paid for nothing; A3's miss belongs to a message this path does not
    // show, so nothing is placed for it.
    expect([...seams.keys()]).toEqual([])
  })

  it('starts the comparison over at a compaction, wherever it sits', () => {
    const path = messages(A1, A3)
    const seams = pathSeams(
      [
        ...entriesOf(A1, A2),
        { type: 'compaction', summary: 'the story so far' },
        ...entriesOf(A3)
      ],
      path
    )

    expect([...seams.keys()]).toEqual([])
  })
})

describe('a path message \u03c0 repaired on load', () => {
  it('still carries the seam of the entry it was copied from', () => {
    // π normalizes a message stored with null content into a shallow copy, so
    // the path holds a different object than the entry does — but the same
    // usage, which is what the miss was computed from.
    const stored = { ...A3, content: null }
    const repaired = { ...stored, content: [] }
    const seams = pathSeams(entriesOf(asked('again'), A1, A2, stored), messages(A1, repaired))

    expect([...seams.keys()]).toEqual([1])
    expect(seams.get(1)?.missedTokens).toBe(2000)
  })
})
