import type { WorkspaceId } from '../../../shared/agent/port'

// Where the sidebar's folded workspaces are kept. Folding is looking-glass
// state: no agent sees it, main never reads it, and nothing about it crosses
// the agent port. It lives behind this seam so a component test can hand in a
// store with nothing on disk and nothing between mounts.

const FOLDED_KEY = 'crucible.sidebar.folded'

/** What one launch leaves for the next. Versioned so a later shape can migrate. */
interface FoldedRecord {
  readonly version: 1
  readonly folded: readonly WorkspaceId[]
}

/**
 * Where the sidebar's folded workspaces are kept between launches. Both
 * members are synchronous: a fold shows in the frame the click lands, and
 * nothing about it waits on a write.
 */
export interface FoldedStore {
  /** An unreadable or unrecognized record reads as the empty set. */
  read(): ReadonlySet<WorkspaceId>
  /** Replaces the record. Never throws: a store that cannot write is still a store. */
  write(folded: ReadonlySet<WorkspaceId>): void
}

/**
 * The launch's own store. Backed by `window.localStorage`, which lives under
 * the userData directory main pins per instance, so a dev launch never reads
 * or writes what the installed app holds.
 */
export function localFoldedStore(storage?: Storage): FoldedStore {
  function held(): Storage | undefined {
    if (storage !== undefined) return storage
    try {
      return window.localStorage ?? undefined
    } catch {
      // A profile with storage denied still folds; it just forgets.
      return undefined
    }
  }

  return {
    read(): ReadonlySet<WorkspaceId> {
      try {
        const raw = held()?.getItem(FOLDED_KEY)
        if (raw === null || raw === undefined) return new Set()
        return readRecord(JSON.parse(raw))
      } catch {
        // Absent, malformed, or written by a shape this build cannot read: the
        // list renders with every workspace unfolded rather than not at all.
        return new Set()
      }
    },

    write(folded: ReadonlySet<WorkspaceId>): void {
      const record: FoldedRecord = { version: 1, folded: [...folded] }
      try {
        held()?.setItem(FOLDED_KEY, JSON.stringify(record))
      } catch {
        // Nothing on screen depends on the write, so a store that cannot write
        // costs this launch's memory and no more.
      }
    }
  }
}

/** What a component test hands in: nothing on disk, nothing between mounts. */
export function memoryFoldedStore(initial?: Iterable<WorkspaceId>): FoldedStore {
  let folded: ReadonlySet<WorkspaceId> = new Set(initial ?? [])
  return {
    read: () => folded,
    write: (next) => {
      folded = new Set(next)
    }
  }
}

function readRecord(parsed: unknown): ReadonlySet<WorkspaceId> {
  if (typeof parsed !== 'object' || parsed === null) return new Set()
  const record = parsed as { version?: unknown; folded?: unknown }
  if (record.version !== 1 || !Array.isArray(record.folded)) return new Set()
  return new Set(record.folded.filter((id): id is WorkspaceId => typeof id === 'string'))
}
