// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type {
  SessionState,
  ShellSnapshot,
  WorkspaceId,
  WorkspaceState
} from '../../../shared/agent/port'
import type { RunNode, RunRecord } from '../../../shared/workflows/run'
import type { RunActivity } from '../runs/activity'
import {
  hairline,
  idleWorkspaces,
  inUseWorkspaces,
  orderWorkspaces,
  rows,
  sidebarModel,
  workingWorkspaces,
  workspaceUse,
  type WorkspaceUse
} from './model'

const NOW = Date.parse('2026-09-08T12:00:00.000Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR

function iso(at: number): string {
  return new Date(at).toISOString()
}

function workspace(id: string, name: string, lastUsedAt?: string): WorkspaceState {
  return { id, name, path: `/repos/${name}`, ...(lastUsedAt === undefined ? {} : { lastUsedAt }) }
}

function session(
  id: string,
  workspaceId: string,
  overrides: Partial<SessionState> = {}
): SessionState {
  return {
    id,
    workspaceId,
    createdAt: iso(NOW - 3 * DAY),
    working: false,
    fresh: false,
    ...overrides
  }
}

function runOf(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'en42',
    workflow: 'build',
    status: 'running',
    workspacePath: '/repos/crucible',
    workspaceName: 'crucible',
    sessionId: 's1',
    inputs: {},
    nodes: [],
    createdAt: iso(NOW - 2 * HOUR),
    startedAt: iso(NOW - 2 * HOUR),
    ...overrides
  }
}

function node(overrides: Partial<RunNode> = {}): RunNode {
  return { id: 'build', status: 'paused', parents: [], reads: [], artifacts: [], ...overrides }
}

function lastUse(
  workspaces: readonly WorkspaceState[],
  sessions: readonly SessionState[] = [],
  runs: readonly RunRecord[] = []
): ReadonlyMap<WorkspaceId, WorkspaceUse> {
  return workspaceUse({ workspaces, sessions, runs })
}

function named(ordered: { readonly recent: readonly WorkspaceState[] }): string[] {
  return ordered.recent.map((workspace) => workspace.name)
}

function order(
  workspaces: readonly WorkspaceState[],
  sessions: readonly SessionState[] = [],
  runs: readonly RunRecord[] = [],
  now = NOW
): string[] {
  return rows(orderWorkspaces(workspaces, lastUse(workspaces, sessions, runs), now)).map(
    (workspace) => workspace.name
  )
}

describe('what counts as use', () => {
  it('gives every workspace an entry, so a missing one is never a second never', () => {
    const use = lastUse([workspace('w1', 'crucible', iso(NOW - HOUR)), workspace('w2', 'camping')])

    expect([...use.keys()]).toEqual(['w1', 'w2'])
    expect(use.get('w2')).toEqual({ kind: 'never' })
  })

  it('reads the workspace stamp the shell recorded', () => {
    const use = lastUse([workspace('w1', 'crucible', iso(NOW - HOUR))])

    expect(use.get('w1')).toEqual({ kind: 'at', at: NOW - HOUR })
  })

  it('is now while a turn works, whatever the stamp says', () => {
    const use = lastUse(
      [workspace('w1', 'crucible', iso(NOW - 9 * DAY))],
      [session('s1', 'w1', { working: true })]
    )

    expect(use.get('w1')).toEqual({ kind: 'now' })
  })

  it('is now while a run works in one of its sessions', () => {
    const use = lastUse(
      [workspace('w1', 'crucible')],
      [session('s1', 'w1')],
      [runOf({ status: 'running' })]
    )

    expect(use.get('w1')).toEqual({ kind: 'now' })
  })

  it('is the moment a paused run stopped, not the present one', () => {
    const use = lastUse(
      [workspace('w1', 'crucible')],
      [session('s1', 'w1')],
      [runOf({ status: 'paused', nodes: [node({ lastActivityAt: iso(NOW - 30 * HOUR) })] })]
    )

    expect(use.get('w1')).toEqual({ kind: 'at', at: NOW - 30 * HOUR })
  })

  it('falls back to a settled run\u2019s ending, then to its start', () => {
    const ended = lastUse(
      [workspace('w1', 'crucible')],
      [session('s1', 'w1')],
      [
        runOf({
          status: 'complete',
          endedAt: iso(NOW - 5 * HOUR),
          nodes: [node({ lastActivityAt: iso(NOW - 40 * HOUR) })]
        })
      ]
    )
    const bare = lastUse(
      [workspace('w1', 'crucible')],
      [session('s1', 'w1')],
      [runOf({ status: 'cancelled', startedAt: iso(NOW - 6 * HOUR) })]
    )

    expect(ended.get('w1')).toEqual({ kind: 'at', at: NOW - 5 * HOUR })
    expect(bare.get('w1')).toEqual({ kind: 'at', at: NOW - 6 * HOUR })
  })

  it('ignores a run with no session of this workspace', () => {
    const unattended = lastUse(
      [workspace('w1', 'crucible')],
      [session('s1', 'w1')],
      [runOf({ sessionId: undefined })]
    )
    const elsewhere = lastUse(
      [workspace('w1', 'crucible'), workspace('w2', 'camping')],
      [session('s1', 'w1'), session('s9', 'w2')],
      [runOf({ sessionId: 's9', status: 'running' })]
    )

    expect(unattended.get('w1')).toEqual({ kind: 'never' })
    expect(elsewhere.get('w1')).toEqual({ kind: 'never' })
  })

  it('takes the latest of everything that contributed', () => {
    const use = lastUse(
      [workspace('w1', 'crucible', iso(NOW - 3 * DAY))],
      [session('s1', 'w1')],
      [runOf({ status: 'failed', endedAt: iso(NOW - 2 * HOUR) })]
    )

    expect(use.get('w1')).toEqual({ kind: 'at', at: NOW - 2 * HOUR })
  })

  it('drops a stamp that will not parse rather than guessing at one', () => {
    const use = lastUse([workspace('w1', 'crucible', 'the day before yesterday')])

    expect(use.get('w1')).toEqual({ kind: 'never' })
  })

  it('leaves a workspace whose sessions never carried a message never used', () => {
    const use = lastUse([workspace('w1', 'crucible')], [session('s1', 'w1'), session('s2', 'w1')])

    expect(use.get('w1')).toEqual({ kind: 'never' })
  })
})

describe('the two bands', () => {
  it('puts everything used inside 24 hours on top, alphabetically', () => {
    const workspaces = [
      workspace('w1', 'redball', iso(NOW - 3 * HOUR)),
      workspace('w2', 'crucible', iso(NOW - 20 * HOUR)),
      workspace('w3', 'baypool', iso(NOW - HOUR))
    ]

    expect(order(workspaces)).toEqual(['baypool', 'crucible', 'redball'])
  })

  it('sorts the recent band ignoring case', () => {
    const workspaces = [
      workspace('w1', 'Zed', iso(NOW - HOUR)),
      workspace('w2', 'apple', iso(NOW - 2 * HOUR))
    ]

    expect(order(workspaces)).toEqual(['apple', 'Zed'])
  })

  it('holds two workspaces of the same name in a fixed relative order', () => {
    const workspaces = [
      workspace('w1', 'crucible', iso(NOW - HOUR)),
      workspace('w2', 'crucible', iso(NOW - 2 * HOUR))
    ]
    const first = orderWorkspaces(workspaces, lastUse(workspaces), NOW)
    const again = orderWorkspaces(workspaces, lastUse(workspaces), NOW)

    expect(first.recent.map((found) => found.id)).toEqual(['w1', 'w2'])
    expect(again.recent.map((found) => found.id)).toEqual(['w1', 'w2'])
  })

  it('puts everything older below, most recently used first', () => {
    const workspaces = [
      workspace('w1', 'camping', iso(NOW - 10 * DAY)),
      workspace('w2', 'financial', iso(NOW - 7 * DAY)),
      workspace('w3', 'mom-issues', iso(NOW - 5 * DAY))
    ]

    expect(order(workspaces)).toEqual(['mom-issues', 'financial', 'camping'])
  })

  it('puts never-used workspaces at the very bottom, in the order they were added', () => {
    const workspaces = [
      workspace('w1', 'train-4-tomorrow'),
      workspace('w2', 'camping', iso(NOW - 10 * DAY)),
      workspace('w3', 'rite'),
      workspace('w4', 'crucible', iso(NOW - HOUR))
    ]

    expect(order(workspaces)).toEqual(['crucible', 'camping', 'train-4-tomorrow', 'rite'])
  })

  it('measures the window from the moment it is asked about, not from a calendar', () => {
    const workspaces = [workspace('w1', 'crucible', iso(NOW - 23 * HOUR))]
    const use = lastUse(workspaces)

    expect(named(orderWorkspaces(workspaces, use, NOW))).toEqual(['crucible'])
    expect(named(orderWorkspaces(workspaces, use, NOW + 2 * HOUR))).toEqual([])
    expect(named(orderWorkspaces(workspaces, use, NOW - 20 * HOUR))).toEqual(['crucible'])
  })

  it('keeps a workspace with work going on in the recent band whatever its stamp', () => {
    const workspaces = [
      workspace('w1', 'crucible', iso(NOW - 9 * DAY)),
      workspace('w2', 'camping', iso(NOW - 2 * DAY))
    ]
    const working = [session('s1', 'w1', { working: true })]

    expect(order(workspaces, working)).toEqual(['crucible', 'camping'])
  })

  it('crosses one workspace out of the recent band and to the head of the lower one', () => {
    const workspaces = [
      workspace('w1', 'crucible', iso(NOW - 23 * HOUR)),
      workspace('w2', 'camping', iso(NOW - 3 * DAY)),
      workspace('w3', 'baypool', iso(NOW - HOUR))
    ]
    const before = orderWorkspaces(workspaces, lastUse(workspaces), NOW)
    const after = orderWorkspaces(workspaces, lastUse(workspaces), NOW + 2 * HOUR)
    const later = orderWorkspaces(workspaces, lastUse(workspaces), NOW + 5 * HOUR)

    expect(named(before)).toEqual(['baypool', 'crucible'])
    expect(named(after)).toEqual(['baypool'])
    expect(after.older.map((found) => found.name)).toEqual(['crucible', 'camping'])
    expect(rows(later).map((found) => found.name)).toEqual(rows(after).map((found) => found.name))
  })

  it('draws the hairline only when both bands hold something', () => {
    const both = [
      workspace('w1', 'crucible', iso(NOW - HOUR)),
      workspace('w2', 'camping', iso(NOW - 3 * DAY))
    ]
    const recentOnly = [workspace('w1', 'crucible', iso(NOW - HOUR))]
    const olderOnly = [workspace('w2', 'camping')]

    expect(hairline(orderWorkspaces(both, lastUse(both), NOW))).toBe(true)
    expect(hairline(orderWorkspaces(recentOnly, lastUse(recentOnly), NOW))).toBe(false)
    expect(hairline(orderWorkspaces(olderOnly, lastUse(olderOnly), NOW))).toBe(false)
    expect(hairline(orderWorkspaces([], new Map(), NOW))).toBe(false)
  })

  it('renders the same order twice from the same data', () => {
    const workspaces = [
      workspace('w1', 'crucible', iso(NOW - HOUR)),
      workspace('w2', 'camping'),
      workspace('w3', 'redball', iso(NOW - 3 * DAY)),
      workspace('w4', 'baypool', iso(NOW - 3 * DAY))
    ]
    const use = lastUse(workspaces)

    expect(orderWorkspaces(workspaces, use, NOW)).toEqual(orderWorkspaces(workspaces, use, NOW))
  })

  it('treats a workspace the map never heard of as never used rather than throwing', () => {
    const workspaces = [
      workspace('w1', 'crucible', iso(NOW - HOUR)),
      workspace('w2', 'camping', iso(NOW - HOUR))
    ]

    expect(rows(orderWorkspaces(workspaces, new Map(), NOW)).map((found) => found.name)).toEqual([
      'crucible',
      'camping'
    ])
  })

  it('leaves the rest in place when a workspace is removed', () => {
    const workspaces = [
      workspace('w1', 'crucible', iso(NOW - HOUR)),
      workspace('w2', 'camping', iso(NOW - 3 * DAY)),
      workspace('w3', 'redball', iso(NOW - 2 * DAY))
    ]
    const without = workspaces.filter((found) => found.id !== 'w3')

    expect(order(workspaces)).toEqual(['crucible', 'redball', 'camping'])
    expect(order(without)).toEqual(['crucible', 'camping'])
  })
})

describe('what the order does not depend on', () => {
  const workspaces = [
    workspace('w1', 'redball', iso(NOW - 2 * HOUR)),
    workspace('w2', 'crucible', iso(NOW - 3 * HOUR)),
    workspace('w3', 'camping', iso(NOW - 4 * DAY))
  ]

  function shown(snapshot: Partial<ShellSnapshot>, runs: readonly RunRecord[] = []): string[] {
    const model = sidebarModel({
      snapshot: {
        workspaces,
        sessions: [session('s1', 'w1'), session('s2', 'w2'), session('s3', 'w3')],
        ...snapshot
      },
      runs,
      runActivity: {},
      needsYou: new Set(),
      now: NOW
    })
    return rows(model.ordered).map((found) => found.name)
  }

  const SETTLED = ['crucible', 'redball', 'camping']

  it('does not depend on which workspace or session is active', () => {
    expect(shown({})).toEqual(SETTLED)
    expect(shown({ activeWorkspaceId: 'w3', activeSessionId: 's3' })).toEqual(SETTLED)
  })

  it('does not depend on a session working, or on a title arriving', () => {
    expect(
      shown({
        sessions: [
          session('s1', 'w1'),
          session('s2', 'w2', { working: true, workingSince: iso(NOW - 60_000) }),
          session('s3', 'w3', { title: 'A title the model just wrote' })
        ]
      })
    ).toEqual(SETTLED)
  })

  it('does not depend on how many sessions a workspace holds', () => {
    expect(
      shown({
        sessions: [
          session('s1', 'w1'),
          session('s4', 'w1'),
          session('s5', 'w1'),
          session('s2', 'w2')
        ]
      })
    ).toEqual(SETTLED)
  })

  it('does not depend on a run starting in a workspace already in the band', () => {
    expect(shown({}, [runOf({ sessionId: 's2', status: 'running' })])).toEqual(SETTLED)
  })

  it('does not depend on a session needing you', () => {
    const model = sidebarModel({
      snapshot: {
        workspaces,
        sessions: [session('s1', 'w1'), session('s2', 'w2'), session('s3', 'w3')]
      },
      runs: [],
      runActivity: {},
      needsYou: new Set(['s3']),
      now: NOW
    })

    expect(rows(model.ordered).map((found) => found.name)).toEqual(SETTLED)
  })
})

describe('the green dot', () => {
  const sessions = [session('s1', 'w1'), session('s2', 'w2'), session('s3', 'w3')]
  const live: RunActivity = { since: iso(NOW - HOUR), moving: false }

  it('lights for a working turn and for any live run, paused included', () => {
    const working = workingWorkspaces(
      [session('s1', 'w1', { working: true }), sessions[1]!, sessions[2]!],
      { s2: live }
    )

    expect([...working].sort()).toEqual(['w1', 'w2'])
  })

  it('stays dark where nothing is working', () => {
    expect([...workingWorkspaces(sessions, {})]).toEqual([])
  })
})

describe('what Collapse idle spares', () => {
  const sessions = [session('s1', 'w1'), session('s2', 'w2'), session('s3', 'w3')]

  function inUse(facts: {
    working?: ReadonlySet<WorkspaceId>
    needsYou?: ReadonlySet<string>
    activeWorkspaceId?: WorkspaceId
  }): string[] {
    return [
      ...inUseWorkspaces({
        sessions,
        working: facts.working ?? new Set(),
        needsYou: facts.needsYou ?? new Set(),
        ...(facts.activeWorkspaceId === undefined
          ? {}
          : { activeWorkspaceId: facts.activeWorkspaceId })
      })
    ].sort()
  }

  it('spares whatever the dot lights', () => {
    expect(inUse({ working: new Set(['w2']) })).toEqual(['w2'])
  })

  it('spares a workspace holding a session that needs you', () => {
    expect(inUse({ needsYou: new Set(['s3']) })).toEqual(['w3'])
  })

  it('spares the workspace the user is looking at', () => {
    expect(inUse({ activeWorkspaceId: 'w1' })).toEqual(['w1'])
  })

  it('spares nothing else: a workspace with sessions and no work is idle', () => {
    expect(inUse({})).toEqual([])
  })
})

describe('what Collapse idle would fold', () => {
  const workspaces = [
    workspace('w1', 'crucible'),
    workspace('w2', 'camping'),
    workspace('w3', 'redball')
  ]

  it('is every workspace that is open and not in use, in list order', () => {
    expect(idleWorkspaces(workspaces, new Set(), new Set(['w2']))).toEqual(['w1', 'w3'])
  })

  it('leaves out what is already folded', () => {
    expect(idleWorkspaces(workspaces, new Set(['w1']), new Set(['w2']))).toEqual(['w3'])
  })

  it('is empty when nothing is left to fold, which is what disables the control', () => {
    expect(idleWorkspaces(workspaces, new Set(['w1', 'w3']), new Set(['w2']))).toEqual([])
    expect(idleWorkspaces([], new Set(), new Set())).toEqual([])
  })
})
