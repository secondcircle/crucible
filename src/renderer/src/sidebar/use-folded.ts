import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceId, WorkspaceState } from '../../../shared/agent/port'
import type { FoldedStore } from './folded-store'

/**
 * The folded set and the only three things that may change it. There is no
 * `fold(id)`: nothing folds a single workspace except the disclosure control
 * toggling it, and nothing folds anything on its own.
 */
export interface Folding {
  /** May hold ids of workspaces that no longer exist; rendering ignores them. */
  readonly folded: ReadonlySet<WorkspaceId>
  /** Folds an unfolded workspace, unfolds a folded one, touches no other. */
  toggle(id: WorkspaceId): void
  /** Unfolds it if folded; a no-op when it already is. The name click's half. */
  unfold(id: WorkspaceId): void
  /** Folds every workspace in `idle` and unfolds nothing. */
  foldAll(idle: Iterable<WorkspaceId>): void
}

/**
 * Read once at mount, held in React state, written through on every change.
 * `workspaces` is read only to prune ids of workspaces that no longer exist
 * from what is written; it never changes what is folded.
 */
export function useFolded(
  store: FoldedStore,
  workspaces: readonly WorkspaceState[]
): Folding {
  const [folded, setFolded] = useState<ReadonlySet<WorkspaceId>>(() => store.read())
  // The set as of this moment rather than as of the render the click was drawn
  // in, so two folds in one frame compose.
  const held = useRef(folded)
  // Read only at the moment of a write. Nothing prunes on its own: a launch
  // whose snapshot has not arrived yet must not write an empty record over
  // what the last one left.
  const live = useRef(workspaces)
  useEffect(() => {
    live.current = workspaces
  }, [workspaces])

  const change = useCallback(
    (next: (current: ReadonlySet<WorkspaceId>) => ReadonlySet<WorkspaceId>): void => {
      const changed = next(held.current)
      if (changed === held.current) return
      held.current = changed
      setFolded(changed)
      // The state is what renders, so the fold is on screen in this frame; the
      // record is what the next launch reads.
      store.write(new Set([...changed].filter((id) => known(live.current, id))))
    },
    [store]
  )

  const toggle = useCallback(
    (id: WorkspaceId): void =>
      change((current) => {
        const next = new Set(current)
        if (!next.delete(id)) next.add(id)
        return next
      }),
    [change]
  )

  const unfold = useCallback(
    (id: WorkspaceId): void =>
      change((current) => {
        if (!current.has(id)) return current
        const next = new Set(current)
        next.delete(id)
        return next
      }),
    [change]
  )

  const foldAll = useCallback(
    (idle: Iterable<WorkspaceId>): void =>
      change((current) => {
        const next = new Set(current)
        for (const id of idle) next.add(id)
        return next.size === current.size ? current : next
      }),
    [change]
  )

  return { folded, toggle, unfold, foldAll }
}

function known(workspaces: readonly WorkspaceState[], id: WorkspaceId): boolean {
  return workspaces.some((workspace) => workspace.id === id)
}
