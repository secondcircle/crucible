import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ModelId, SessionId, ThinkingLevel, WorkspaceId } from '../../shared/agent/port'

/**
 * The shell store: the Crucible-owned state that is identical in both launch
 * flavors — workspaces, the curated session list, what is active, and
 * Crucible's last model selection (A13, A20, A14).
 *
 * It lives above the adapters and there is exactly one of it, because curated
 * membership is genuine app state in every flavor (A27): forking it per adapter
 * would let the fake and the SDK flavors disagree about what the sidebar is.
 * The adapter is still the authority on conversation content, and on the model
 * and thinking level a rebind actually restored — where the two disagree after
 * a rebind, the adapter's word is written back here.
 *
 * The file it writes is Crucible's own and holds nothing of π's (A28): a
 * session entry carries the adapter's opaque binding token and nothing that
 * could be read as a path, a filename or a storage concept.
 *
 * Its storage location is an argument rather than a lookup, which is the whole
 * of what makes it unit-testable: a test hands it a temp file, the app hands it
 * one under Electron's user-data directory.
 */

/** The file's shape. `version` is what lets a later shape be migrated. */
const VERSION = 1

/** A workspace as it is persisted: an id Crucible minted, and an OS folder. */
export interface StoredWorkspace {
  readonly id: WorkspaceId
  readonly path: string
}

/** A curated session as it is persisted. */
export interface StoredSession {
  readonly id: SessionId
  readonly workspaceId: WorkspaceId
  /** ISO; the sidebar's neutral placeholder label derives from it (SE-3). */
  readonly createdAt: string
  /**
   * The adapter's opaque binding token, so a later launch can rebind this same
   * sidebar identity to the same conversation. Nothing outside the adapter
   * interprets it (ADR 0004).
   */
  readonly token?: string
  /** The last model and level the adapter reported for this session. */
  readonly model?: ModelId
  readonly thinkingLevel?: ThinkingLevel
}

/** Everything the store keeps, in the order the file keeps it. */
export interface ShellStoreState {
  readonly workspaces: readonly StoredWorkspace[]
  readonly sessions: readonly StoredSession[]
  readonly activeWorkspaceId?: WorkspaceId
  /** Each workspace remembers the session it was last on (WS-3, WS-5). */
  readonly activeSessionByWorkspace: Readonly<Record<WorkspaceId, SessionId>>
  /** Crucible's last model selection, which a new session starts on (MO-4). */
  readonly lastModel?: ModelId
}

const EMPTY: ShellStoreState = {
  workspaces: [],
  sessions: [],
  activeSessionByWorkspace: {}
}

/** What a caller may change, and how it reads back what it changed. */
export interface ShellStore {
  readonly state: ShellStoreState
  /** The active workspace's remembered session, when it still exists. */
  activeSessionId(): SessionId | undefined
  workspace(id: WorkspaceId): StoredWorkspace | undefined
  session(id: SessionId): StoredSession | undefined
  /**
   * Add a folder, or answer with the workspace already holding it — picking a
   * folder twice activates what is there rather than duplicating it (WS-2).
   * Either way the workspace ends up active.
   */
  addWorkspace(path: string): StoredWorkspace
  removeWorkspace(id: WorkspaceId): void
  activateWorkspace(id: WorkspaceId): void
  addSession(session: Omit<StoredSession, 'id'>): StoredSession
  updateSession(id: SessionId, patch: Partial<Omit<StoredSession, 'id' | 'workspaceId'>>): void
  removeSession(id: SessionId): void
  activateSession(id: SessionId): void
  setLastModel(model: ModelId): void
}

/** How a store says it could not write; the app turns this into a log record. */
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
      // with what is in memory, and the failure is recorded rather than thrown
      // at whoever happened to click something.
      onWriteFailure(cause)
    }
  }

  /** Activation of a workspace that has no remembered session stays unset. */
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
        // The workspace falls back to another of its sessions, or to none.
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

/**
 * What is on disk, or an empty store. A file that cannot be read or parsed, or
 * that carries a version this build does not know, is treated as absent: the
 * shell opens empty rather than refusing to launch, and the next write replaces
 * it. Losing a sidebar is recoverable; a window that will not open is not.
 */
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
  const sessions = asArray<StoredSession>(file.sessions).filter(
    (session) =>
      typeof session?.id === 'string' &&
      typeof session?.workspaceId === 'string' &&
      typeof session?.createdAt === 'string' &&
      workspaces.some((workspace) => workspace.id === session.workspaceId)
  )
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
