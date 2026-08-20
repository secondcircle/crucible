import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ExhibitKind, ModelId, SessionId, ThinkingLevel, WorkspaceId } from '../../shared/agent/port'
import type { StoredPanel, StoredPanelTab } from '../panel/model'

// One store above both adapters, so the launch flavors can never disagree
// about what the sidebar holds. Its file location is an argument for tests.

/** What lets a later shape be migrated. */
const VERSION = 1

export interface StoredWorkspace {
  readonly id: WorkspaceId
  readonly path: string
}

export interface StoredSession {
  readonly id: SessionId
  readonly workspaceId: WorkspaceId
  /** ISO; the sidebar's neutral placeholder label derives from it. */
  readonly createdAt: string
  // Lets a later launch rebind this same sidebar identity to the same
  // conversation. Nothing outside the adapter interprets it.
  readonly token?: string
  /** The last model and level the adapter reported for this session. */
  readonly model?: ModelId
  readonly thinkingLevel?: ThinkingLevel
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
          session.id === id ? { ...session, ...patch } : session
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

  const workspaces = asArray<StoredWorkspace>(file.workspaces).filter(
    (workspace) => typeof workspace?.id === 'string' && typeof workspace?.path === 'string'
  )
  const sessions = asArray<StoredSession>(file.sessions)
    .filter(
      (session) =>
        typeof session?.id === 'string' &&
        typeof session?.workspaceId === 'string' &&
        typeof session?.createdAt === 'string' &&
        workspaces.some((workspace) => workspace.id === session.workspaceId)
    )
    // Panel data that does not read as panel data loads as absent, exactly as
    // an unreadable file does: a lost tab is recoverable, a launch that will
    // not start is not.
    .map((session) => {
      const panel = readPanel((session as { panel?: unknown }).panel)
      const rest = { ...session }
      delete rest.panel
      return panel === undefined ? rest : { ...rest, panel }
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
