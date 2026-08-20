import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceId, WorkspaceState } from '../../../shared/agent/port'
import type {
  BranchBoardAnswer,
  IssueBoardAnswer,
  WorkspaceService
} from '../../../shared/workspace/service'

// Snapshots live only as long as this document does: a board is a fact about a
// repository as it stands, so a persisted one would be a lie.

/** While the window is focused, and never otherwise. */
export const POLL_MS = 60_000

export interface BoardEntry<Answer> {
  /** The last answer that arrived; a failure leaves the previous one standing. */
  readonly answer?: Answer
  /** What the last collection failed with, cleared by the next good one. */
  readonly failure?: string
  readonly refreshing: boolean
}

export interface Boards<Answer> {
  readonly boards: Readonly<Record<WorkspaceId, BoardEntry<Answer>>>
  readonly refresh: (workspaceId: WorkspaceId) => void
}

interface Wanted<Answer> {
  readonly service: WorkspaceService
  readonly workspaces: readonly WorkspaceState[]
  readonly activeWorkspaceId?: WorkspaceId
  /** Workspaces with a session working: their collections wait. */
  readonly working: ReadonlySet<WorkspaceId>
  readonly onFailure: (message: string) => void
  /** The one question this board asks of a workspace. */
  readonly ask: (service: WorkspaceService, workspacePath: string) => Promise<Answer>
}

export function useBranchBoards(
  wanted: Omit<Wanted<BranchBoardAnswer>, 'ask'>
): Boards<BranchBoardAnswer> {
  return useBoards({ ...wanted, ask: askBranches })
}

export function useIssueBoards(
  wanted: Omit<Wanted<IssueBoardAnswer>, 'ask'>
): Boards<IssueBoardAnswer> {
  return useBoards({ ...wanted, ask: askIssues })
}

// Module-level, so the hook's effects depend on something stable rather than
// on a function rebuilt every render.
const askBranches = (service: WorkspaceService, path: string): Promise<BranchBoardAnswer> =>
  service.branchBoard(path)

const askIssues = (service: WorkspaceService, path: string): Promise<IssueBoardAnswer> =>
  service.issueBoard(path)

// One collection rhythm for both boards: the active workspace first, then the
// rest one at a time, on focus and on the poll.
function useBoards<Answer>({
  service,
  workspaces,
  activeWorkspaceId,
  working,
  onFailure,
  ask
}: Wanted<Answer>): Boards<Answer> {
  const [boards, setBoards] = useState<Readonly<Record<WorkspaceId, BoardEntry<Answer>>>>({})
  // What a collection reads when it runs, rather than what was true when the
  // trigger was wired up.
  const latest = useRef({ workspaces, activeWorkspaceId, working })
  const inFlight = useRef<Set<WorkspaceId>>(new Set())
  // Seeded rather than left false, because no focus event fires for a window
  // that already had the focus when it opened.
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
        const answer = await ask(service, workspace.path)
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
    [service, onFailure, ask]
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

  return useMemo(() => ({ boards, refresh }), [boards, refresh])
}
