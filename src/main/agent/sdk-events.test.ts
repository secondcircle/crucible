// @vitest-environment node
//
// The SDK boundary is covered with fakes of the SDK's event stream, never a
// real session: `npm test` makes no paid call and constructs no SDK adapter
// (SA-8). What is asserted is the whole of the contract this translation owes
// its caller — which SDK events become which adapter events, which are dropped,
// and that nothing of the SDK's own shapes survives the crossing.
import { describe, expect, it } from 'vitest'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { createEventMapper, renderToolOutput, summarizeToolArgs } from './sdk-events'

const TARGET = { sessionId: 's1', turnId: 't-1' }

/** An SDK event, built loosely: the mapper is what has to survive real ones. */
function sdk(event: unknown): AgentSessionEvent {
  return event as AgentSessionEvent
}

function map(event: unknown): ReturnType<ReturnType<typeof createEventMapper>['map']> {
  return createEventMapper().map(sdk(event), TARGET)
}

describe('streaming content', () => {
  it('becomes text and thinking deltas for the turn it belongs to', () => {
    expect(map({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hi' } })).toEqual({
      type: 'text_delta',
      sessionId: 's1',
      turnId: 't-1',
      delta: 'Hi'
    })

    expect(
      map({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hm' } })
    ).toEqual({ type: 'thinking_delta', sessionId: 's1', turnId: 't-1', delta: 'hm' })
  })

  it('drops the variants the port says nothing about', () => {
    expect(map({ type: 'message_update', assistantMessageEvent: { type: 'text_start' } })).toBeUndefined()
    expect(map({ type: 'message_start', message: { role: 'assistant' } })).toBeUndefined()
    expect(map({ type: 'agent_start' })).toBeUndefined()
    expect(map({ type: 'compaction_start', reason: 'threshold' })).toBeUndefined()
  })

  it('drops turn_start and turn_end: the port turn is bounded by the prompt', () => {
    expect(map({ type: 'turn_start' })).toBeUndefined()
    expect(map({ type: 'turn_end', message: {}, toolResults: [] })).toBeUndefined()
  })
})

describe('tool calls', () => {
  it('opens with the tool name and the argument a person recognizes it by', () => {
    expect(
      map({
        type: 'tool_execution_start',
        toolCallId: 'call-1',
        toolName: 'bash',
        args: { command: 'npm test', timeout: 120 }
      })
    ).toEqual({
      type: 'tool_started',
      sessionId: 's1',
      turnId: 't-1',
      callId: 'call-1',
      name: 'bash',
      summary: 'npm test'
    })
  })

  it('forwards only what is new of a growing partial result', () => {
    const mapper = createEventMapper()
    mapper.map(sdk({ type: 'tool_execution_start', toolCallId: 'c', toolName: 'bash', args: {} }), TARGET)

    const first = mapper.map(
      sdk({
        type: 'tool_execution_update',
        toolCallId: 'c',
        toolName: 'bash',
        args: {},
        partialResult: { content: [{ type: 'text', text: 'one\n' }] }
      }),
      TARGET
    )
    const second = mapper.map(
      sdk({
        type: 'tool_execution_update',
        toolCallId: 'c',
        toolName: 'bash',
        args: {},
        partialResult: { content: [{ type: 'text', text: 'one\ntwo\n' }] }
      }),
      TARGET
    )

    expect(first).toMatchObject({ type: 'tool_output', chunk: 'one\n' })
    expect(second).toMatchObject({ type: 'tool_output', chunk: 'two\n' })
  })

  it('closes with the whole result and whether it failed', () => {
    expect(
      map({
        type: 'tool_execution_end',
        toolCallId: 'c',
        toolName: 'bash',
        isError: true,
        result: { content: [{ type: 'text', text: 'no such file' }], details: { code: 2 } }
      })
    ).toEqual({
      type: 'tool_ended',
      sessionId: 's1',
      turnId: 't-1',
      callId: 'c',
      ok: false,
      output: 'no such file'
    })
  })

  it('keeps images and structured details out of a transcript item', () => {
    expect(
      renderToolOutput({
        content: [
          { type: 'text', text: 'seen: ' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'text', text: 'one file' }
        ],
        details: { secret: 'do not render me' }
      })
    ).toBe('seen: one file')
  })

  it('summarizes whichever argument names what the call is doing', () => {
    expect(summarizeToolArgs({ path: '/repos/crucible/AGENTS.md' })).toBe('/repos/crucible/AGENTS.md')
    expect(summarizeToolArgs({ pattern: 'adapter', glob: '*.ts' })).toBe('adapter')
    expect(summarizeToolArgs({ oddly: 'named', other: 2 })).toBe('named')
    expect(summarizeToolArgs({})).toBe('')
  })
})

describe('failures', () => {
  it('becomes a turn error carrying a sentence, not a payload', () => {
    expect(
      map({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage:
            '400 {"type":"error","error":{"message":"You\'re out of extra usage."},"request_id":"req_01"}'
        }
      })
    ).toEqual({
      type: 'turn_error',
      sessionId: 's1',
      turnId: 't-1',
      message: "You're out of extra usage."
    })
  })

  it('says nothing about an abort: cancelled is the adapter\u2019s word to say', () => {
    expect(
      map({
        type: 'message_update',
        assistantMessageEvent: { type: 'error', reason: 'aborted', error: { errorMessage: 'Aborted' } }
      })
    ).toBeUndefined()
  })

  it('reports a streamed failure that was not an abort', () => {
    expect(
      map({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'error',
          reason: 'error',
          error: { errorMessage: 'Overloaded.' }
        }
      })
    ).toMatchObject({ type: 'turn_error', message: 'Overloaded.' })
  })

  it('leaves a normal message_end alone', () => {
    expect(map({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } })).toBeUndefined()
    expect(map({ type: 'message_end', message: { role: 'toolResult' } })).toBeUndefined()
  })
})
