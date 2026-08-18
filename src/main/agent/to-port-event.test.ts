// @vitest-environment node
//
// `toPortEvent` is the whole of D3's mapping, and this is the only place the π
// SDK's event shapes appear in a test. The SDK is stubbed rather than run: the
// events below are hand-built values typed as the SDK's own
// `AgentSessionEvent`, so the compiler checks them against the installed SDK
// while nothing here opens a session, spends money or touches the network — the
// reason the mapping lives in a module of its own, importing the SDK for types
// alone (D12).
import { describe, expect, it } from 'vitest'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { AssistantMessage } from '@earendil-works/pi-ai/compat'
import { toPortEvent } from './to-port-event'

/** The least assistant message the SDK's types accept, for stub events to carry. */
function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-fable-5',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp: 0,
    ...overrides
  }
}

describe('the four events the port speaks', () => {
  it('starts a turn on the SDK turn_start, under the id it was given', () => {
    const event: AgentSessionEvent = { type: 'turn_start' }

    expect(toPortEvent(event, 't-7')).toEqual({ type: 'turn_started', turnId: 't-7' })
  })

  it('carries a text delta through, and only its text', () => {
    const event: AgentSessionEvent = {
      type: 'message_update',
      message: assistantMessage(),
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'Hello',
        // The SDK's cumulative snapshot of the message so far: the one thing
        // the port must not carry, because a delta is what the pane appends.
        partial: assistantMessage({ content: [{ type: 'text', text: 'Hello' }] })
      }
    }

    expect(toPortEvent(event, 't-1')).toEqual({ type: 'text_delta', turnId: 't-1', delta: 'Hello' })
  })

  it('ends a turn on the SDK turn_end, carrying no text', () => {
    const event: AgentSessionEvent = {
      type: 'turn_end',
      message: assistantMessage(),
      toolResults: []
    }

    expect(toPortEvent(event, 't-1')).toEqual({ type: 'turn_ended', turnId: 't-1' })
  })

  it('turns a failed message into the turn error, coded adapter', () => {
    const event: AgentSessionEvent = {
      type: 'message_update',
      message: assistantMessage(),
      assistantMessageEvent: {
        type: 'error',
        reason: 'error',
        error: assistantMessage({ stopReason: 'error', errorMessage: 'overloaded_error' })
      }
    }

    expect(toPortEvent(event, 't-2')).toEqual({
      type: 'error',
      turnId: 't-2',
      code: 'adapter',
      message: 'overloaded_error'
    })
  })

  it('turns a message that ended in failure into the turn error, coded adapter', () => {
    // How a failed request actually reaches a subscriber in this SDK: not as an
    // `assistantMessageEvent.error` but folded into the final message, with
    // `turn_end` behind it and `prompt()` resolving as if all were well.
    const event: AgentSessionEvent = {
      type: 'message_end',
      message: assistantMessage({
        stopReason: 'error',
        errorMessage:
          '400 {"type":"error","error":{"message":"You\'re out of extra usage."},"request_id":"req_011CeAV1"}'
      })
    }

    // The sentence the provider meant a person to read — and only that. The
    // payload it arrived in stays on this side of the port (Contracts, D8).
    expect(toPortEvent(event, 't-3')).toEqual({
      type: 'error',
      turnId: 't-3',
      code: 'adapter',
      message: "You're out of extra usage."
    })
  })

  it('lets no provider payload across, from either direction a turn fails', () => {
    const payload =
      '400 {"type":"error","error":{"message":"Overloaded."},"request_id":"req-secret-diagnostic"}'
    const ended: AgentSessionEvent = {
      type: 'message_end',
      message: assistantMessage({ stopReason: 'error', errorMessage: payload })
    }
    const streaming: AgentSessionEvent = {
      type: 'message_update',
      message: assistantMessage(),
      assistantMessageEvent: {
        type: 'error',
        reason: 'error',
        error: assistantMessage({ stopReason: 'error', errorMessage: payload })
      }
    }

    for (const event of [ended, streaming]) {
      const message = (toPortEvent(event, 't-1') as { message: string }).message

      expect(message).toBe('Overloaded.')
      expect(message).not.toContain('request_id')
    }
  })

  it('still says something display-safe when the provider said nothing', () => {
    const silent: AgentSessionEvent = {
      type: 'message_update',
      message: assistantMessage(),
      assistantMessageEvent: {
        type: 'error',
        reason: 'error',
        error: assistantMessage({ stopReason: 'error', errorMessage: '   ' })
      }
    }
    const aborted: AgentSessionEvent = {
      type: 'message_update',
      message: assistantMessage(),
      assistantMessageEvent: {
        type: 'error',
        reason: 'aborted',
        error: assistantMessage({ stopReason: 'aborted' })
      }
    }

    const mute: AgentSessionEvent = {
      type: 'message_end',
      message: assistantMessage({ stopReason: 'error' })
    }

    expect(toPortEvent(silent, 't-1')).toMatchObject({ code: 'adapter' })
    expect((toPortEvent(silent, 't-1') as { message: string }).message).not.toBe('')
    expect((toPortEvent(aborted, 't-1') as { message: string }).message).toContain('stopped')
    expect((toPortEvent(mute, 't-1') as { message: string }).message).not.toBe('')
  })
})

describe('everything the mapping drops', () => {
  // Tools cannot arise at all (the session runs with tools off, D11), and
  // compaction and retries stay the SDK's own business: a turn being retried
  // has not ended and has not failed, so the port says nothing about it.
  const dropped: ReadonlyArray<readonly [string, AgentSessionEvent]> = [
    ['a tool call starting', { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read', args: {} }],
    [
      'a tool call reporting progress',
      { type: 'tool_execution_update', toolCallId: 'c1', toolName: 'read', args: {}, partialResult: {} }
    ],
    [
      'a tool call finishing',
      { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'read', result: {}, isError: false }
    ],
    ['compaction starting', { type: 'compaction_start', reason: 'threshold' }],
    [
      'compaction finishing',
      {
        type: 'compaction_end',
        reason: 'threshold',
        result: undefined,
        aborted: false,
        willRetry: false
      }
    ],
    [
      'a retry being scheduled',
      {
        type: 'auto_retry_start',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1000,
        errorMessage: 'overloaded_error'
      }
    ],
    ['a retry finishing', { type: 'auto_retry_end', success: true, attempt: 1 }],
    // A message that ended well is not an event of the port's: a turn's text is
    // its accumulated deltas, and nothing reconciles them after the fact.
    ['a message ending normally', { type: 'message_end', message: assistantMessage() }],
    [
      'the user message being recorded',
      {
        type: 'message_end',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello agent' }], timestamp: 0 }
      }
    ],
    ['a message starting', { type: 'message_start', message: assistantMessage() }],
    ['the agent run starting', { type: 'agent_start' }],
    ['the agent run ending', { type: 'agent_end', messages: [], willRetry: false }],
    [
      'thinking streaming',
      {
        type: 'message_update',
        message: assistantMessage(),
        assistantMessageEvent: {
          type: 'thinking_delta',
          contentIndex: 0,
          delta: 'hmm',
          partial: assistantMessage()
        }
      }
    ]
  ]

  it.each(dropped)('drops %s', (_what, event) => {
    expect(toPortEvent(event, 't-1')).toBeUndefined()
  })
})
