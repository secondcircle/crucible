import { describe, expect, it, vi } from 'vitest'
import { BROKE_STRIKES, type MonitorOwner } from '../monitors/monitor'
import {
  bindMonitorTools,
  MONITOR_TOOLS,
  monitorRequestFrom,
  monitorTool,
  type MonitorTools
} from './monitor-tools'

function toolsSpy(): MonitorTools & {
  readonly calls: { op: string; owner: MonitorOwner; args: unknown[] }[]
} {
  const calls: { op: string; owner: MonitorOwner; args: unknown[] }[] = []
  return {
    calls,
    async set(owner, cwd, request) {
      calls.push({ op: 'set', owner, args: [cwd, request] })
      return 'set'
    },
    async list(owner) {
      calls.push({ op: 'list', owner, args: [] })
      return 'listed'
    },
    async stop(owner, monitorId) {
      calls.push({ op: 'stop', owner, args: [monitorId] })
      return 'stopped'
    }
  }
}

describe('what a call to set a monitor must carry', () => {
  it('takes the description, the reason and the command, timing optional', () => {
    expect(
      monitorRequestFrom({
        description: 'CI on PR #482 to finish',
        reason: 'so I can read the failing job',
        command: 'gh pr checks 482'
      })
    ).toEqual({
      description: 'CI on PR #482 to finish',
      reason: 'so I can read the failing job',
      command: 'gh pr checks 482'
    })
  })

  it('fails at the boundary, naming what is missing, when a field is blank', () => {
    for (const missing of ['description', 'reason', 'command']) {
      const params: Record<string, string> = {
        description: 'd',
        reason: 'r',
        command: 'c'
      }
      params[missing] = '   '
      expect(() => monitorRequestFrom(params)).toThrow(new RegExp(missing))
    }
    expect(() => monitorRequestFrom({})).toThrow(/description, reason, command/)
  })

  it('says no monitor was set, so the model knows there is nothing to stop', () => {
    expect(() => monitorRequestFrom({ description: 'd', reason: 'r' })).toThrow(
      /No monitor was set/
    )
  })

  it('takes a numeric string as a number and anything else as no answer', () => {
    expect(
      monitorRequestFrom({
        description: 'd',
        reason: 'r',
        command: 'c',
        intervalSeconds: '45',
        timeoutSeconds: 'soon'
      })
    ).toEqual({ description: 'd', reason: 'r', command: 'c', intervalSeconds: 45 })
  })
})

describe('the guidance the descriptions carry', () => {
  const set = monitorTool('crucible_monitor').description

  it('tells the agent to set the monitor and end the turn', () => {
    expect(set).toMatch(/end your turn/i)
  })

  it('tells it never to poll by hand', () => {
    expect(set).toMatch(/polling by hand/i)
  })

  it('tells it to write the description in the user\u2019s terms', () => {
    expect(set).toMatch(/in the user's terms/i)
    expect(set).toMatch(/not the command's/i)
  })

  it('states the bounds that are actually in force', () => {
    expect(set).toMatch(/30s/)
    expect(set).toMatch(/5s/)
    expect(set).toMatch(/30 minutes/)
    expect(set).toMatch(/24 hours/)
    expect(set).toMatch(/clamped/)
  })

  it('states the threshold at which repeated failure counts as the check breaking', () => {
    expect(set).toContain(`${BROKE_STRIKES} consecutive checks`)
    expect(set).toMatch(/identical error output on stderr/)
    expect(set).toMatch(/dev\/null/)
  })

  it('is three tools, named once, so both flavors mean the same thing', () => {
    expect(MONITOR_TOOLS.map((tool) => tool.name)).toEqual([
      'crucible_monitor',
      'crucible_monitors',
      'crucible_monitor_stop'
    ])
    expect(monitorTool('crucible_monitor').parameters.map((one) => one.name)).toEqual([
      'description',
      'reason',
      'command',
      'intervalSeconds',
      'timeoutSeconds'
    ])
    expect(
      monitorTool('crucible_monitor')
        .parameters.filter((one) => one.optional === true)
        .map((one) => one.name)
    ).toEqual(['intervalSeconds', 'timeoutSeconds'])
    expect(monitorTool('crucible_monitors').parameters).toEqual([])
  })
})

describe('binding the tools to one owner', () => {
  it('fixes the owner and the directory, so no tool takes either as an argument', async () => {
    const tools = toolsSpy()
    const owner: MonitorOwner = { kind: 'session', sessionId: 's1' }
    const bound = bindMonitorTools(tools, owner, '/repos/crucible')

    await bound.set({ description: 'd', reason: 'r', command: 'c' })
    await bound.list()
    await bound.stop('m-1234')

    expect(tools.calls.map((call) => call.op)).toEqual(['set', 'list', 'stop'])
    expect(tools.calls.every((call) => call.owner === owner)).toBe(true)
    expect(tools.calls[0].args[0]).toBe('/repos/crucible')
    expect(Object.keys(bound).sort()).toEqual(['list', 'set', 'stop'])
  })

  it('hands a node its own owner, never a session\u2019s', async () => {
    const tools = toolsSpy()
    const bound = bindMonitorTools(
      tools,
      { kind: 'node', runId: 'en42', nodeId: 'builder' },
      '/worktree'
    )
    await bound.list()
    expect(tools.calls[0].owner).toEqual({ kind: 'node', runId: 'en42', nodeId: 'builder' })
  })

  it('lets a refusal reach the model as the tool\u2019s own failure', async () => {
    const tools = toolsSpy()
    tools.stop = vi.fn(async () => {
      throw new Error('no')
    })
    const bound = bindMonitorTools(tools, { kind: 'session', sessionId: 's1' }, '/repos')
    await expect(bound.stop('m-0000')).rejects.toThrow('no')
  })
})
