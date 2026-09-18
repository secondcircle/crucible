import { useEffect, useRef, useState } from 'react'
import type { FileTree, WorkspaceService } from '../../../shared/workspace/service'

// The two live facts the file viewer stands on: that something under the
// session's directory changed, and what the tree lists now. Both belong to the
// workspace service; nothing here reads a folder itself.

/**
 * Watches a directory, counts the changes it announces, and reads its listing
 * in step with the watch.
 *
 * In step is the whole point. Started as two independent effects, the listing
 * is read in the same commit the watch is asked for, so a file written between
 * the read and the watch running is in neither: not in the listing, which was
 * taken before it existed, and not in an event, which nobody was listening for
 * yet. Nothing ever replaces it. Here the watch is asked for first and the
 * listing taken only once that call has answered, so everything written before
 * the listing is in it, and everything after it arrives as a change — a watch
 * that was still starting and dropped one says so itself, once.
 *
 * The changes are a count rather than a flag: two changes in a row are two
 * reasons to read again, and a counter cannot go stale.
 *
 * Two numbers come back, and they answer different questions. `changes` is
 * what the watcher announced for the directory being watched now — what makes
 * a reader read again. `epoch` answers "may this directory have moved since I
 * last looked?", which the announcements alone cannot: the watch follows the
 * session on screen, so a directory left behind goes on moving with nobody
 * counting. Every watch that ends therefore moves `epoch` as surely as a
 * change does, which also makes it strictly increasing — it never returns to a
 * value a reader has seen before, so a reader that caches what the disk said
 * can hold its answers against it.
 */
export function useWatchedFiles(
  service: WorkspaceService,
  directory: string | undefined,
  /** False where the column is on its other face: the watch stays, the tree is not drawn. */
  listed: boolean
): {
  readonly changes: number
  readonly epoch: number
  readonly listing: FileTree | undefined
} {
  const [changes, setChanges] = useState(0)
  // Watches that have ended, each one the start of a window in which this hook
  // saw nothing of a directory it had been watching.
  const [ended, setEnded] = useState(0)
  const [listing, setListing] = useState<FileTree | undefined>(undefined)
  // The watch the listing waits on. A ref rather than state: it is nothing the
  // tree draws, and the effect that reads it runs after the effect that sets
  // it, in the same commit, every time either of them runs.
  const watching = useRef<Promise<void> | undefined>(undefined)

  useEffect(() => {
    if (directory === undefined) return
    const unsubscribe = service.onEvent((event) => {
      if (event.type !== 'files_changed' || event.directory !== directory) return
      setChanges((seen) => seen + 1)
    })
    // A watch that could not be started answers all the same, and the listing
    // below still happens: a tree that refreshes only when something asks it
    // to beats no tree.
    watching.current = service.watchFiles(directory).catch(() => {})
    return () => {
      unsubscribe()
      watching.current = undefined
      void service.unwatchFiles(directory).catch(() => {})
      // Counted as the watch ends rather than as the next one starts, so the
      // epoch has already moved by the time anything renders against the new
      // directory — and moved again by the time anything renders against this
      // one, whenever the session on screen comes back to it.
      setEnded((over) => over + 1)
    }
  }, [service, directory])

  useEffect(() => {
    const started = watching.current
    if (directory === undefined || !listed || started === undefined) return
    let current = true
    void started
      .then(() => service.fileTree(directory))
      .then((read) => {
        if (current) setListing(read)
      })
      // A folder that could not be read leaves the tree as it was: the failure
      // has no row to land in, and the next read may well answer.
      .catch(() => {})
    return () => {
      current = false
    }
  }, [service, directory, listed, changes])

  // The listing answers for the folder it named, so a listing left over from
  // another directory is not this tree's and is not shown.
  return {
    changes,
    epoch: changes + ended,
    listing: listing !== undefined && listing.directory === directory ? listing : undefined
  }
}
