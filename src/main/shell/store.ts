import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  ExhibitKind,
  ModelId,
  SessionId,
  SessionWorktree,
  ThinkingLevel,
  WorkspaceId
} from '../../shared/agent/port'
import type { Flavor } from '../agent/select-adapter'
import type { StoredPanel, StoredPanelTab } from '../panel/model'

// One store above both adapters, so the launch flavors can never disagree
// about what the sidebar holds. Its file location is an argument for tests.

/** What lets a later shape be migrated. */
const VERSION = 1

export interface StoredWorkspace {
  readonly id: WorkspaceId
  readonly path: string
  /** ISO; absent on a workspace nothing has ever been used in. */
  readonly lastUsedAt?: string
}

export interface StoredSession {
  readonly id: SessionId
  readonly workspaceId: WorkspaceId
  /** ISO; what the sidebar's relative time falls back to. */
  readonly createdAt: string
  // The model-written session title, kept so a relaunch shows what the sidebar
  // showed rather than titling everything again.
  readonly title?: string
  /** ISO of the last thing that happened in this session. */
  readonly lastActivityAt?: string
  // Dollars this session's titler has spent, cumulative. It rides with the
  // title because it is the cost of having one.
  readonly titlingSpend?: number
  // Lets a later launch rebind this same sidebar identity to the same
  // conversation. Nothing outside the adapter interprets it.
  readonly token?: string
  /** Absent on sessions persisted before tokens were stamped with a flavor. */
  readonly tokenFlavor?: Flavor
  /** The last model and level the adapter reported for this session. */
  readonly model?: ModelId
  readonly thinkingLevel?: ThinkingLevel
  // Present only for a worktree session; absent means the workspace's own
  // checkout. Removing the session leaves the directory exactly where it is.
  readonly worktree?: SessionWorktree
  // The issue this session was started on, as the issue board's reference. It
  // is written once, at creation, and is what makes an issue picked up.
  readonly issue?: string
  // The mark is on sessions that have never received a message, so a record
  // written before this field existed loads locked, which is the safe way
  // round: unlocking one would let a flip abandon a real conversation.
  readonly fresh?: boolean
  // The session's context panel. It lives inside the session record, so
  // removing the session forgets its tabs with it.
  readonly panel?: StoredPanel
}

export interface ShellStoreState {
  readonly workspaces: readonly StoredWorkspace[]
  readonly sessions: readonly StoredSession[]
  readonly activeWorkspaceId?: WorkspaceId
  /** Each workspace remembers the session it was last on. */
  readonly activeSessionByWorkspace: Readonly<Record<WorkspaceId, SessionId>>
  /** What a new session starts on. */
  readonly lastModel?: ModelId
}

const EMPTY: ShellStoreState = {
  workspaces: [],
  sessions: [],
  activeSessionByWorkspace: {}
}

export interface ShellStore {
  readonly state: ShellStoreState
  /** The active workspace's remembered session, when it still exists. */
  activeSessionId(): SessionId | undefined
  workspace(id: WorkspaceId): StoredWorkspace | undefined
  session(id: SessionId): StoredSession | undefined
  // Picking the same folder twice activates what is already there rather than
  // duplicating it. Either way the workspace ends up active.
  addWorkspace(path: string): StoredWorkspace
  removeWorkspace(id: WorkspaceId): void
  activateWorkspace(id: WorkspaceId): void
  addSession(session: Omit<StoredSession, 'id'>): StoredSession
  updateSession(id: SessionId, patch: Partial<Omit<StoredSession, 'id' | 'workspaceId'>>): void
  removeSession(id: SessionId): void
  activateSession(id: SessionId): void
  // Records that something was used in this workspace, now. Monotonic: a stamp
  // never moves backwards, so a clock that steps back cannot move a workspace
  // up the sidebar. The only writer of `lastUsedAt`.
  recordUse(id: WorkspaceId): void
  setLastModel(model: ModelId): void
}

export type StoreWriteFailure = (cause: unknown) => void

export function createShellStore(
  path: string,
  onWriteFailure: StoreWriteFailure = () => {}
): ShellStore {
  let state = load(path)

  function save(next: ShellStoreState): void {
    state = next
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify({ version: VERSION, ...next }, null, 2)}\n`, 'utf8')
    } catch (cause) {
      // A store that cannot write is still a store: the launch keeps working
      // from memory rather than throwing at whoever clicked.
      onWriteFailure(cause)
    }
  }

  function activation(next: ShellStoreState, workspaceId: WorkspaceId): ShellStoreState {
    return { ...next, activeWorkspaceId: workspaceId }
  }

  return {
    get state() {
      return state
    },

    activeSessionId(): SessionId | undefined {
      const workspaceId = state.activeWorkspaceId
      if (workspaceId === undefined) return undefined
      const remembered = state.activeSessionByWorkspace[workspaceId]
      return state.sessions.some((session) => session.id === remembered) ? remembered : undefined
    },

    workspace(id: WorkspaceId): StoredWorkspace | undefined {
      return state.workspaces.find((workspace) => workspace.id === id)
    },

    session(id: SessionId): StoredSession | undefined {
      return state.sessions.find((session) => session.id === id)
    },

    addWorkspace(path: string): StoredWorkspace {
      const existing = state.workspaces.find((workspace) => workspace.path === path)
      if (existing !== undefined) {
        save(activation(state, existing.id))
        return existing
      }
      const workspace: StoredWorkspace = { id: randomUUID(), path }
      save(activation({ ...state, workspaces: [...state.workspaces, workspace] }, workspace.id))
      return workspace
    },

    removeWorkspace(id: WorkspaceId): void {
      const workspaces = state.workspaces.filter((workspace) => workspace.id !== id)
      const sessions = state.sessions.filter((session) => session.workspaceId !== id)
      const activeSessionByWorkspace = { ...state.activeSessionByWorkspace }
      delete activeSessionByWorkspace[id]
      save({
        ...state,
        workspaces,
        sessions,
        activeSessionByWorkspace,
        activeWorkspaceId:
          state.activeWorkspaceId === id ? workspaces[0]?.id : state.activeWorkspaceId
      })
    },

    activateWorkspace(id: WorkspaceId): void {
      if (!state.workspaces.some((workspace) => workspace.id === id)) return
      save(activation(state, id))
    },

    addSession(session: Omit<StoredSession, 'id'>): StoredSession {
      const stored: StoredSession = { id: randomUUID(), ...session }
      save({
        ...state,
        sessions: [...state.sessions, stored],
        activeWorkspaceId: stored.workspaceId,
        activeSessionByWorkspace: {
          ...state.activeSessionByWorkspace,
          [stored.workspaceId]: stored.id
        }
      })
      return stored
    },

    updateSession(id, patch): void {
      save({
        ...state,
        sessions: state.sessions.map((session) =>
          session.id === id ? pruned({ ...session, ...patch }) : session
        )
      })
    },

    removeSession(id: SessionId): void {
      const removed = state.sessions.find((session) => session.id === id)
      const sessions = state.sessions.filter((session) => session.id !== id)
      const activeSessionByWorkspace = { ...state.activeSessionByWorkspace }
      if (removed !== undefined && activeSessionByWorkspace[removed.workspaceId] === id) {
        const next = sessions.find((session) => session.workspaceId === removed.workspaceId)
        if (next === undefined) delete activeSessionByWorkspace[removed.workspaceId]
        else activeSessionByWorkspace[removed.workspaceId] = next.id
      }
      save({ ...state, sessions, activeSessionByWorkspace })
    },

    activateSession(id: SessionId): void {
      const session = state.sessions.find((candidate) => candidate.id === id)
      if (session === undefined) return
      save({
        ...state,
        activeWorkspaceId: session.workspaceId,
        activeSessionByWorkspace: {
          ...state.activeSessionByWorkspace,
          [session.workspaceId]: session.id
        }
      })
    },

    recordUse(id: WorkspaceId): void {
      const workspace = state.workspaces.find((candidate) => candidate.id === id)
      if (workspace === undefined) return
      const at = new Date().toISOString()
      const held = workspace.lastUsedAt
      if (held !== undefined && Date.parse(held) >= Date.parse(at)) return
      save({
        ...state,
        workspaces: state.workspaces.map((candidate) =>
          candidate.id === id ? { ...candidate, lastUsedAt: at } : candidate
        )
      })
    },

    setLastModel(model: ModelId): void {
      save({ ...state, lastModel: model })
    }
  }
}

// An unreadable or unknown-version file is treated as absent: losing a sidebar
// is recoverable, a window that will not open is not.
function load(path: string): ShellStoreState {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return EMPTY
  }
  if (typeof parsed !== 'object' || parsed === null) return EMPTY

  const file = parsed as Record<string, unknown>
  if (file.version !== VERSION) return EMPTY

  const found = asArray<StoredWorkspace>(file.workspaces).filter(
    (workspace) => typeof workspace?.id === 'string' && typeof workspace?.path === 'string'
  )
  const sessions = asArray<StoredSession>(file.sessions)
    .filter(
      (session) =>
        typeof session?.id === 'string' &&
        typeof session?.workspaceId === 'string' &&
        typeof session?.createdAt === 'string' &&
        found.some((workspace) => workspace.id === session.workspaceId)
    )
    // Unreadable panel data, or a flavor this build cannot vouch for, loads as
    // absent: a lost tab is recoverable, a launch that will not start is not.
    .map((session) => {
      const panel = readPanel((session as { panel?: unknown }).panel)
      const tokenFlavor = readTokenFlavor(session)
      // All three title fields are optional, so a store written before titles
      // existed loads unchanged and simply has none.
      const title = typeof session.title === 'string' ? session.title : undefined
      const lastActivityAt =
        typeof session.lastActivityAt === 'string' ? session.lastActivityAt : undefined
      const titlingSpend =
        typeof session.titlingSpend === 'number' && Number.isFinite(session.titlingSpend)
          ? session.titlingSpend
          : undefined
      const worktree = readWorktree((session as { worktree?: unknown }).worktree)
      const rest = { ...session }
      delete rest.panel
      delete rest.tokenFlavor
      delete rest.title
      delete rest.lastActivityAt
      delete rest.titlingSpend
      delete rest.worktree
      delete rest.fresh
      return {
        ...rest,
        ...(panel === undefined ? {} : { panel }),
        ...(tokenFlavor === undefined ? {} : { tokenFlavor }),
        ...(title === undefined ? {} : { title }),
        ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
        ...(titlingSpend === undefined ? {} : { titlingSpend }),
        ...(worktree === undefined ? {} : { worktree }),
        // Anything but the mark itself is a session past its first message.
        ...((session as { fresh?: unknown }).fresh === true ? { fresh: true } : {})
      }
    })
  // `lastUsedAt` is a field an older record simply lacks, so the version is not
  // bumped over it — an unknown version discards the whole file. Seeded once
  // from the sessions already on disk, by the same rule the field holds, so the
  // first launch after the update does not show every workspace as never used.
  const workspaces: StoredWorkspace[] = found.map((workspace) => {
    const stored =
      typeof workspace.lastUsedAt === 'string' ? workspace.lastUsedAt : undefined
    const lastUsedAt = stored ?? seededUse(workspace.id, sessions)
    return {
      id: workspace.id,
      path: workspace.path,
      ...(lastUsedAt === undefined ? {} : { lastUsedAt })
    }
  })
  const activeSessionByWorkspace =
    typeof file.activeSessionByWorkspace === 'object' && file.activeSessionByWorkspace !== null
      ? (file.activeSessionByWorkspace as Record<WorkspaceId, SessionId>)
      : {}

  return {
    workspaces,
    sessions,
    activeSessionByWorkspace,
    activeWorkspaceId: workspaces.some((workspace) => workspace.id === file.activeWorkspaceId)
      ? (file.activeWorkspaceId as WorkspaceId)
      : workspaces[0]?.id,
    lastModel: typeof file.lastModel === 'string' ? file.lastModel : undefined
  }
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

// The latest activity among a workspace's stored sessions, which is the most a
// record written before workspaces carried their own stamp can say. A workspace
// whose sessions were created and never messaged has nothing to seed from and
// stays never used.
function seededUse(
  id: WorkspaceId,
  sessions: readonly StoredSession[]
): string | undefined {
  let latest: string | undefined
  for (const session of sessions) {
    if (session.workspaceId !== id) continue
    const at = session.lastActivityAt
    if (at === undefined || Number.isNaN(Date.parse(at))) continue
    if (latest === undefined || Date.parse(at) > Date.parse(latest)) latest = at
  }
  return latest
}

// A patch value of `undefined` takes the field off rather than leaving a hole
// where a field was, which is how a session goes back to the checkout.
function pruned<T extends object>(record: T): T {
  const kept = { ...record } as Record<string, unknown>
  for (const [key, value] of Object.entries(kept)) {
    if (value === undefined) delete kept[key]
  }
  return kept as T
}

// An unreadable worktree loads as absent: the session falls back to its
// checkout, and the directory on disk is untouched either way.
function readWorktree(value: unknown): SessionWorktree | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { path, branch } = value as { path?: unknown; branch?: unknown }
  if (typeof path !== 'string' || path === '') return undefined
  return { path, ...(typeof branch === 'string' && branch !== '' ? { branch } : {}) }
}

const FLAVORS: readonly Flavor[] = ['fake', 'sdk']

// A flavor is a stamp on a token, so it is kept only beside one.
function readTokenFlavor(session: unknown): Flavor | undefined {
  const { token, tokenFlavor } = session as { token?: unknown; tokenFlavor?: unknown }
  if (typeof token !== 'string') return undefined
  return FLAVORS.includes(tokenFlavor as Flavor) ? (tokenFlavor as Flavor) : undefined
}

const KINDS: readonly ExhibitKind[] = ['html', 'markdown']

function readPanel(value: unknown): StoredPanel | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { tabs, activeTabId, turn } = value as {
    tabs?: unknown
    activeTabId?: unknown
    turn?: unknown
  }
  if (!Array.isArray(tabs) || typeof turn !== 'number') return undefined
  if (activeTabId !== null && typeof activeTabId !== 'string') return undefined
  if (!tabs.every(isPanelTab)) return undefined
  return { tabs: tabs as StoredPanelTab[], activeTabId, turn }
}

function isPanelTab(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const tab = value as Record<string, unknown>
  return (
    typeof tab.id === 'string' &&
    typeof tab.title === 'string' &&
    typeof tab.path === 'string' &&
    typeof tab.shownAt === 'string' &&
    typeof tab.shownTurn === 'number' &&
    KINDS.includes(tab.kind as ExhibitKind)
  )
}
