// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createMonitorModel } from './model'
import { createScriptedCheckRunner } from './scripted-checks'
import { memoryMonitorStore } from './store'
import type { MainMonitorService } from '../../shared/monitors/service'
import type { AdapterEvent } from '../../shared/agent/adapter'
import { createFakeAdapter, timingWords } from '../../shared/agent/fake-adapter'

const WORKSPACE = '/workspaces/crucible'

interface Rig {
  readonly adapter: ReturnType<typeof createFakeAdapter>
  readonly monitors: MainMonitorService
  readonly events: AdapterEvent[]
}

async function rigOf(): Promise<Rig> {
  const monitors = createMonitorModel({
    store: memoryMonitorStore(),
    checks: createScriptedCheckRunner(),
    deliver: async () => 'delivered',
    sessionExists: () => true
  })
  const adapter = createFakeAdapter({ pauseMs: 0, monitors: monitors.tools })
  await adapter.bind({ sessionId: 's1', workspacePath: WORKSPACE })
  const events: AdapterEvent[] = []
  adapter.onEvent((event) => events.push(event))
  return { adapter, monitors, events }
}

function toolRows(events: readonly AdapterEvent[]): { name: string; summary: string }[] {
  return events
    .filter((event) => event.type === 'tool_started')
    .map((event) => ({
      name: (event as { name: string }).name,
      summary: (event as { summary: string }).summary
    }))
}

function outputs(events: readonly AdapterEvent[]): string[] {
  return events
    .filter((event) => event.type === 'tool_ended')
    .map((event) => (event as { output: string }).output)
}

const said = (events: readonly AdapterEvent[]): string =>
  events
    .filter((event) => event.type === 'text_delta')
    .map((event) => (event as { delta: string }).delta)
    .join('')

describe('the scripted agent around monitors', () => {
  it('sets one from "watch …", and the row names the wait, not the command', async () => {
    const { adapter, monitors, events } = await rigOf()

    await adapter.prompt('s1', 't-1', 'watch pass every 5s up to 1m')

    expect(toolRows(events)).toEqual([
      { name: 'crucible_monitor', summary: 'pass · every 5s · up to 1m' }
    ])
    const [live] = (await monitors.snapshot()).monitors
    expect(live).toMatchObject({
      description: 'pass',
      cwd: WORKSPACE,
      intervalMs: 5_000,
      timeoutMs: 60_000
    })
    expect(live.reason).not.toBe('')
    expect(said(events)).toMatch(/speak up when it is done|watching that now/)
  })

  it('takes the defaults when the words name no timing', async () => {
    const { adapter, monitors } = await rigOf()
    await adapter.prompt('s1', 't-1', 'wait for CI on PR 482 to finish')
    const [live] = (await monitors.snapshot()).monitors
    expect(live).toMatchObject({
      description: 'CI on PR 482 to finish',
      intervalMs: 30_000,
      timeoutMs: 30 * 60_000
    })
  })

  it('lists what it is waiting on when asked', async () => {
    const { adapter, monitors, events } = await rigOf()
    await adapter.prompt('s1', 't-1', 'watch the port to free up')
    events.length = 0

    await adapter.prompt('s1', 't-2', 'what are you waiting on?')
    expect(toolRows(events)[0].name).toBe('crucible_monitors')
    expect(outputs(events)[0]).toContain('the port to free up')
    expect((await monitors.snapshot()).monitors).toHaveLength(1)
  })

  it('stops one by its id, and the chip goes with it', async () => {
    const { adapter, monitors, events } = await rigOf()
    await adapter.prompt('s1', 't-1', 'watch the port to free up')
    const [live] = (await monitors.snapshot()).monitors
    events.length = 0

    await adapter.prompt('s1', 't-2', `stop watching ${live.id}`)
    expect(toolRows(events)[0]).toEqual({ name: 'crucible_monitor_stop', summary: live.id })
    expect((await monitors.snapshot()).monitors).toEqual([])
  })

  it('answers a wake in the chat and calls nothing', async () => {
    const { adapter, events } = await rigOf()
    await adapter.prompt(
      's1',
      't-1',
      '⏳ Crucible monitor m-0001 — condition met: CI on PR #482 to finish'
    )
    expect(toolRows(events)).toEqual([])
    expect(said(events)).toContain('CI finished')
  })

  it('does not name a session after a wake, as it does not after a run', async () => {
    const { adapter } = await rigOf()
    await adapter.prompt('s1', 't-1', 'the actual thing we are doing here')
    await adapter.prompt(
      's1',
      't-2',
      '⏳ Crucible monitor m-0001 — condition met: CI on PR #482 to finish'
    )
    const titled = await adapter.titleConversation('s1')
    expect(titled?.title).toBe('the actual thing we are doing here')
  })

  it('leaves an ordinary prompt to the standard script', async () => {
    const { adapter, monitors } = await rigOf()
    await adapter.prompt('s1', 't-1', 'what does the watchdog do when a tool hangs?')
    expect((await monitors.snapshot()).monitors).toEqual([])
  })
})

describe('the words that name a cadence', () => {
  it('lifts them out, leaving what the chip says', () => {
    expect(timingWords('pass every 5s up to 1m')).toEqual({
      rest: 'pass',
      intervalSeconds: 5,
      timeoutSeconds: 60
    })
    expect(timingWords('CI on PR 482 to finish')).toEqual({ rest: 'CI on PR 482 to finish' })
    expect(timingWords('the publish every 2 minutes up to 1 hour')).toEqual({
      rest: 'the publish',
      intervalSeconds: 120,
      timeoutSeconds: 3600
    })
  })

  it('leaves a phrase alone when the unit is not one', () => {
    expect(timingWords('every good boy deserves fruit')).toEqual({
      rest: 'every good boy deserves fruit'
    })
  })
})
