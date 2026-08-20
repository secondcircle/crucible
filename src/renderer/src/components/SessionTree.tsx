import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionTree as Tree, TreeNode } from '../../../shared/agent/port'
import { clockTime } from '../labels'
import './session-tree.css'

// The full overlay over the transcript region (Mock I). It reads a tree it was
// handed and never interprets a `ref`: what a node is called on the other side
// of the port is the adapter's business.

/** What the label input starts on when a node has no label yet (Q24). */
const DEFAULT_LABEL = 'checkpoint'

type Row =
  | {
      readonly kind: 'node'
      readonly node: TreeNode
      readonly onPath: boolean
      readonly depth: number
    }
  | {
      readonly kind: 'between'
      readonly text: string
      readonly onPath: boolean
      readonly depth: number
    }
  /** The tag above an abandoned branch, with the last time anything happened in it. */
  | { readonly kind: 'fork'; readonly at: string; readonly depth: number }
  /** Rendered by this overlay, never served as a node: it has no actions. */
  | { readonly kind: 'here' }

export function SessionTree({
  tree,
  working,
  onJump,
  onLabel,
  onClose
}: {
  readonly tree: Tree
  /** Continuing is refused while the session works; browsing never is (Q26). */
  readonly working: boolean
  readonly onJump: (ref: string, summarize: boolean) => void
  /** An absent label clears it. */
  readonly onLabel: (ref: string, label?: string) => void
  readonly onClose: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [labelling, setLabelling] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const search = useRef<HTMLInputElement>(null)

  const filtering = query.trim() !== ''
  const wanted = query.trim().toLowerCase()

  const rows = useMemo(
    () =>
      layout(tree, working, filtering, (node) =>
        filtering ? node.text.toLowerCase().includes(wanted) : true
      ),
    [tree, working, filtering, wanted]
  )
  const visible = rows.flatMap((row) => (row.kind === 'node' ? [row.node.ref] : []))
  const matches = filtering ? visible.length : undefined

  // Autofocused on open, so typing filters straight away (Mock I).
  useEffect(() => {
    search.current?.focus()
  }, [])

  function move(by: number): void {
    if (visible.length === 0) return
    const at = selected === undefined ? -1 : visible.indexOf(selected)
    const next = at === -1 ? (by > 0 ? 0 : visible.length - 1) : at + by
    setSelected(visible[Math.max(0, Math.min(visible.length - 1, next))])
  }

  function jump(ref: string | undefined, summarize: boolean): void {
    if (ref === undefined || working) return
    onJump(ref, summarize)
  }

  function openLabelInput(node: TreeNode): void {
    setSelected(node.ref)
    setLabelling(node.ref)
    setDraft(node.label ?? DEFAULT_LABEL)
  }

  function confirmLabel(ref: string): void {
    const wantedLabel = draft.trim()
    setLabelling(undefined)
    onLabel(ref, wantedLabel === '' ? undefined : wantedLabel)
  }

  return (
    <div
      className="tree"
      role="dialog"
      aria-label="Session tree"
      onKeyDown={(pressed) => {
        if (pressed.key === 'ArrowDown' || pressed.key === 'ArrowUp') {
          pressed.preventDefault()
          move(pressed.key === 'ArrowDown' ? 1 : -1)
          return
        }
        if (pressed.key === 'Enter') {
          pressed.preventDefault()
          if (labelling === undefined) jump(selected, false)
          return
        }
        // A letter typed in the search field filters; it never acts.
        const typing = (pressed.target as HTMLElement).tagName === 'INPUT'
        if (typing || selected === undefined) return
        if (pressed.key === 's') {
          pressed.preventDefault()
          jump(selected, true)
          return
        }
        if (pressed.key === 'l') {
          pressed.preventDefault()
          const node = find(tree.roots, selected)
          if (node !== undefined) openLabelInput(node)
        }
      }}
    >
      <div className="treehead">
        <h1>Session tree</h1>
        <span className="treeesc">esc to close</span>
      </div>

      <div className="treesearch">
        <input
          ref={search}
          aria-label="Search this session"
          placeholder="Search this session…"
          value={query}
          onChange={(changed) => setQuery(changed.target.value)}
        />
        {matches === undefined ? null : (
          <div className="count">
            {matches} matching point{matches === 1 ? '' : 's'}
          </div>
        )}
      </div>

      <div className="nodes">
        <div className="rail">
          {rows.map((row, index) => {
            if (row.kind === 'here') {
              return (
                <div className="node onpath leaf" key="here">
                  <span className="dot" aria-hidden="true" />
                  <div className="nodecard here">
                    <div className="nodetext">Current point</div>
                    <div className="noderow">
                      <span className="youarehere">you are here</span>
                    </div>
                  </div>
                </div>
              )
            }

            if (row.kind === 'fork') {
              return (
                <div
                  className="forktag"
                  key={`fork-${index}`}
                  style={{ marginLeft: indent(row.depth) }}
                >
                  ⑂ branch · abandoned {clockTime(row.at)}
                </div>
              )
            }

            if (row.kind === 'between') {
              return (
                <div
                  className={`between${row.onPath ? ' onpath' : ''}`}
                  key={`between-${index}`}
                  style={{ marginLeft: indent(row.depth) }}
                >
                  {row.text}
                </div>
              )
            }

            const { node } = row
            const open = selected === node.ref
            return (
              <div
                className={`node ${row.onPath ? 'onpath' : 'offpath'}${open ? ' selected' : ''}`}
                key={node.ref}
                style={{ marginLeft: indent(row.depth) }}
              >
                <span className="dot" aria-hidden="true" />
                <button
                  className="nodecard"
                  aria-expanded={open}
                  onClick={() => setSelected(open ? undefined : node.ref)}
                >
                  <span className="nodetext">{node.text}</span>
                  <span className="noderow">
                    {node.label === undefined ? null : <span className="label">{node.label}</span>}
                    <span className="when">{clockTime(node.at)}</span>
                  </span>
                </button>

                {open ? (
                  <div className="actions">
                    <div className="row">
                      <button
                        className="act"
                        disabled={working}
                        onClick={() => jump(node.ref, false)}
                      >
                        Continue from here <span className="k">⏎</span>
                      </button>
                      <button
                        className="act"
                        disabled={working}
                        onClick={() => jump(node.ref, true)}
                      >
                        Continue with summary <span className="k">s</span>
                      </button>
                      <button className="act" onClick={() => openLabelInput(node)}>
                        {node.label === undefined ? 'Label' : 'Remove label'}{' '}
                        <span className="k">l</span>
                      </button>
                    </div>

                    {labelling === node.ref ? (
                      <div className="labeledit">
                        <input
                          aria-label="Label this point"
                          autoFocus
                          value={draft}
                          onChange={(changed) => setDraft(changed.target.value)}
                          onKeyDown={(pressed) => {
                            if (pressed.key !== 'Enter') return
                            pressed.preventDefault()
                            confirmLabel(node.ref)
                          }}
                        />
                        <button className="act" onClick={() => confirmLabel(node.ref)}>
                          Save label
                        </button>
                        {node.label === undefined ? null : (
                          <button
                            className="act"
                            onClick={() => {
                              setLabelling(undefined)
                              onLabel(node.ref)
                            }}
                          >
                            Remove label
                          </button>
                        )}
                      </div>
                    ) : null}

                    <div className="actnote">
                      {working
                        ? 'This session is working — stop the agent first to continue from a point.'
                        : row.onPath
                          ? 'Continuing from a user message puts it back in the composer, unsent — the conversation stands at the moment before you pressed enter.'
                          : 'This leaves the current path and continues the abandoned branch. Nothing is lost — the tree keeps every path.'}
                    </div>
                  </div>
                ) : null}
              </div>
            )
          })}

          {rows.length === 0 ? <p className="nonodes">Nothing matches that.</p> : null}
        </div>
      </div>

      <div className="treefoot">
        <span>↑↓ move</span>
        <span>⏎ continue</span>
        <span>s summarize</span>
        <span>l label</span>
        <button className="closetree" onClick={onClose}>
          esc close
        </button>
      </div>
    </div>
  )
}

/** Fork bodies are indented, exactly as far as their depth, and no further. */
function indent(depth: number): number {
  return depth * 18
}

function find(nodes: readonly TreeNode[], ref: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.ref === ref) return node
    const below = find(node.children, ref)
    if (below !== undefined) return below
  }
  return undefined
}

/** The last time anything happened in a subtree, which is when it was left. */
function lastTime(node: TreeNode): string {
  return node.children.reduce((latest, child) => {
    const below = lastTime(child)
    return below > latest ? below : latest
  }, node.at)
}

function hasMatch(node: TreeNode, keep: (node: TreeNode) => boolean): boolean {
  return keep(node) || node.children.some((child) => hasMatch(child, keep))
}

// One walk produces what is drawn and, with it, the order the arrow keys move
// in: the two can never disagree about what is on screen. While a filter is
// active the connective lines and the fork tags are not drawn at all.
function layout(
  tree: Tree,
  working: boolean,
  filtering: boolean,
  keep: (node: TreeNode) => boolean
): Row[] {
  const rows: Row[] = []

  function between(node: TreeNode, onPath: boolean, depth: number, last: boolean): void {
    // While the session works, the line after the last point on the path says
    // so, from the snapshot's own flag rather than from anything invented.
    const suffix = last && working ? 'working…' : undefined
    const text = [node.activity, suffix].filter((part) => part !== undefined).join(' · ')
    if (text === '' || filtering) return
    rows.push({ kind: 'between', text, onPath, depth })
  }

  function offPath(node: TreeNode, depth: number): void {
    if (keep(node)) rows.push({ kind: 'node', node, onPath: false, depth })
    between(node, false, depth, false)
    const [first, ...rest] = node.children
    if (first !== undefined) offPath(first, depth)
    // A branch inside an abandoned branch is still a branch, and still reachable.
    for (const other of rest) fork(other, depth + 1)
  }

  function fork(node: TreeNode, depth: number): void {
    if (!hasMatch(node, keep)) return
    if (!filtering) rows.push({ kind: 'fork', at: lastTime(node), depth })
    offPath(node, depth)
  }

  function level(nodes: readonly TreeNode[], depth: number, at: number): void {
    const onPathRef = tree.path[at]
    // Off the path first, then the rail continues: what was abandoned hangs
    // where it diverged (Mock I).
    for (const node of nodes) {
      if (node.ref !== onPathRef) fork(node, depth + 1)
    }
    const onPath = nodes.find((node) => node.ref === onPathRef)
    if (onPath === undefined) return
    if (keep(onPath)) rows.push({ kind: 'node', node: onPath, onPath: true, depth })
    between(onPath, true, depth, at === tree.path.length - 1)
    level(onPath.children, depth, at + 1)
  }

  level(tree.roots, 0, 0)
  if (!filtering) rows.push({ kind: 'here' })
  return rows
}
