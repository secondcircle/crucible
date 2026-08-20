// @vitest-environment node
//
// The fake flavor's panel turns, driven against the real panel model and the
// fixture exhibits that ship in the repository: every context panel behavior is
// exercised here at zero cost, which is what an agent driving `npm run dev`
// relies on.
import { existsSync, readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdapterEvent } from '../../shared/agent/adapter'
import { createFakeAdapter } from '../../shared/agent/fake-adapter'
import { panelFixtures } from './fixtures'
import { createPanelModel, memoryPanelPersistence, type PanelModel } from './model'

const WORKSPACE = '/workspaces/crucible'

const exhibits = panelFixtures(process.cwd())

let panel: PanelModel
let adapter: ReturnType<typeof createFakeAdapter>
let events: AdapterEvent[]

async function bind(sessionId = 's1'): Promise<void> {
  await adapter.bind({ sessionId, workspacePath: WORKSPACE })
}

const types = (): string[] => events.map((event) => event.type)

const calls = (): Array<{ name: string; summary: string; ok: boolean; output: string }> =>
  events
    .filter((event) => event.type === 'tool_ended')
    .map((ended) => {
      const started = events.find(
        (event) => event.type === 'tool_started' && event.callId === ended.callId
      )
      return {
        name: started?.type === 'tool_started' ? started.name : '',
        summary: started?.type === 'tool_started' ? started.summary : '',
        ok: ended.ok,
        output: ended.output
      }
    })

beforeEach(async () => {
  panel = createPanelModel({ persistence: memoryPanelPersistence() })
  adapter = createFakeAdapter({ pauseMs: 0, panel: { tools: panel, exhibits } })
  events = []
  adapter.onEvent((event) => events.push(event))
  await bind()
})

describe('the fixture exhibits', () => {
  it('are in the repository, one markdown and one page whose script computes', () => {
    expect(existsSync(exhibits.buildPlan)).toBe(true)
    expect(existsSync(exhibits.benchmark)).toBe(true)

    const markdown = readFileSync(exhibits.buildPlan, 'utf8')
    expect(markdown).toContain('# Build plan')
    expect(markdown).toContain('| Step |')
    expect(markdown).toContain('```ts')

    const page = readFileSync(exhibits.benchmark, 'utf8')
    expect(page).toContain('<script>')
    expect(page).toContain('document.getElementById')
  })
})

describe('a panel prompt', () => {
  it('shows both fixtures and lists them, in one turn of three calls', async () => {
    await adapter.prompt('s1', 't-1', 'show me the panel')

    expect(types()).toEqual([
      'turn_started',
      'tool_started',
      'tool_ended',
      'tool_started',
      'tool_ended',
      'tool_started',
      'tool_ended',
      'text_delta',
      'turn_ended',
      'usage'
    ])

    expect(calls()).toEqual([
      {
        name: 'panel_show',
        summary: 'build-plan.md · "Build plan"',
        ok: true,
        output: 'Shown in context panel: "Build plan"'
      },
      {
        name: 'panel_show',
        summary: 'benchmark.html · "Benchmark"',
        ok: true,
        // The second show carries the whole list and the curation nudge,
        // because that is what the model answers with once two tabs are open.
        output: [
          'Shown in context panel: "Benchmark"',
          'Open tabs:',
          '  1. build-plan — "Build plan" (shown this turn)',
          '  2. benchmark — "Benchmark" (shown this turn)',
          'Close tabs that are no longer relevant to the current conversation.'
        ].join('\n')
      },
      {
        name: 'panel_list',
        summary: 'open tabs',
        ok: true,
        output: [
          'Open tabs in the context panel:',
          '  1. build-plan — "Build plan" (shown this turn)',
          '  2. benchmark — "Benchmark" (shown this turn)'
        ].join('\n')
      }
    ])
  })

  it('refreshes the same two tabs when it is prompted again', async () => {
    await adapter.prompt('s1', 't-1', 'panel')
    events.length = 0

    await adapter.prompt('s1', 't-2', 'panel please')

    expect(panel.state('s1')?.tabs.map((tab) => tab.id)).toEqual(['build-plan', 'benchmark'])
    expect(calls()[2].output).toContain('  2. benchmark — "Benchmark"')
    expect(calls()[2].output).not.toContain('benchmark-2')
  })

  it('appends every call to the conversation, so a restored transcript has them', async () => {
    await adapter.prompt('s1', 't-1', 'panel')

    const transcript = await adapter.transcript('s1')
    expect(transcript.map((item) => item.kind)).toEqual([
      'user',
      'tool',
      'tool',
      'tool',
      'assistant'
    ])
  })
})

describe('the other two triggers', () => {
  it('closes one tab by id on "tidy the panel"', async () => {
    await adapter.prompt('s1', 't-1', 'panel')
    events.length = 0

    await adapter.prompt('s1', 't-2', 'Tidy the panel, please')

    expect(calls()).toEqual([
      {
        name: 'panel_close',
        summary: 'benchmark',
        ok: true,
        // The turn counter is the shell's to bump, and no shell is driving
        // this adapter, so both shows are still "this turn".
        output:
          'Closed "Benchmark". Open tabs in the context panel:\n  1. build-plan — "Build plan" (shown this turn)'
      }
    ])
    expect(panel.state('s1')?.tabs.map((tab) => tab.id)).toEqual(['build-plan'])
  })

  it('fails that close with the model\u2019s own text when the tab is not open', async () => {
    await adapter.prompt('s1', 't-1', 'tidy the panel')

    expect(calls()).toEqual([
      {
        name: 'panel_close',
        summary: 'benchmark',
        ok: false,
        output: 'No tab with id "benchmark". The context panel is empty.'
      }
    ])
  })

  it('empties the panel on "close the panel", before the plain panel trigger', async () => {
    await adapter.prompt('s1', 't-1', 'panel')
    events.length = 0

    // The word `panel` is in this prompt too: first match wins, in order.
    await adapter.prompt('s1', 't-2', 'now close the panel')

    expect(calls()).toEqual([
      {
        name: 'panel_close',
        summary: 'all',
        ok: true,
        output: 'Closed all tabs. The context panel is empty.'
      }
    ])
    expect(panel.state('s1')).toBeUndefined()
  })
})

describe('a message queued into a panel turn', () => {
  it('is delivered before the turn ends, like any other turn', async () => {
    // Queued at the boundary between two calls, which is where a steering
    // message lands.
    const turn = adapter.prompt('s1', 't-1', 'panel')
    await Promise.resolve()
    await adapter.steer('s1', 'and close the second one after')
    await turn

    expect(
      events.some(
        (event) =>
          event.type === 'user_message' && event.text === 'and close the second one after'
      )
    ).toBe(true)
    expect(types().at(-2)).toBe('turn_ended')
  })
})

describe('a panel turn that is stopped', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('ends as cancelled at the beat the stop landed on, with no call after it', async () => {
    vi.useFakeTimers()
    const paced = createFakeAdapter({ pauseMs: 10, panel: { tools: panel, exhibits } })
    const said: AdapterEvent[] = []
    paced.onEvent((event) => said.push(event))
    await paced.bind({ sessionId: 's3', workspacePath: WORKSPACE })

    const turn = paced.prompt('s3', 't-1', 'panel')
    // Far enough in for the first show to have happened, nowhere near the end.
    await vi.advanceTimersByTimeAsync(25)
    await paced.cancel('s3')
    await vi.advanceTimersByTimeAsync(1_000)
    await turn

    expect(said.map((event) => event.type)).toContain('turn_cancelled')
    expect(said.filter((event) => event.type === 'tool_ended')).toHaveLength(1)
    expect(panel.state('s3')?.tabs.map((tab) => tab.id)).toEqual(['build-plan'])
  })
})

describe('everything else', () => {
  it('runs the standard script for a prompt that names no panel', async () => {
    await adapter.prompt('s1', 't-1', 'write the adapter')

    expect(types()).toContain('thinking_delta')
    expect(calls().map((call) => call.name)).toEqual(['bash', 'read', 'read', 'bash'])
  })

  it('runs the standard script for the word panel when no panel was injected', async () => {
    const plain = createFakeAdapter({ pauseMs: 0 })
    const said: AdapterEvent[] = []
    plain.onEvent((event) => said.push(event))
    await plain.bind({ sessionId: 's2', workspacePath: WORKSPACE })

    await plain.prompt('s2', 't-1', 'panel')

    expect(said.map((event) => event.type)).toContain('thinking_delta')
  })

  it('keeps two sessions\u2019 panels apart', async () => {
    await bind('s2')
    await adapter.prompt('s1', 't-1', 'panel')

    await adapter.prompt('s2', 't-2', 'tidy the panel')

    // s1's tabs are s1's: the close in s2 found nothing to close.
    expect(panel.state('s1')?.tabs).toHaveLength(2)
    expect(panel.state('s2')).toBeUndefined()
  })
})
