import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import {
  monitorTool,
  type BoundMonitorTools,
  type MonitorRequest
} from '../../shared/agent/monitor-tools'
import { monitorPiTools, parametersSchema } from './monitor-pi-tools'

// The one builder both the SDK adapter and the node session factory use, so a
// session agent and a run's node cannot be handed different tools. No SDK
// session is constructed here: a tool definition is a plain object.

function boundSpy(): BoundMonitorTools & { readonly calls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    calls,
    async set(request: MonitorRequest) {
      calls.push(['set', request])
      return 'monitor set'
    },
    async list() {
      calls.push(['list'])
      return 'nothing yet'
    },
    async stop(monitorId: string) {
      calls.push(['stop', monitorId])
      return 'stopped'
    }
  }
}

// π hands a tool five arguments; Crucible's read the first two and nothing
// else, which is the whole of what these definitions promise.
const call = (tool: ToolDefinition, params: unknown): Promise<unknown> =>
  tool.execute('c1', params as never, undefined, undefined, undefined as never)

const textOf = (result: unknown): string =>
  (result as { content: { text: string }[] }).content[0].text

describe('the monitor tools as \u03c0 sees them', () => {
  it('is the three definitions, descriptions and all', () => {
    const tools = monitorPiTools(boundSpy())
    expect(tools.map((tool) => tool.name)).toEqual([
      'crucible_monitor',
      'crucible_monitors',
      'crucible_monitor_stop'
    ])
    expect(tools[0].description).toBe(monitorTool('crucible_monitor').description)
  })

  it('declares required strings and optional numbers', () => {
    expect(parametersSchema(monitorTool('crucible_monitor').parameters)).toMatchObject({
      type: 'object',
      required: ['description', 'reason', 'command'],
      properties: {
        description: { type: 'string' },
        intervalSeconds: { type: 'number' },
        timeoutSeconds: { type: 'number' }
      }
    })
  })

  it('sets a monitor through the bound behaviors and answers with their text', async () => {
    const bound = boundSpy()
    const [set] = monitorPiTools(bound)
    const answer = await call(set, {
      description: 'CI on PR #482 to finish',
      reason: 'so I can read the log',
      command: 'gh pr checks 482',
      intervalSeconds: 45
    })

    expect(textOf(answer)).toBe('monitor set')
    expect(bound.calls[0]).toEqual([
      'set',
      {
        description: 'CI on PR #482 to finish',
        reason: 'so I can read the log',
        command: 'gh pr checks 482',
        intervalSeconds: 45
      }
    ])
  })

  it('fails the call in the model\u2019s face when a field is missing, setting nothing', async () => {
    const bound = boundSpy()
    const [set] = monitorPiTools(bound)
    await expect(call(set, { description: 'x', command: 'c' })).rejects.toThrow(/reason/)
    expect(bound.calls).toEqual([])
  })

  it('stops by the id it was given, trimmed', async () => {
    const bound = boundSpy()
    const stop = monitorPiTools(bound)[2]
    await call(stop, { monitorId: ' m-1f3a ' })
    expect(bound.calls[0]).toEqual(['stop', 'm-1f3a'])
  })

  it('lists with no arguments at all', async () => {
    const bound = boundSpy()
    const list = monitorPiTools(bound)[1]
    expect(textOf(await call(list, undefined))).toBe('nothing yet')
    expect(bound.calls[0]).toEqual(['list'])
  })
})
