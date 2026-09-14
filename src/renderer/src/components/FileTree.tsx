import { useEffect, useMemo, useRef } from 'react'
import type { FileTree as Listing } from '../../../shared/workspace/service'
import { fileRows, type Expanded, type FileRow } from '../files/tree'
import './file-tree.css'

// The sidebar column's second face: the folder tree of the active session's
// working directory. Read-only — it opens files and reveals them, and changes
// nothing on disk.
//
// Every fact it draws is handed to it: the listing main read, which folders
// are open, what is being filtered for. It decides none of them, so what the
// tree shows and what the shell remembers cannot disagree.

export interface FilesFace {
  /** The root row's name: the workspace's, as the sidebar spells it. */
  readonly name: string
  // The worktree this session works in, named as the root row marks it.
  // Absent for a session on the checkout, and with no session at all.
  readonly worktree?: string
  /** Absent until the first listing lands, which is what the empty tree means. */
  readonly listing?: Listing
  readonly expanded: Expanded
  readonly filter: string
  /** Folders closed by hand under the filter; empty when nothing is filtered. */
  readonly collapsed: Expanded
  /** The open file, root-relative, drawn as the current row. */
  readonly activePath?: string
  readonly onFilter: (text: string) => void
  readonly onToggleFolder: (path: string) => void
  /** A single click is a preview; `keep` is the double-click. */
  readonly onOpen: (path: string, options: { readonly keep: boolean }) => void
  readonly onCopyPath: (path: string) => void
  readonly onReveal: (path: string) => void
  /** Escape with the tree focused: back to the sessions. */
  readonly onLeave: () => void
}

export function FileTree({ face }: { readonly face: FilesFace }): React.JSX.Element {
  const { listing, expanded, filter, collapsed } = face
  const rows = useMemo(
    () => (listing === undefined ? [] : fileRows(listing, { expanded, filter, collapsed })),
    [listing, expanded, filter, collapsed]
  )

  // The face is swapped in by a chord, so the caret lands where typing does
  // something: filtering, and the Escape that swaps it back.
  const box = useRef<HTMLInputElement>(null)
  useEffect(() => {
    box.current?.focus()
  }, [])

  return (
    <div
      className="filetree"
      onKeyDown={(pressed) => {
        if (pressed.key !== 'Escape') return
        // Taken here rather than left to the window: with the tree focused,
        // Escape means this column and nothing further up the ladder.
        pressed.stopPropagation()
        pressed.preventDefault()
        face.onLeave()
      }}
    >
      <div className="troot">
        <b>{face.name}</b>
        {face.worktree === undefined ? null : (
          <span className="wt" title="This session works in a worktree">
            worktree · {face.worktree}
          </span>
        )}
      </div>

      <div className="filter">
        <span className="glyph" aria-hidden="true">
          ⌕
        </span>
        <input
          type="text"
          ref={box}
          value={filter}
          placeholder="filter files…"
          aria-label="Filter files"
          spellCheck={false}
          onChange={(typed) => face.onFilter(typed.target.value)}
        />
        <kbd>esc</kbd>
      </div>

      <div className="rows" role="tree" aria-label="Files" tabIndex={-1}>
        {rows.map((row) => (
          <Row key={row.path} row={row} face={face} />
        ))}
        {listing !== undefined && rows.length === 0 ? (
          <p className="nothing">{filter === '' ? 'Nothing here.' : 'No file matches.'}</p>
        ) : null}
      </div>
    </div>
  )
}

/** What the row's status says, in words, or nothing for a plain row. */
function mark(row: FileRow): string | undefined {
  if (row.kind === 'directory') return row.changed ? 'holds changes' : undefined
  if (row.status === 'modified') return 'modified'
  if (row.status === 'untracked') return 'untracked'
  return undefined
}

function Row({ row, face }: { readonly row: FileRow; readonly face: FilesFace }): React.JSX.Element {
  const directory = row.kind === 'directory'
  const status = row.kind === 'file' ? row.status : undefined
  const changed = directory && row.changed
  const current = !directory && row.path === face.activePath

  function activate(keep: boolean): void {
    if (directory) face.onToggleFolder(row.path)
    else face.onOpen(row.path, { keep })
  }

  return (
    <div
      className={[
        'row',
        directory ? 'dir' : 'leaf',
        status === 'modified' ? 'modified' : '',
        status === 'untracked' ? 'untracked' : '',
        changed ? 'holds' : '',
        current ? 'on' : ''
      ]
        .filter((part) => part !== '')
        .join(' ')}
      role="treeitem"
      tabIndex={0}
      aria-level={row.depth + 1}
      // The color and the letter are the eye's version of the git status; the
      // name is everybody else's.
      aria-label={mark(row) === undefined ? row.name : `${row.name} (${mark(row)})`}
      aria-current={current ? 'true' : undefined}
      {...(directory ? { 'aria-expanded': row.expanded } : {})}
      // The indent is the row's depth, drawn rather than nested: one flat list
      // scrolls and measures as one thing.
      style={{ paddingLeft: `${12 + row.depth * 14}px` }}
      onClick={() => activate(false)}
      onDoubleClick={() => activate(true)}
      onKeyDown={(pressed) => {
        if (pressed.key !== 'Enter' && pressed.key !== ' ') return
        pressed.preventDefault()
        activate(true)
      }}
    >
      <span className="c" aria-hidden="true">
        {directory ? (row.expanded ? '▾' : '▸') : ''}
      </span>
      {directory ? null : (
        // The first three characters of the extension: a mark rather than a
        // fact, since the name beside it carries the whole of it.
        <span className="i" aria-hidden="true">
          {row.extension.slice(0, 3)}
        </span>
      )}
      <span className="name">{row.name}</span>
      <span className="st" aria-hidden="true">
        {status === 'modified' ? 'M' : status === 'untracked' ? 'U' : changed ? '•' : ''}
      </span>
      <span className="rowtools">
        <button
          aria-label={`Copy path of ${row.name}`}
          title="Copy path"
          onClick={(clicked) => {
            clicked.stopPropagation()
            face.onCopyPath(row.path)
          }}
        >
          <span aria-hidden="true">⧉</span>
        </button>
        <button
          aria-label={`Reveal ${row.name}`}
          title="Reveal in the file manager"
          onClick={(clicked) => {
            clicked.stopPropagation()
            face.onReveal(row.path)
          }}
        >
          <span aria-hidden="true">↗</span>
        </button>
      </span>
    </div>
  )
}
