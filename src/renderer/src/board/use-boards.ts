import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceId, WorkspaceState } from '../../../shared/agent/port'
import type { BranchBoardAnswer, WorkspaceService } from '../../../shared/workspace/service'

// Where the board's refresh cadence lives. Snapshots are this document's
// memory, keyed by workspace, and nothing here is persisted: a board is a fact
// about a repository as it stands, and a remembered one would be a lie.

/** While the window is focused, and never otherwise. */
export const POLL_MS = 60_000

export interface BoardEntry {
  /** The last answer that arrived; a failure leaves the previous one standing. */
  readonly answer?: BranchBoardAnswer
  /** What the last collection failed with, cleared by the next good one. */
  readonly failure?: string
  readonly refreshing: boolean
}

export function useBranchBoards({
  service,
  workspaces,
  activeWorkspaceId,
  working,
  onFailure
}: {
  readonly service: WorkspaceService
  readonly workspaces: readonly WorkspaceState[]
  readonly activeWorkspaceId?: WorkspaceId
  /** Workspaces with a session working: their collections wait. */
  readonly working: ReadonlySet<WorkspaceId>
  readonly onFailure: (message: string) => void
}): {
  readonly boards: Readonly<Record<WorkspaceId, BoardEntry>>
  readonly refresh: (workspaceId: WorkspaceId) => void
} {
  const [boards, setBoards] = useState<Readonly<Record<WorkspaceId, BoardEntry>>>({})
  // What a collection reads when it runs, rather than what was true when the
  // trigger was wired up.
  const latest = useRef({ workspaces, activeWorkspaceId, working })
  const inFlight = useRef<Set<WorkspaceId>>(new Set())
  // Whether this window has the focus: read once at the start, because no
  // focus event fires for a window that was already focused when it opened,
  // and kept in step by the events after that.
  const focused = useRef(document.hasFocus())

  useEffect(() => {
    latest.current = { workspaces, activeWorkspaceId, working }
  })

  const collect = useCallback(
    async (workspaceId: WorkspaceId): Promise<void> => {
      const workspace = latest.current.workspaces.find(
        (candidate) => candidate.id === workspaceId
      )
      if (workspace === undefined) return
      // Skipped rather than queued: the next trigger retries, and the board
      // says how old what it is showing is.
      if (latest.current.working.has(workspaceId)) return
      if (inFlight.current.has(workspaceId)) return
      inFlight.current.add(workspaceId)
      setBoards((current) => ({
        ...current,
        [workspaceId]: { ...current[workspaceId], refreshing: true }
      }))
      try {
        const answer = await service.branchBoard(workspace.path)
        setBoards((current) => ({ ...current, [workspaceId]: { answer, refreshing: false } }))
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        // The last good snapshot stays on screen with its true age, and the
        // failure is said in two places rather than nowhere.
        setBoards((current) => ({
          ...current,
          [workspaceId]: { ...current[workspaceId], refreshing: false, failure: message }
        }))
        onFailure(message)
      } finally {
        inFlight.current.delete(workspaceId)
      }
    },
    [service, onFailure]
  )

  // Active first, then the rest one at a time, so the badges stay honest
  // without every workspace reaching for gh at once.
  const sweep = useCallback(async (): Promise<void> => {
    if (!focused.current) return
    const { workspaces: known, activeWorkspaceId: active } = latest.current
    const ids = known.map((workspace) => workspace.id)
    const ordered = active === undefined ? ids : [active, ...ids.filter((id) => id !== active)]
    for (const id of ordered) await collect(id)
  }, [collect])

  // Becoming the active workspace is a collection trigger of its own.
  useEffect(() => {
    if (activeWorkspaceId === undefined) return
    void collect(activeWorkspaceId)
  }, [activeWorkspaceId, collect])

  useEffect(() => {
    function onFocus(): void {
      focused.current = true
      void sweep()
    }
    function onBlur(): void {
      focused.current = false
    }
    const poll = setInterval(() => {
      void sweep()
    }, POLL_MS)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      clearInterval(poll)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [sweep])

  const refresh = useCallback(
    (workspaceId: WorkspaceId): void => {
      void collect(workspaceId)
    },
    [collect]
  )

  return { boards, refresh }
}
