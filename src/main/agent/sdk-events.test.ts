// @vitest-environment node
//
// Fakes of the SDK's event stream, never a real session, so nothing here makes
// a paid call.
import { describe, expect, it } from 'vitest'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { ImageAttachment } from '../../shared/agent/port'
import { createQueuedImages } from './queued-images'
import {
  createEventMapper,
  displayToolCall,
  jumpOutcome,
  renderToolOutput,
  summarizeRetryOf,
  summarizeToolArgs
} from './sdk-events'

const TARGET = { sessionId: 's1', turnId: 't-1' }

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

// The window before a call runs, which π reports and Crucible used to drop on
// the floor: on a long Write it is tens of seconds of nothing.
describe('a call whose arguments are still streaming', () => {
  function partial(id: string, name: string): unknown {
    return { content: [{ type: 'toolCall', id, name, arguments: {} }] }
  }

  it('opens the call the moment the model commits to it', () => {
    expect(
      map({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_start',
          contentIndex: 0,
          partial: partial('call-1', 'write')
        }
      })
    ).toEqual({
      type: 'tool_call_started',
      sessionId: 's1',
      turnId: 't-1',
      callId: 'call-1',
      name: 'write'
    })
  })

  it('counts argument characters cumulatively, never per frame', () => {
    const mapper = createEventMapper()
    const started = {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_start',
        contentIndex: 0,
        partial: partial('call-1', 'write')
      }
    }
    const delta = (text: string): unknown => ({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_delta',
        contentIndex: 0,
        delta: text,
        partial: partial('call-1', 'write')
      }
    })
    mapper.map(sdk(started), TARGET)

    expect(mapper.map(sdk(delta('12345')), TARGET)).toEqual({
      type: 'tool_call_args',
      sessionId: 's1',
      turnId: 't-1',
      callId: 'call-1',
      chars: 5
    })
    expect(mapper.map(sdk(delta('678')), TARGET)).toMatchObject({ chars: 8 })
  })

  it('says nothing about a block that is not a call it can name', () => {
    expect(
      map({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_start',
          contentIndex: 0,
          partial: { content: [{ type: 'text', text: 'not a call' }] }
        }
      })
    ).toBeUndefined()
  })

  it('drops toolcall_end: execution start or the call’s own end settles it', () => {
    expect(
      map({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_end',
          contentIndex: 0,
          toolCall: { type: 'toolCall', id: 'call-1', name: 'write', arguments: {} },
          partial: partial('call-1', 'write')
        }
      })
    ).toBeUndefined()
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

// π takes a message out of its queue and says so immediately before that
// message starts, which is the signal a delivery is told apart by.
describe('queued messages', () => {
  it('reports the whole queue after any change', () => {
    expect(map({ type: 'queue_update', steering: ['redirect'], followUp: [] })).toEqual({
      type: 'queue_changed',
      sessionId: 's1',
      steering: [{ text: 'redirect' }],
      followUp: []
    })
  })

  it('announces a queued message that has just been delivered', () => {
    const mapper = createEventMapper()
    mapper.map(sdk({ type: 'queue_update', steering: ['redirect'], followUp: [] }), TARGET)
    mapper.map(sdk({ type: 'queue_update', steering: [], followUp: [] }), TARGET)

    expect(
      mapper.map(
        sdk({
          type: 'message_start',
          message: { role: 'user', content: [{ type: 'text', text: 'redirect' }] }
        }),
        TARGET
      )
    ).toEqual({ type: 'user_message', sessionId: 's1', turnId: 't-1', text: 'redirect' })
  })

  it('says nothing about the prompt’s own message, which its caller echoed', () => {
    expect(
      map({
        type: 'message_start',
        message: { role: 'user', content: [{ type: 'text', text: 'write the adapter' }] }
      })
    ).toBeUndefined()
  })

  it('announces a delivered message exactly once', () => {
    const mapper = createEventMapper()
    mapper.map(sdk({ type: 'queue_update', steering: ['again'], followUp: [] }), TARGET)
    mapper.map(sdk({ type: 'queue_update', steering: [], followUp: [] }), TARGET)
    const start = sdk({
      type: 'message_start',
      message: { role: 'user', content: [{ type: 'text', text: 'again' }] }
    })

    expect(mapper.map(start, TARGET)).toMatchObject({ type: 'user_message' })
    expect(mapper.map(start, TARGET)).toBeUndefined()
  })

  it('says nothing about a message merely being queued', () => {
    const mapper = createEventMapper()
    mapper.map(sdk({ type: 'queue_update', steering: ['later'], followUp: [] }), TARGET)

    expect(
      mapper.map(
        sdk({
          type: 'message_start',
          message: { role: 'user', content: [{ type: 'text', text: 'later' }] }
        }),
        TARGET
      )
    ).toBeUndefined()
  })

  // π's queue is text, so the pictures are paired back on from the memory the
  // adapter fills when it hands a message over.
  describe('the pictures π’s queue cannot carry', () => {
    const SHOT: ImageAttachment = { mimeType: 'image/png', data: 'AAAAAA==' }

    function withImage(): ReturnType<typeof createEventMapper> {
      const queued = createQueuedImages()
      queued.add('steering', 'look at this', [SHOT])
      return createEventMapper(undefined, queued)
    }

    it('rides the queue it reports', () => {
      const mapper = withImage()

      expect(
        mapper.map(sdk({ type: 'queue_update', steering: ['look at this'], followUp: [] }), TARGET)
      ).toEqual({
        type: 'queue_changed',
        sessionId: 's1',
        steering: [{ text: 'look at this', images: [SHOT] }],
        followUp: []
      })
    })

    it('is announced with the message that carried it, and not before', () => {
      const mapper = withImage()
      const start = sdk({
        type: 'message_start',
        message: { role: 'user', content: [{ type: 'text', text: 'look at this' }] }
      })
      mapper.map(sdk({ type: 'queue_update', steering: ['look at this'], followUp: [] }), TARGET)

      // Still queued: nothing is said about it at all.
      expect(mapper.map(start, TARGET)).toBeUndefined()

      mapper.map(sdk({ type: 'queue_update', steering: [], followUp: [] }), TARGET)
      expect(mapper.map(start, TARGET)).toEqual({
        type: 'user_message',
        sessionId: 's1',
        turnId: 't-1',
        text: 'look at this',
        images: [SHOT]
      })
    })

    // Two queued messages can hold the same words with different pictures, and
    // π delivers the older one first: it removes the first text that matches
    // and its own queue is oldest-first. So the picture left in the queue is
    // the younger message's, and the picture announced is the older one's.
    const OTHER: ImageAttachment = { mimeType: 'image/jpeg', data: 'BBBBBB==' }

    it('stays with its own message when two of them read alike', () => {
      const queued = createQueuedImages()
      queued.add('steering', 'again', [SHOT])
      queued.add('steering', 'again', [OTHER])
      const mapper = createEventMapper(undefined, queued)
      const start = sdk({
        type: 'message_start',
        message: { role: 'user', content: [{ type: 'text', text: 'again' }] }
      })

      mapper.map(sdk({ type: 'queue_update', steering: ['again', 'again'], followUp: [] }), TARGET)
      // π delivered the older one, so the row still waiting is the younger.
      const shrunk = mapper.map(
        sdk({ type: 'queue_update', steering: ['again'], followUp: [] }),
        TARGET
      )

      expect(shrunk).toMatchObject({ steering: [{ text: 'again', images: [OTHER] }] })
      expect(mapper.map(start, TARGET)).toMatchObject({ images: [SHOT] })
    })

    // π's own `steer()` rewrites the text before it pushes it: a `/skill:name`
    // command becomes the skill's body, and a `/name` that matches one of π's
    // prompt templates becomes that template. Crucible hands `/`-leading text
    // straight over, because its renderer only expands its own commands and
    // passes anything else through. What π then reports is not what was handed
    // to it, but the pictures still belong to that message.
    it('rides a message π rewrote on its way into the queue', () => {
      const queued = createQueuedImages()
      queued.add('steering', '/skill:review look at this', [SHOT])
      const mapper = createEventMapper(undefined, queued)
      const rewritten = '<skill name="review" location="/s/review.md">…</skill>\n\nlook at this'

      expect(
        mapper.map(sdk({ type: 'queue_update', steering: [rewritten], followUp: [] }), TARGET)
      ).toMatchObject({ steering: [{ text: rewritten, images: [SHOT] }] })

      // Delivered: the transcript entry and the model both get the picture.
      mapper.map(sdk({ type: 'queue_update', steering: [], followUp: [] }), TARGET)
      expect(
        mapper.map(
          sdk({
            type: 'message_start',
            message: { role: 'user', content: [{ type: 'text', text: rewritten }] }
          }),
          TARGET
        )
      ).toMatchObject({ text: rewritten, images: [SHOT] })
    })

    // Removing one queued message costs π's queue a clear and a requeue, which
    // empties this memory and fills it again. Neither is a delivery: what left
    // the queue is the memory's own answer, and it says nothing left.
    it('says nothing about a message a dequeue merely put back', () => {
      const queued = createQueuedImages()
      queued.add('steering', 'the first', [SHOT])
      queued.add('steering', 'the second', [OTHER])
      const mapper = createEventMapper(undefined, queued)
      mapper.map(
        sdk({ type: 'queue_update', steering: ['the first', 'the second'], followUp: [] }),
        TARGET
      )

      // What the adapter's dequeue does: read the memory out, clear π's queue,
      // then queue the survivor back in.
      queued.take()
      mapper.map(sdk({ type: 'queue_update', steering: [], followUp: [] }), TARGET)
      queued.add('steering', 'the second', [OTHER])
      const back = mapper.map(
        sdk({ type: 'queue_update', steering: ['the second'], followUp: [] }),
        TARGET
      )

      expect(back).toMatchObject({ steering: [{ text: 'the second', images: [OTHER] }] })
      expect(
        mapper.map(
          sdk({
            type: 'message_start',
            message: { role: 'user', content: [{ type: 'text', text: 'the second' }] }
          }),
          TARGET
        )
      ).toBeUndefined()
    })
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

// A jump is not a turn: what π says about the summary it is writing crosses
// the port on its own, and only while a summarizing jump is in flight.
describe('a summarizing jump', () => {
  it('becomes a session-scoped retry event, in π’s own count', () => {
    expect(
      summarizeRetryOf(
        sdk({
          type: 'summarization_retry_scheduled',
          attempt: 2,
          maxAttempts: 3,
          delayMs: 4000,
          errorMessage: 'Overloaded'
        }),
        's1'
      )
    ).toEqual({
      type: 'summarize_retry',
      sessionId: 's1',
      attempt: 2,
      maxAttempts: 3,
      delayMs: 4000,
      message: 'Overloaded'
    })
  })

  it('carries display-safe text, with the payload left in the run log', () => {
    expect(
      summarizeRetryOf(
        sdk({
          type: 'summarization_retry_scheduled',
          attempt: 1,
          maxAttempts: 3,
          delayMs: 2000,
          errorMessage:
            '529 {"type":"error","error":{"message":"Overloaded"},"request_id":"req_014"}'
        }),
        's1'
      )
    ).toMatchObject({ message: 'Overloaded' })
  })

  it('is the only event it answers for', () => {
    expect(summarizeRetryOf(sdk({ type: 'compaction_start', reason: 'threshold' }), 's1'))
      .toBeUndefined()
    expect(
      summarizeRetryOf(sdk({ type: 'summarization_retry_finished' }), 's1')
    ).toBeUndefined()
  })

  // π's own retry events are raised for compaction inside a turn too, so the
  // turn mapper must stay silent about them: a compaction retry is not a jump.
  it('is never mistaken for something a turn said', () => {
    expect(
      map({
        type: 'summarization_retry_scheduled',
        attempt: 2,
        maxAttempts: 3,
        delayMs: 4000,
        errorMessage: 'Overloaded'
      })
    ).toBeUndefined()
  })
})

describe('what navigateTree answered', () => {
  it('is a jump that happened, with the message it handed back', () => {
    expect(jumpOutcome({ cancelled: false, editorText: 'Hook it up' })).toEqual({
      cancelled: false,
      editorText: 'Hook it up'
    })
    expect(jumpOutcome({ cancelled: false })).toEqual({ cancelled: false })
  })

  // Cancelled and aborted are the same fact: π stopped before moving the leaf,
  // and the user asked it to. Neither is a failure.
  it('is a cancellation that moved nothing, never a rejection', () => {
    expect(jumpOutcome({ cancelled: true })).toEqual({ cancelled: true })
    expect(jumpOutcome({ cancelled: false, aborted: true })).toEqual({ cancelled: true })
    expect(jumpOutcome({ cancelled: true, editorText: 'Hook it up' })).toEqual({
      cancelled: true
    })
  })
})

// Attribution is by directory, so what these pin down is where one skill's
// claim on a path stops.
describe('a read attributed to a skill', () => {
  const CWD = '/repos/crucible'

  const inForce = {
    cwd: CWD,
    skills: [
      {
        name: 'writing-agent-prompts',
        filePath: '/skills/writing-agent-prompts/SKILL.md',
        baseDir: '/skills/writing-agent-prompts'
      },
      // A skill that is a single loose file at an origin root: its directory
      // is the origin, full of other people's skills.
      { name: 'loose', filePath: '/skills/loose.md', baseDir: '/skills' }
    ]
  }

  const shown = (name: string, args: unknown): string =>
    `${displayToolCall(name, args, inForce).name} ${displayToolCall(name, args, inForce).summary}`

  it('is the skill\u2019s name for the SKILL.md itself, never a path', () => {
    expect(shown('read', { path: '/skills/writing-agent-prompts/SKILL.md' })).toBe(
      'skill writing-agent-prompts'
    )
  })

  it('is the skill\u2019s name and the file\u2019s path inside it for a supporting file', () => {
    expect(shown('read', { path: '/skills/writing-agent-prompts/scope-boundaries.md' })).toBe(
      'skill writing-agent-prompts \u00b7 scope-boundaries.md'
    )
    expect(
      shown('read', { path: '/skills/writing-agent-prompts/reference/examples/tone.md' })
    ).toBe('skill writing-agent-prompts \u00b7 reference/examples/tone.md')
  })

  it('resolves a path given relative to the working directory', () => {
    expect(
      displayToolCall(
        'read',
        { path: 'skills/local/SKILL.md' },
        {
          cwd: CWD,
          skills: [
            {
              name: 'local',
              filePath: `${CWD}/skills/local/SKILL.md`,
              baseDir: `${CWD}/skills/local`
            }
          ]
        }
      )
    ).toEqual({ name: 'skill', summary: 'local' })
  })

  it('leaves a read of a file under no skill exactly as it was', () => {
    expect(shown('read', { path: '/repos/crucible/CONTEXT.md' })).toBe(
      'read /repos/crucible/CONTEXT.md'
    )
  })

  it('leaves every tool that is not read alone, inside a skill directory or not', () => {
    expect(shown('grep', { path: '/skills/writing-agent-prompts', pattern: 'scope' })).toBe(
      'grep /skills/writing-agent-prompts'
    )
    expect(shown('bash', { command: 'ls /skills/writing-agent-prompts' })).toBe(
      'bash ls /skills/writing-agent-prompts'
    )
    expect(shown('ls', { path: '/skills/writing-agent-prompts' })).toBe(
      'ls /skills/writing-agent-prompts'
    )
  })

  it('lets a single-file skill claim its own file and none of its siblings', () => {
    expect(shown('read', { path: '/skills/loose.md' })).toBe('skill loose')
    expect(shown('read', { path: '/skills/writing-agent-prompts/SKILL.md' })).toBe(
      'skill writing-agent-prompts'
    )
    expect(shown('read', { path: '/skills/somebody-elses.md' })).toBe(
      'read /skills/somebody-elses.md'
    )
  })

  it('says nothing about skills when a turn is carrying none', () => {
    expect(displayToolCall('read', { path: '/skills/writing-agent-prompts/SKILL.md' })).toEqual({
      name: 'read',
      summary: '/skills/writing-agent-prompts/SKILL.md'
    })
  })

  // The row exists from the moment the model commits to the call, seconds
  // before any path has streamed. It reads `read` until the arguments settle.
  it('reads as read while its arguments stream, and as skill once they settle', () => {
    const mapper = createEventMapper(inForce)
    const opened = mapper.map(
      sdk({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_start',
          contentIndex: 0,
          partial: { content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }] }
        }
      }),
      TARGET
    )
    const running = mapper.map(
      sdk({
        type: 'tool_execution_start',
        toolCallId: 'c1',
        toolName: 'read',
        args: { path: '/skills/writing-agent-prompts/SKILL.md' }
      }),
      TARGET
    )

    expect(opened).toMatchObject({ type: 'tool_call_started', name: 'read' })
    expect(running).toMatchObject({
      type: 'tool_started',
      name: 'skill',
      summary: 'writing-agent-prompts'
    })
  })
})
