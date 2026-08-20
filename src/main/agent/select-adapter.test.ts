// @vitest-environment node
//
// One row is deliberately absent: asking for the SDK flavor would construct
// that adapter and open real sessions against the credentials on disk.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LogRecord } from '../log/sink'
import { createMemorySink } from '../log/sink'
import { panelFixtures } from '../panel/fixtures'
import { createPanelModel, memoryPanelPersistence } from '../panel/model'
import { decideFlavor, selectAdapter } from './select-adapter'

function chooseWith(requested: string | undefined): {
  record: LogRecord
  flavor: string
  answers: () => Promise<string[]>
} {
  vi.stubEnv('CRUCIBLE_AGENT', requested)
  const sink = createMemorySink()
  const { adapter, flavor } = selectAdapter(sink, {
    tools: createPanelModel({ persistence: memoryPanelPersistence() }),
    exhibits: panelFixtures(process.cwd())
  })
  expect(sink.lines).toHaveLength(1)

  return {
    record: JSON.parse(sink.lines[0]) as LogRecord,
    flavor,
    answers: async () => {
      const types: string[] = []
      adapter.onEvent((event) => types.push(event.type))
      await adapter.bind({ sessionId: 's1', workspacePath: '/repos/crucible' })
      await adapter.prompt('s1', 't-1', 'hello')
      return types
    }
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('which adapter a launch gets', () => {
  it('is the fake when nothing was asked for', async () => {
    const chosen = chooseWith(undefined)

    expect(chosen.flavor).toBe('fake')
    expect(chosen.record).toMatchObject({
      event: 'adapter_selected',
      adapter: 'fake',
      requested: null,
      reason: null
    })
    expect(await chosen.answers()).toContain('turn_ended')
  })

  it('is the fake when the fake was asked for by name', () => {
    expect(chooseWith('fake').record).toMatchObject({ adapter: 'fake', requested: 'fake', reason: null })
  })

  it('is the fake for anything unrecognized, and says why', () => {
    const chosen = chooseWith('SDK')

    expect(chosen.flavor).toBe('fake')
    expect(chosen.record.reason).toBe(
      'CRUCIBLE_AGENT=SDK is not a launch flavor, so the fake adapter answers'
    )
  })

  it('is the fake for an empty value, which is a variable set to nothing', () => {
    expect(chooseWith('').record).toMatchObject({ adapter: 'fake', requested: null })
  })
})

// The packaged rule is decided by the pure function, so it is provable here
// without constructing the SDK adapter it implies.
describe('what a packaged launch decides', () => {
  it('is the SDK adapter with nothing asked for, which is how the Dock launches it', () => {
    expect(decideFlavor(undefined, true)).toEqual({ flavor: 'sdk', requested: null, reason: null })
  })

  it('ignores a request for the fake, and says why', () => {
    expect(decideFlavor('fake', true)).toEqual({
      flavor: 'sdk',
      requested: 'fake',
      reason: 'a packaged launch always runs the SDK adapter, so CRUCIBLE_AGENT=fake is ignored'
    })
  })

  it('unpackaged, still answers the fake by default', () => {
    expect(decideFlavor(undefined, false)).toEqual({ flavor: 'fake', requested: null, reason: null })
  })
})
