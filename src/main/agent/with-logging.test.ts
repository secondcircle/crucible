// @vitest-environment node
//
// The decorator has to be invisible to its caller and complete to its reader,
// so both halves are asserted here.
import { describe, expect, it } from 'vitest'
import type { LogRecord } from '../log/sink'
import { createMemorySink } from '../log/sink'
import type { PortEvent, PortEventListener } from '../../shared/agent/port'
import type { Shell } from '../shell/shell'
import { withLogging } from './with-logging'

function stubShell(): { shell: Shell; emit: (event: PortEvent) => void } {
  const listeners = new Set<PortEventListener>()
  const shell = {
    snapshot: async () => ({ workspaces: [], sessions: [] }),
    onEvent: (listener: PortEventListener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    prompt: async (sessionId: string, text: string) => {
      if (text === 'refuse me') throw new Error('That session is already working.')
      return `t-for-${sessionId}`
    },
    steer: async () => undefined,
    followUp: async () => undefined,
    dequeue: async (_sessionId: string, _kind: string, text: string) => ({
      text,
      images: [{ mimeType: 'image/png', data: 'AAAAAA==' }]
    }),
    jump: async (_sessionId: string, ref: string) => {
      if (ref === 'n7') throw new Error('Opus is overloaded')
      return { cancelled: false }
    },
    createSession: async () => 'session-1',
    cancel: async () => undefined,
    dispose: () => undefined
  } as unknown as Shell

  return {
    shell,
    emit: (event) => {
      for (const listener of listeners) listener(event)
    }
  }
}

function records(lines: readonly string[]): LogRecord[] {
  return lines.map((line) => JSON.parse(line) as LogRecord)
}

describe('what the run log holds', () => {
  it('is every operation, with its arguments and its answer', async () => {
    const sink = createMemorySink()
    const { shell } = stubShell()

    const logged = withLogging(shell, sink, 'fake')
    await logged.prompt('session-1', 'hello')

    expect(records(sink.lines)).toEqual([
      expect.objectContaining({ event: 'prompt', adapter: 'fake', args: ['session-1', 'hello'] }),
      expect.objectContaining({ event: 'prompt_answered', result: 't-for-session-1' })
    ])
  })

  it('is every event the port produced, under its own name', async () => {
    const sink = createMemorySink()
    const { shell, emit } = stubShell()

    withLogging(shell, sink, 'fake')
    emit({ type: 'turn_started', sessionId: 's', turnId: 't-1' })
    emit({ type: 'text_delta', sessionId: 's', turnId: 't-1', delta: 'hi' })

    expect(records(sink.lines)).toEqual([
      expect.objectContaining({ event: 'turn_started', sessionId: 's', turnId: 't-1' }),
      expect.objectContaining({ event: 'text_delta', delta: 'hi' })
    ])
  })

  it('is a refusal with the stack the port itself never carries', async () => {
    const sink = createMemorySink()
    const { shell } = stubShell()

    const logged = withLogging(shell, sink, 'fake')
    await expect(logged.prompt('session-1', 'refuse me')).rejects.toThrow(/already working/)

    const refused = records(sink.lines).at(-1)
    expect(refused).toMatchObject({
      event: 'prompt_refused',
      message: 'That session is already working.'
    })
    expect(String(refused?.stack)).toContain('with-logging.test')
  })

  // A summarize failure has to be reconstructible from the log alone: the
  // session, the ref, the provider's own words, and which attempt it was.
  it('is which retry π was on, because the event itself crossed the port', async () => {
    const sink = createMemorySink()
    const { shell, emit } = stubShell()

    withLogging(shell, sink, 'sdk')
    emit({
      type: 'summarize_retry',
      sessionId: 's1',
      attempt: 2,
      maxAttempts: 3,
      delayMs: 4000,
      message: 'Overloaded'
    })

    expect(records(sink.lines)).toEqual([
      expect.objectContaining({
        event: 'summarize_retry',
        adapter: 'sdk',
        sessionId: 's1',
        attempt: 2,
        maxAttempts: 3,
        delayMs: 4000,
        message: 'Overloaded'
      })
    ])
  })

  it('is a failed jump, with the session and the ref it was asked for', async () => {
    const sink = createMemorySink()
    const { shell } = stubShell()

    const logged = withLogging(shell, sink, 'sdk')
    await expect(logged.jump('s1', 'n7', { summarize: true })).rejects.toThrow(/overloaded/i)

    expect(records(sink.lines).at(-1)).toMatchObject({
      event: 'jump_refused',
      args: ['s1', 'n7', { summarize: true }],
      message: 'Opus is overloaded'
    })
  })

  // A queued 10 MB screenshot would otherwise be re-serialized as base64 into
  // every state record for as long as it sat in the queue.
  it('is an attachment’s type and size, on every path that carries one', async () => {
    const sink = createMemorySink()
    const { shell, emit } = stubShell()
    const image = { mimeType: 'image/png', data: 'AAAAAA==' }
    const bytes = { mimeType: 'image/png', bytes: 6 }

    const logged = withLogging(shell, sink, 'fake')
    await logged.steer('s1', 'look at this', [image])
    await logged.followUp('s1', 'and this', [image])
    await logged.dequeue('s1', 'steering', 'look at this')
    emit({
      type: 'state',
      snapshot: {
        workspaces: [],
        sessions: [
          {
            id: 's1',
            workspaceId: 'w1',
            createdAt: '2026-08-23T10:00:00.000Z',
            working: true,
            fresh: false,
            queue: { steering: [{ text: 'look at this', images: [image] }], followUp: [] }
          }
        ]
      }
    })
    emit({
      type: 'user_message',
      sessionId: 's1',
      turnId: 't-1',
      text: 'look at this',
      images: [image]
    })
    emit({
      type: 'queue_flushed',
      sessionId: 's1',
      messages: [{ kind: 'steering', text: 'look at this', images: [image] }]
    })

    const written = sink.lines.join('\n')
    expect(written).not.toContain('AAAAAA==')
    expect(records(sink.lines)).toMatchObject([
      { event: 'steer', args: ['s1', 'look at this', [bytes]] },
      { event: 'followUp', args: ['s1', 'and this', [bytes]] },
      { event: 'dequeue' },
      { event: 'dequeue_answered', result: { text: 'look at this', images: [bytes] } },
      {
        event: 'state',
        snapshot: {
          sessions: [{ queue: { steering: [{ text: 'look at this', images: [bytes] }] } }]
        }
      },
      { event: 'user_message', images: [bytes] },
      { event: 'queue_flushed', messages: [{ kind: 'steering', images: [bytes] }] }
    ])
  })

  it('leaves the snapshot unlogged: the state records already say it', async () => {
    const sink = createMemorySink()
    const { shell } = stubShell()

    const logged = withLogging(shell, sink, 'fake')
    await logged.snapshot()

    expect(sink.lines).toEqual([])
  })
})

describe('what a caller can tell', () => {
  it('is nothing: the wrapped shell answers exactly as the shell did', async () => {
    const sink = createMemorySink()
    const { shell } = stubShell()

    const logged = withLogging(shell, sink, 'fake')

    expect(await logged.createSession('w1')).toBe('session-1')
    expect(await logged.prompt('session-1', 'hello')).toBe('t-for-session-1')
    expect(await logged.snapshot()).toEqual({ workspaces: [], sessions: [] })
  })
})
