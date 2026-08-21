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
