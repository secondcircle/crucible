import type {
  SessionId,
  SessionState,
  ShellSnapshot,
  WorkspaceId,
  WorkspaceState
} from '../../../shared/agent/port'
import { latestNodeActivity, type RunRecord } from '../../../shared/workflows/run'
import type { RunActivity } from '../runs/activity'
import { runIsWorking } from '../runs/bands'
import type { Marks } from '../state/needs-you'

const RECENT_MS = 24 * 3_600_000

export type WorkspaceUse =
  // Something in it is working right now, so its use is the present moment
  // whenever the question is asked. Never a timestamp: a stamp taken at the
  // last render would age while the work goes on.
  | { readonly kind: 'now' }
  | { readonly kind: 'at'; readonly at: number }
  | { readonly kind: 'never' }

export interface OrderedWorkspaces {
  readonly recent: readonly WorkspaceState[]
  readonly older: readonly WorkspaceState[]
}

// What deciding "used" is allowed to read. There is no active workspace and no
// active session in here, and that is the point: looking cannot become use in
// any code path, because no code path in this function can see it.
export interface ActivityFacts {
  readonly workspaces: readonly WorkspaceState[]
  readonly sessions: readonly SessionState[]
  readonly runs: readonly RunRecord[]
}

/** Each workspace's last use. Total: every input workspace gets one entry. */
export function workspaceUse(facts: ActivityFacts): ReadonlyMap<WorkspaceId, WorkspaceUse> {
  const use = new Map<WorkspaceId, WorkspaceUse>(
    facts.workspaces.map((workspace) => [workspace.id, { kind: 'never' } as WorkspaceUse])
  )

  function contribute(id: WorkspaceId, contribution: WorkspaceUse): void {
    const held = use.get(id)
    if (held === undefined) return
    use.set(id, later(held, contribution))
  }

  for (const workspace of facts.workspaces) {
    contribute(workspace.id, instant(workspace.lastUsedAt))
  }
  const workspaceOf = new Map<SessionId, WorkspaceId>(
    facts.sessions.map((session) => [session.id, session.workspaceId])
  )
  for (const session of facts.sessions) {
    if (session.working) contribute(session.workspaceId, { kind: 'now' })
  }
  for (const run of facts.runs) {
    const sessionId = run.sessionId
    if (sessionId === undefined) continue
    const workspaceId = workspaceOf.get(sessionId)
    if (workspaceId === undefined) continue
    // A working run is use now; any other run is use at the last moment it was
    // seen working. A paused run's clock is stopped, so it holds a workspace
    // where it was rather than carrying it along.
    if (runIsWorking(run)) {
      contribute(workspaceId, { kind: 'now' })
      continue
    }
    contribute(workspaceId, instant(run.endedAt ?? latestNodeActivity(run) ?? run.startedAt))
  }
  return use
}

/**
 * The two bands. `now` is epoch ms and is the only clock in the rule: the
 * 24-hour window is measured back from it and from nothing calendar-shaped.
 */
export function orderWorkspaces(
  workspaces: readonly WorkspaceState[],
  use: ReadonlyMap<WorkspaceId, WorkspaceUse>,
  now: number
): OrderedWorkspaces {
  // The input index is every comparator's last word, so the order is total and
  // two renders of the same data cannot differ.
  const index = new Map<WorkspaceId, number>(
    workspaces.map((workspace, at) => [workspace.id, at])
  )
  const at = (workspace: WorkspaceState): number => index.get(workspace.id) ?? 0
  const of = (workspace: WorkspaceState): WorkspaceUse =>
    use.get(workspace.id) ?? { kind: 'never' }

  const recent: WorkspaceState[] = []
  const used: WorkspaceState[] = []
  const never: WorkspaceState[] = []
  for (const workspace of workspaces) {
    const held = of(workspace)
    // Working outranks the arithmetic: a workspace whose work is going on now
    // is in the recent band whatever any stamp says.
    if (held.kind === 'now' || (held.kind === 'at' && now - held.at < RECENT_MS)) {
      recent.push(workspace)
    } else if (held.kind === 'at') {
      used.push(workspace)
    } else {
      never.push(workspace)
    }
  }

  recent.sort(
    (left, right) => left.name.localeCompare(right.name) || at(left) - at(right)
  )
  used.sort((left, right) => stampOf(of(right)) - stampOf(of(left)) || at(left) - at(right))
  never.sort((left, right) => at(left) - at(right))

  return { recent, older: [...used, ...never] }
}

export function rows(ordered: OrderedWorkspaces): readonly WorkspaceState[] {
  return [...ordered.recent, ...ordered.older]
}

export function hairline(ordered: OrderedWorkspaces): boolean {
  return ordered.recent.length > 0 && ordered.older.length > 0
}

/**
 * Workspaces with something working in them: the condition that lights the
 * row's green dot, spelled once so the dot and Collapse idle cannot drift.
 * Live runs count, paused ones included, exactly as `runActivity` counts them.
 */
export function workingWorkspaces(
  sessions: readonly SessionState[],
  runActivity: Readonly<Record<SessionId, RunActivity>>
): ReadonlySet<WorkspaceId> {
  const working = new Set<WorkspaceId>()
  for (const session of sessions) {
    if (session.working || runActivity[session.id] !== undefined) {
      working.add(session.workspaceId)
    }
  }
  return working
}

/** What Collapse idle spares. Nothing else keeps a workspace open. */
export function inUseWorkspaces(facts: {
  readonly sessions: readonly SessionState[]
  /** From `workingWorkspaces`: the dot's own condition. */
  readonly working: ReadonlySet<WorkspaceId>
  readonly needsYou: Marks
  readonly activeWorkspaceId?: WorkspaceId
}): ReadonlySet<WorkspaceId> {
  const inUse = new Set<WorkspaceId>(facts.working)
  for (const session of facts.sessions) {
    if (facts.needsYou.has(session.id)) inUse.add(session.workspaceId)
  }
  if (facts.activeWorkspaceId !== undefined) inUse.add(facts.activeWorkspaceId)
  return inUse
}

/**
 * Every workspace Collapse idle would fold: unfolded, and not in use. Empty is
 * exactly the condition that disables the control.
 */
export function idleWorkspaces(
  workspaces: readonly WorkspaceState[],
  folded: ReadonlySet<WorkspaceId>,
  inUse: ReadonlySet<WorkspaceId>
): readonly WorkspaceId[] {
  return workspaces
    .filter((workspace) => !folded.has(workspace.id) && !inUse.has(workspace.id))
    .map((workspace) => workspace.id)
}

export interface SidebarFacts {
  readonly snapshot: ShellSnapshot
  readonly runs: readonly RunRecord[]
  readonly runActivity: Readonly<Record<SessionId, RunActivity>>
  readonly needsYou: Marks
  readonly now: number
}

export interface SidebarModel {
  readonly ordered: OrderedWorkspaces
  readonly working: ReadonlySet<WorkspaceId>
  readonly inUse: ReadonlySet<WorkspaceId>
}

/** One call, one answer, so the Shell wires four rules and learns one shape. */
export function sidebarModel(facts: SidebarFacts): SidebarModel {
  const { snapshot } = facts
  const use = workspaceUse({
    workspaces: snapshot.workspaces,
    sessions: snapshot.sessions,
    runs: facts.runs
  })
  const working = workingWorkspaces(snapshot.sessions, facts.runActivity)
  return {
    ordered: orderWorkspaces(snapshot.workspaces, use, facts.now),
    working,
    inUse: inUseWorkspaces({
      sessions: snapshot.sessions,
      working,
      needsYou: facts.needsYou,
      ...(snapshot.activeWorkspaceId === undefined
        ? {}
        : { activeWorkspaceId: snapshot.activeWorkspaceId })
    })
  }
}

/** An ISO that will not parse contributes nothing rather than a guess. */
function instant(iso: string | undefined): WorkspaceUse {
  if (iso === undefined) return { kind: 'never' }
  const at = Date.parse(iso)
  return Number.isNaN(at) ? { kind: 'never' } : { kind: 'at', at }
}

function later(held: WorkspaceUse, contribution: WorkspaceUse): WorkspaceUse {
  if (held.kind === 'now' || contribution.kind === 'now') return { kind: 'now' }
  if (contribution.kind === 'never') return held
  if (held.kind === 'never') return contribution
  return contribution.at > held.at ? contribution : held
}

/** Only the lower band sorts by instant, where every entry is an `at`. */
function stampOf(use: WorkspaceUse): number {
  return use.kind === 'at' ? use.at : 0
}
