import type { FileStatus, FileTree } from '../../../shared/workspace/service'

// The rows the file tree draws, from the flat listing main answers with. Pure:
// no React, no DOM, no service. The folders are derived from the paths rather
// than listed beside them, so no two facts about one directory can disagree.

/** Which folders are open. Absence is closed, so there is one representation. */
export type Expanded = ReadonlySet<string>

/** What the tree is showing, and nothing about how it is drawn. */
export interface TreeView {
  /** The folders opened in the whole tree, remembered for the workspace. */
  readonly expanded: Expanded
  readonly filter: string
  /**
   * The folders closed by hand under the current filter, where a match's
   * ancestors are open to begin with. A set of its own, because under a
   * filter open is the default and `expanded` answers the other question.
   */
  readonly collapsed: Expanded
}

/** Whether a tree is filtered at all: spaces alone narrow nothing. */
export function filtering(filter: string): boolean {
  return filter.trim() !== ''
}

interface FileRowBase {
  /** Root-relative, `/`-separated: the key, and what a click carries. */
  readonly path: string
  readonly name: string
  /** 0 for an entry sitting directly in the root. */
  readonly depth: number
}

export type FileRow =
  | (FileRowBase & {
      readonly kind: 'directory'
      readonly expanded: boolean
      /** Something under it is modified or untracked, which the dot says. */
      readonly changed: boolean
    })
  | (FileRowBase & {
      readonly kind: 'file'
      /** Lowercase and without the dot; empty when the name has none. */
      readonly extension: string
      readonly status?: FileStatus
    })

interface Folder {
  readonly folders: Map<string, Folder>
  readonly files: Set<string>
}

function folder(): Folder {
  return { folders: new Map(), files: new Set() }
}

/**
 * Every row the tree shows, in draw order: folders before files at each level,
 * each group alphabetical. A folder's children are listed when it is open, and
 * a filter opens everything it kept, because a match nobody can see is no
 * answer — until the user closes one of them, which is the one thing that
 * closes a folder in a filtered tree.
 */
export function fileRows(tree: FileTree, view: TreeView): readonly FileRow[] {
  const filtered = filtering(view.filter)
  const filter = view.filter.trim().toLowerCase()
  const paths = !filtered
    ? tree.paths
    : tree.paths.filter((path) => path.toLowerCase().includes(filter))
  const root = build(paths)
  const changedFolders = foldersHolding(Object.keys(tree.changed))

  const rows: FileRow[] = []
  function walk(at: Folder, prefix: string, depth: number): void {
    for (const name of [...at.folders.keys()].sort(compare)) {
      const path = prefix === '' ? name : `${prefix}/${name}`
      const child = at.folders.get(name)
      if (child === undefined) continue
      // A filtered tree is open by construction, closed only where the user
      // closed it; the remembered folders answer for the whole tree alone.
      const expanded = filtered ? !view.collapsed.has(path) : view.expanded.has(path)
      rows.push({
        kind: 'directory',
        path,
        name,
        depth,
        expanded,
        changed: changedFolders.has(path)
      })
      if (expanded) walk(child, path, depth + 1)
    }
    for (const name of [...at.files].sort(compare)) {
      const path = prefix === '' ? name : `${prefix}/${name}`
      const status = tree.changed[path]
      rows.push({
        kind: 'file',
        path,
        name,
        depth,
        extension: extensionOf(name),
        ...(status === undefined ? {} : { status })
      })
    }
  }
  walk(root, '', 0)
  return rows
}

/**
 * The path as the tree names it: relative to the root, `/`-separated. Absent
 * for a file outside the directory the tree lists, which has no row.
 */
export function insideTree(directory: string, path: string): string | undefined {
  const root = directory.endsWith('/') || directory.endsWith('\\') ? directory.slice(0, -1) : directory
  if (!path.startsWith(root)) return undefined
  const rest = path.slice(root.length)
  if (rest === '' || (rest[0] !== '/' && rest[0] !== '\\')) return undefined
  return rest.slice(1).split('\\').join('/')
}

/** Opens a closed folder and closes an open one. */
export function toggleFolder(expanded: Expanded, path: string): Expanded {
  const next = new Set(expanded)
  if (!next.delete(path)) next.add(path)
  return next
}

function build(paths: readonly string[]): Folder {
  const root = folder()
  for (const path of paths) {
    const parts = path.split('/').filter((part) => part !== '')
    const name = parts.pop()
    if (name === undefined) continue
    let at = root
    for (const part of parts) {
      let below = at.folders.get(part)
      if (below === undefined) {
        below = folder()
        at.folders.set(part, below)
      }
      at = below
    }
    at.files.add(name)
  }
  return root
}

/** Every folder on the way to a changed file, which is what wears the dot. */
function foldersHolding(paths: readonly string[]): ReadonlySet<string> {
  const holding = new Set<string>()
  for (const path of paths) {
    const parts = path.split('/')
    parts.pop()
    let at = ''
    for (const part of parts) {
      at = at === '' ? part : `${at}/${part}`
      holding.add(at)
    }
  }
  return holding
}

// Case-insensitive, so `Shell.tsx` sits among its neighbors rather than above
// every lowercase name in the folder.
function compare(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: 'base' }) || left.localeCompare(right)
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  // `> 0`: a dotfile's leading dot opens its name rather than an extension.
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}
