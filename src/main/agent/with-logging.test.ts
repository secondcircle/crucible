// @vitest-environment node
//
// `withLogging` has two outputs and this test reads both: the agent port it
// returns — driven exactly as any caller drives a port — and the records that
// land in the sink while that happens. The adapter behind it is the fake, the
// same module a `npm run dev` launch runs on, so what the log says here is what
// the log says there; the sink is the in-memory adapter, which is what the file
// adapter would have written.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createFakeAdapter } from '../../shared/agent/fake-adapter'
import type { AgentAdapter, PortEvent, PortEventListener, TurnId } from '../../shared/agent/port'
import { createMemorySink, type LogRecord, type MemorySink } from '../log/sink'
import { withLogging } from './with-logging'

function parse(sink: MemorySink): LogRecord[] {
  return sink.lines.map((line) => JSON.parse(line) as LogRecord)
}

/** Lets a zero-pause turn run to completion on microtasks alone. */
async function until(done: () => boolean, what: string): Promise<void> {
  for (let step = 0; step < 1000; step += 1) {
    if (done()) return
    await Promise.resolve()
  }
  throw new Error(`never happened: ${what}`)
}

/**
 * A port that does whatever a test needs it to do, for the failures the fake
 * has no way to produce: it is the only place errors come from here.
 */
function stubPort(prompt: () => Promise<TurnId>): AgentAdapter & { emit(event: PortEvent): void } {
  const listeners = new Set<PortEventListener>()
  return {
    prompt,
    onEvent(listener: PortEventListener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {},
    emit(event: PortEvent) {
      for (const listener of [...listeners]) listener(event)
    }
  }
}

describe('logging at the agent-port seam', () => {
  it('records the prompt, the turn it was given and every event of that turn', async () => {
    const sink = createMemorySink()
    const port = withLogging(createFakeAdapter({ deltaPauseMs: 0 }), sink, 'fake')

    const turnId = await port.prompt('Hello agent')
    await until(
      () => parse(sink).some((record) => record.event === 'turn_ended'),
      'the turn ended'
    )

    const records = parse(sink)
    expect(records.map((record) => record.event)).toEqual([
      'turn_started',
      'prompt',
      ...records.filter((record) => record.event === 'text_delta').map(() => 'text_delta'),
      'turn_ended'
    ])
    expect(records[0]).toMatchObject({ source: 'main', event: 'turn_started', turnId })
    // The prompt and the turn that answered it are one record, so a reader
    // never has to join two lines to learn what `t-1` was asked.
    expect(records[1]).toMatchObject({
      source: 'main',
      event: 'prompt',
      turnId,
      prompt: 'Hello agent'
    })

    const deltas = records.filter((record) => record.event === 'text_delta')
    expect(deltas.length).toBeGreaterThan(1)
    expect(deltas.map((record) => record.delta).join('')).toContain('fake adapter')
    expect(records.at(-1)).toMatchObject({ source: 'main', event: 'turn_ended', turnId })
  })

  it('says on every record it writes which adapter answered', async () => {
    const sink = createMemorySink()
    const port = withLogging(createFakeAdapter({ deltaPauseMs: 0 }), sink, 'fake')

    await port.prompt('Hello agent')
    await until(() => parse(sink).some((record) => record.event === 'turn_ended'), 'the turn ended')

    expect(parse(sink).every((record) => record.adapter === 'fake')).toBe(true)
  })

  it('records a prompt the adapter refuses, and still refuses it', async () => {
    const sink = createMemorySink()
    const failure = new Error('no session')
    const port = withLogging(
      stubPort(() => Promise.reject(failure)),
      sink,
      'sdk'
    )

    await expect(port.prompt('Hello agent')).rejects.toBe(failure)

    const records = parse(sink)
    // No turn was ever minted, so the text is what identifies the attempt.
    expect(records.map((record) => record.event)).toEqual(['prompt_failed'])
    expect(records[0]).toMatchObject({
      source: 'main',
      adapter: 'sdk',
      prompt: 'Hello agent',
      message: 'no session'
    })
    expect(records[0].turnId).toBeUndefined()
    // The stack is what the log is for; it never crosses the port (D3).
    expect(String(records[0].stack)).toContain('no session')
  })

  it('records a turn that ends in an error, code and message and all', () => {
    const sink = createMemorySink()
    const behind = stubPort(() => Promise.resolve('t-1'))
    withLogging(behind, sink, 'fake')

    behind.emit({ type: 'error', turnId: 't-1', code: 'adapter', message: 'the model went away' })

    expect(parse(sink)).toMatchObject([
      {
        source: 'main',
        event: 'error',
        adapter: 'fake',
        turnId: 't-1',
        code: 'adapter',
        message: 'the model went away'
      }
    ])
  })

  it('is the port it wraps: same events, same ids, same unsubscribe, same disposal', async () => {
    const sink = createMemorySink()
    const behind = createFakeAdapter({ deltaPauseMs: 0 })
    const port = withLogging(behind, sink, 'fake')

    const heard: PortEvent[] = []
    const stop = port.onEvent((event) => heard.push(event))
    const turnId = await port.prompt('Hello agent')
    await until(() => heard.some((event) => event.type === 'turn_ended'), 'the turn ended')

    expect(turnId).toBe('t-1')
    expect(heard[0]).toEqual({ type: 'turn_started', turnId: 't-1' })
    expect(heard.at(-1)).toEqual({ type: 'turn_ended', turnId: 't-1' })
    // What the caller heard is what the log holds, turn by turn.
    expect(heard.map((event) => event.type)).toEqual(
      parse(sink)
        .map((record) => record.event)
        .filter((event) => event !== 'prompt')
    )

    stop()
    const before = heard.length
    await port.prompt('Again')
    await until(
      () => parse(sink).filter((record) => record.event === 'turn_started').length === 2,
      'the second turn started'
    )
    // Unsubscribed, so the caller hears nothing more — while the log, which
    // subscribes for itself, keeps recording.
    expect(heard).toHaveLength(before)
  })

  it('forwards disposal, so an abandoned turn stops being recorded too', async () => {
    const sink = createMemorySink()
    const port = withLogging(createFakeAdapter({ deltaPauseMs: 0 }), sink, 'fake')

    await port.prompt('Hello agent')
    port.dispose()
    // Long enough for the whole script to have run, had it not been abandoned.
    for (let step = 0; step < 200; step += 1) await Promise.resolve()

    const events = parse(sink).map((record) => record.event)
    expect(events).toContain('turn_started')
    expect(events).not.toContain('turn_ended')
  })

  it('no adapter references logging: it arrives at the seam or not at all', () => {
    const adapters = [
      '../../shared/agent/fake-adapter.ts',
      '../../renderer/src/agent/ipc-client.ts'
    ]
    for (const adapter of adapters) {
      const source = readFileSync(new URL(adapter, import.meta.url), 'utf8')
      expect(source).not.toMatch(/log\/sink|withLogging|LogSink/)
    }
  })
})
