import { createContext, useContext, useMemo } from 'react'
import type { WorkspaceService } from '../../../shared/workspace/service'
import { PathLinksContext, usePathLinks, type ClickTarget, type PathLinks } from './path-links'

// A markdown file shown in the panel links to its neighbours the way a wiki
// does: `[Messaging](messaging/INDEX.md)` means the file beside this one, not
// a file in the session's directory. Only a written link resolves this way. A
// code span in a document stays code, because a document names paths in
// backticks as examples far more often than as links.
//
// The same rule as the chat holds: a link is text until the disk has said the
// file is there, so a dead link reads as the markdown it was written as.

/**
 * The links of the document on screen, where one is. Absent everywhere else,
 * which is every message, issue body and run transcript.
 */
export const DocumentLinksContext = createContext<PathLinks | undefined>(undefined)

/**
 * `relative` resolved against the folder `file` sits in, `.` and `..` folded
 * away so the tab it opens names the file the way the disk does. An absolute
 * path is already where it points.
 */
export function resolveBeside(file: string, relative: string): string {
  if (isAbsolutePath(relative)) return relative
  const windows = !file.includes('/') && file.includes('\\')
  const separator = windows ? '\\' : '/'
  const folder = file.split(/[/\\]/).slice(0, -1)
  const root = folder[0] ?? ''
  const parts = folder.slice(1)
  for (const part of relative.split(/[/\\]/)) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return [root, ...parts].join(separator)
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[/\\]/.test(path)
}

/**
 * The links of the markdown file at `file`: checked against the file's own
 * folder, and opened, by absolute path, wherever the surrounding links open.
 */
export function useDocumentLinks({
  service,
  file,
  epoch
}: {
  readonly service: WorkspaceService
  readonly file: string
  /** Goes up whenever the document is read again, which retires every answer. */
  readonly epoch: number
}): PathLinks {
  const outer = useContext(PathLinksContext)
  const folder = resolveBeside(file, '.')
  const { open, keep } = outer
  const absolute = useMemo(() => {
    const at = (target: ClickTarget): ClickTarget =>
      target.kind === 'file' ? { ...target, path: resolveBeside(file, target.path) } : target
    return {
      open: (target: ClickTarget) => open(at(target)),
      keep: (target: ClickTarget) => keep(at(target))
    }
  }, [file, open, keep])
  return usePathLinks({
    service,
    directory: folder,
    epoch,
    open: absolute.open,
    keep: absolute.keep
  })
}
