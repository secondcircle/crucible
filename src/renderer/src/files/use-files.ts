import { useEffect, useState } from 'react'
import type { FileTree, WorkspaceService } from '../../../shared/workspace/service'

// The two live facts the file viewer stands on: that something under the
// session's directory changed, and what the tree lists now. Both belong to the
// workspace service; nothing here reads a folder itself.

/**
 * Watches a directory for as long as one is given, and counts the changes it
 * announces. A count rather than a flag: two changes in a row are two reasons
 * to read again, and a counter cannot go stale.
 */
export function useWatchedDirectory(
  service: WorkspaceService,
  directory: string | undefined
): number {
  const [changes, setChanges] = useState(0)

  useEffect(() => {
    if (directory === undefined) return
    const unsubscribe = service.onEvent((event) => {
      if (event.type !== 'files_changed' || event.directory !== directory) return
      setChanges((seen) => seen + 1)
    })
    void service.watchFiles(directory).catch(() => {})
    return () => {
      unsubscribe()
      void service.unwatchFiles(directory).catch(() => {})
    }
  }, [service, directory])

  return changes
}

/**
 * The listing for a directory, read again whenever `changed` moves. Absent
 * until the first answer lands, and absent again the moment the directory
 * changes, so no tree is ever drawn from another folder's listing.
 */
export function useFileTree(
  service: WorkspaceService,
  directory: string | undefined,
  changed: number
): FileTree | undefined {
  const [listing, setListing] = useState<FileTree | undefined>(undefined)

  useEffect(() => {
    if (directory === undefined) return
    let current = true
    void service
      .fileTree(directory)
      .then((read) => {
        if (current) setListing(read)
      })
      // A folder that could not be read leaves the tree as it was: the failure
      // has no row to land in, and the next read may well answer.
      .catch(() => {})
    return () => {
      current = false
    }
  }, [service, directory, changed])

  // The listing answers for the folder it named, so a listing left over from
  // another directory is not this tree's and is not shown.
  return listing !== undefined && listing.directory === directory ? listing : undefined
}
