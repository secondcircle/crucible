// @vitest-environment node
//
// `selectAdapter` has two outputs and this test reads both: the port it returns
// — driven through the agent port, never inspected — and the one record it
// writes, which is what makes a misspelt flavor diagnosable instead of silent.
// Its one input is the environment it reads for itself (D5), so a flavor is
// driven the way a launch script drives it: by setting `CRUCIBLE_AGENT`.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LogRecord } from '../log/sink'
import { createMemorySink } from '../log/sink'
import type { PortEvent } from '../../shared/agent/port'
import { selectAdapter } from './select-adapter'

function chooseWith(requested: string | undefined): {
  record: LogRecord
  answers: () => Promise<PortEvent[]>
} {
  vi.stubEnv('CRUCIBLE_AGENT', requested)
  const sink = createMemorySink()
  const port = selectAdapter(sink)
  expect(sink.lines).toHaveLength(1)

  return {
    record: JSON.parse(sink.lines[0]) as LogRecord,
    // The adapter a launch gets streams at its own cadence, so the clock is
    // driven rather than waited on: no test here waits on a timer.
    answers: async () => {
      vi.useFakeTimers()
      const events: PortEvent[] = []
      port.onEvent((event) => events.push(event))
      await port.prompt('Hello agent')
      await vi.advanceTimersByTimeAsync(60_000)
      return events
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('the launch flavor', () => {
  it('is the fake adapter when nothing was asked for, and it answers', async () => {
    const chosen = chooseWith(undefined)

    expect(chosen.record).toMatchObject({
      source: 'main',
      event: 'adapter_selected',
      adapter: 'fake',
      requested: null,
      reason: null
    })

    const events = await chosen.answers()
    expect(events[0]).toEqual({ type: 'turn_started', turnId: 't-1' })
    expect(events.filter((event) => event.type === 'text_delta').length).toBeGreaterThan(1)
    expect(events.at(-1)).toEqual({ type: 'turn_ended', turnId: 't-1' })
  })

  it('is the fake adapter for an empty value, and says nothing was asked for', () => {
    expect(chooseWith('').record).toMatchObject({ adapter: 'fake', requested: null, reason: null })
  })

  it('puts an unrecognized value in the log rather than failing on it', () => {
    const { record } = chooseWith('sdkk')

    expect(record).toMatchObject({ adapter: 'fake', requested: 'sdkk' })
    expect(record.reason).toContain('sdkk')
  })

  it('says in the log why an asked-for sdk launch is answering with the fake', () => {
    const { record } = chooseWith('sdk')

    expect(record).toMatchObject({ adapter: 'fake', requested: 'sdk' })
    expect(record.reason).toContain('not built yet')
  })
})
