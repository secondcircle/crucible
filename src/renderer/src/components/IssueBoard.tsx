import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  IssueBoardAnswer,
  IssueBoardSnapshot,
  IssueGroupId,
  IssueLabel,
  IssueRow,
  MissingPiece
} from '../../../shared/workspace/service'
import { briefAge, issueAge, relativeTime } from '../labels'
import { chordPressed, keyLabel } from '../keys'
import { Markdown } from './Markdown'
import './issue-board.css'

// The board reads the issue host and never writes to it: nothing here closes,
// assigns, labels or comments an issue, and no control could grow into one.
// What it does write is a session of your own, which is the point of it.

/** The fixed order, and the only order. */
const GROUPS: readonly IssueGroupId[] = [
  'assignedToYou',
  'mentionsYou',
  'unclaimed',
  'pickedUp',
  'assignedToOthers'
]

const GROUP_NAMES: Readonly<Record<IssueGroupId, string>> = {
  assignedToYou: 'Assigned to you',
  mentionsYou: 'Mentions you',
  unclaimed: 'Unclaimed',
  pickedUp: 'Already picked up',
  assignedToOthers: 'Assigned to others'
}

const GROUP_WHY: Readonly<Record<IssueGroupId, string>> = {
  assignedToYou: 'open issues this host says are yours',
  mentionsYou: 'your name is in it and it is not yours',
  unclaimed: 'open, nobody assigned — free to pick up',
  pickedUp: 'a session here started on it, or a pull request names it',
  assignedToOthers: "someone else's to answer — here so you see the whole board"
}

type HostKind = IssueBoardSnapshot['host']['kind']

// Every word that differs between hosts, in one table. The board is the same
// board otherwise: same groups, same keys, same pane.
const HOSTS: Readonly<
  Record<HostKind, { readonly name: string; readonly where: string; readonly promise: string }>
> = {
  github: {
    name: 'GitHub Issues',
    // Reads as "Open on GitHub", "open on GitHub", "read on GitHub".
    where: 'on GitHub',
    promise: 'GitHub Issues via gh · nothing here is closed, assigned or commented for you'
  },
  jira: {
    name: 'Jira',
    where: 'in Jira',
    promise: 'Jira, read-only · nothing here is transitioned, assigned or commented for you'
  }
}

/** The age line reads as a clock while the board is open. */
const TICK_MS = 1000

/** How a session on an issue is reached again from the board. */
export interface IssueSession {
  readonly id: string
  readonly title?: string
}

export function IssueBoard({
  answer,
  refreshing,
  failure,
  sessions,
  aligning,
  onRefresh,
  onAlign,
  onOpenSession,
  onOpenIssue,
  onCopy,
  onClose
}: {
  // Absent until the first collection for this workspace answers, which is
  // what the board says rather than showing an empty one.
  readonly answer?: IssueBoardAnswer
  readonly refreshing: boolean
  /** What the last collection failed with; the snapshot on screen still stands. */
  readonly failure?: string
  /** Sessions started on an issue here, by the reference they were started on. */
  readonly sessions: ReadonlyMap<string, IssueSession>
  /** The reference an align is being started on, while it is being started. */
  readonly aligning?: string
  readonly onRefresh: () => void
  readonly onAlign: (row: IssueRow, kind: 'align' | 'quick-align') => void
  readonly onOpenSession: (sessionId: string) => void
  readonly onOpenIssue: (row: IssueRow) => void
  readonly onCopy: (reference: string) => void
  readonly onClose: () => void
}): React.JSX.Element {
  // The widening lasts exactly as long as the board is open, which is what
  // makes it a look rather than a setting.
  const [scope, setScope] = useState<'yours' | 'all'>('yours')
  // Narrows what is listed and nothing else: it never asks the host again, so
  // what it filters is exactly what is on screen.
  const [filter, setFilter] = useState('')
  const [focused, setFocused] = useState<string | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())
  // What the last keystroke did, when it did nothing visible on its own. The
  // footer is where this board answers its keys, so a refusal answers there
  // too rather than passing in silence.
  const [said, setSaid] = useState<string | undefined>(undefined)
  const overlay = useRef<HTMLElement>(null)

  const board = answer?.kind === 'board' ? answer.board : undefined
  const unreachable = answer?.kind === 'unreachable' ? answer.reason : undefined
  const missing = answer?.kind === 'notConfigured' ? answer.missing : undefined
  // Jira is the only host with a not-configured state, so that answer names it
  // even with no board behind it. Nothing else is host-specific until a board
  // has answered.
  const hostKind: HostKind = board?.host.kind ?? (missing === undefined ? 'github' : 'jira')
  const host = HOSTS[hostKind]

  const groups = useMemo(() => {
    const rows = board?.rows ?? []
    const wanted = filter.trim().toLowerCase()
    // Everybody's issues are one click away; yours and the free ones are what
    // the board opens on.
    const visible = rows.filter(
      (row) =>
        (scope === 'all' || row.group !== 'assignedToOthers') && matches(row, wanted)
    )
    return GROUPS.map((id) => ({
      id,
      rows: visible.filter((row) => row.group === id)
    })).filter((group) => group.rows.length > 0)
  }, [board, scope, filter])

  // One walk gives what is on screen and the order the arrows move in, so the
  // two can never disagree.
  const order = useMemo(() => groups.flatMap((group) => group.rows), [groups])
  // The first row, until the person moves off it: derived rather than stored,
  // so a collection that drops the read row cannot leave the ring nowhere.
  const reference =
    focused !== undefined && order.some((row) => row.reference === focused)
      ? focused
      : order[0]?.reference
  const read = order.find((row) => row.reference === reference)
  const session = read === undefined ? undefined : sessions.get(read.reference)
  const busy = aligning !== undefined

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(tick)
  }, [])

  // The board takes the focus when it opens, because it covers everything the
  // focus could otherwise still be sitting in.
  useEffect(() => {
    overlay.current?.focus()
  }, [])

  // Capture phase, so a composer still holding the focus under the overlay can
  // never see an Enter meant for an issue.
  useEffect(() => {
    function onKeyDown(pressed: KeyboardEvent): void {
      const at = order.findIndex((row) => row.reference === reference)
      const row = at === -1 ? undefined : order[at]
      // The filter box is a text field: the caret keys and the copy belong to
      // whoever is typing in it. Enter is still the board's.
      const typing = (pressed.target as HTMLElement | null)?.tagName === 'INPUT'

      function claim(): void {
        pressed.preventDefault()
        pressed.stopPropagation()
      }

      if (typing && pressed.key !== 'Enter') return

      if (pressed.key === 'ArrowDown' || pressed.key === 'ArrowUp') {
        claim()
        if (order.length === 0) return
        const next = Math.max(
          0,
          Math.min(order.length - 1, at + (pressed.key === 'ArrowDown' ? 1 : -1))
        )
        setFocused(order[next]?.reference)
        setSaid(undefined)
        return
      }
      if (pressed.key === 'Enter' && chordPressed(pressed)) {
        claim()
        if (row !== undefined) onOpenIssue(row)
        return
      }
      if (pressed.key === 'Enter') {
        claim()
        if (row === undefined) return
        // One align at a time: the second Enter would create a second session
        // on the same issue before the first has a worktree.
        if (busy) {
          setSaid(`Still starting on ${aligning} — one moment.`)
          return
        }
        setSaid(undefined)
        onAlign(row, pressed.shiftKey ? 'quick-align' : 'align')
        return
      }
      if ((pressed.key === 'c' || pressed.key === 'C') && chordPressed(pressed)) {
        claim()
        if (row !== undefined) onCopy(row.reference)
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [order, reference, busy, aligning, onAlign, onOpenIssue, onCopy])

  return (
    <section
      // The host's own class carries the one layout difference: a Jira row names
      // its issue `EK-341`, which needs more room than `#341`.
      className={hostKind === 'jira' ? 'board issues jira' : 'board issues'}
      role="dialog"
      aria-label="Issue board"
      tabIndex={-1}
      ref={overlay}
    >
      <div className="bhead">
        <h1>Issues</h1>
        {board === undefined ? null : (
          <span className="repo">
            {board.repoLabel} · {host.name}
          </span>
        )}
        <button className="x" onClick={onClose}>
          Close <kbd>esc</kbd>
        </button>
      </div>

      {board === undefined ? null : (
        <div className="bsub">
          <span>
            <span className="live" aria-hidden="true">
              ●
            </span>{' '}
            refreshed {briefAge(board.collectedAt, now)} ago
          </span>
          <span className="scopeword">
            {scope === 'yours' ? 'yours and unclaimed' : "everyone's"}
          </span>
          <button className="link" onClick={() => setScope(scope === 'yours' ? 'all' : 'yours')}>
            {scope === 'yours' ? "show everyone's" : 'show yours only'}
          </button>
          {refreshing ? (
            <span className="refreshing">refreshing…</span>
          ) : (
            <button className="link" onClick={onRefresh}>
              refresh now
            </button>
          )}
          {failure === undefined ? null : (
            <span className="staleword" role="alert">
              couldn't refresh — {failure}
            </span>
          )}
          <span className="filter">
            <input
              value={filter}
              placeholder="filter…"
              aria-label="Filter issues"
              onChange={(typed) => setFilter(typed.target.value)}
            />
          </span>
        </div>
      )}

      <div className="split">
        <div
          className="scroll"
          role="listbox"
          aria-label="Issues"
          aria-activedescendant={reference === undefined ? undefined : rowId(reference)}
        >
          {unreachable !== undefined ? (
            <p className="reading" role="alert">
              {unreachable}
            </p>
          ) : missing !== undefined ? (
            <NotConfigured missing={missing} />
          ) : answer === undefined ? (
            <p className="reading">Reading issues…</p>
          ) : order.length === 0 ? (
            <p className="reading">
              {board === undefined || board.rows.length === 0
                ? 'No open issues here.'
                : filter.trim() !== ''
                  ? `Nothing here matches “${filter.trim()}”.`
                  : "Nothing open that is yours or free — show everyone's to see the rest."}
            </p>
          ) : (
            groups.map((group) => (
              <div className="group" key={group.id} role="group" aria-label={GROUP_NAMES[group.id]}>
                <div className={`ghead ${group.id}`}>
                  <h2>{GROUP_NAMES[group.id]}</h2>
                  <span className="cnt">{group.rows.length}</span>
                  <span className="why">{GROUP_WHY[group.id]}</span>
                </div>
                {group.rows.map((row) => (
                  <Row
                    key={row.reference}
                    row={row}
                    host={hostKind}
                    login={board?.login ?? ''}
                    started={sessions.has(row.reference)}
                    now={now}
                    focused={row.reference === reference}
                    onFocus={() => {
                      setFocused(row.reference)
                      setSaid(undefined)
                    }}
                  />
                ))}
              </div>
            ))
          )}
        </div>

        <aside className="read" aria-label="Issue">
          {read === undefined ? (
            <p className="nothing">Nothing to read.</p>
          ) : (
            <Reading
              row={read}
              host={hostKind}
              login={board?.login ?? ''}
              session={session}
              busy={busy}
              now={now}
              onAlign={onAlign}
              onOpenSession={onOpenSession}
              onOpenIssue={onOpenIssue}
            />
          )}
        </aside>
      </div>

      <div className="bfoot">
        <span>
          <kbd>{keyLabel('⌘I')}</kbd> close
        </span>
        <span>
          <kbd>↑↓</kbd> read the next one
        </span>
        <span>
          <kbd>⏎</kbd> align
        </span>
        <span>
          <kbd>⇧⏎</kbd> quick align
        </span>
        <span>
          <kbd>{keyLabel('⌘⏎')}</kbd> open {host.where}
        </span>
        {reference === undefined ? null : (
          <span>
            <kbd>{keyLabel('⌘C')}</kbd> copy <code>{reference}</code>
          </span>
        )}
        <span className="sp">{said ?? host.promise}</span>
      </div>
    </section>
  )
}

/**
 * Jira is the host here and its configuration is not finished. Every missing
 * piece at once, each naming itself and where it goes: a person fixing this
 * wants the whole list, and an agent can act on it as it stands.
 */
function NotConfigured({ missing }: { readonly missing: readonly MissingPiece[] }): React.JSX.Element {
  return (
    <div className="setup" role="alert">
      <h2>Jira is not set up in this workspace yet.</h2>
      <dl>
        {missing.map((piece) => (
          <div key={piece.name}>
            <dt>
              <code>{piece.name}</code>
            </dt>
            <dd>{piece.where}</dd>
          </div>
        ))}
      </dl>
      <p>
        A session here can do this for you: the setup is in Crucible’s agent docs, as{' '}
        <code>jira.md</code>. Open this board again and it checks the files afresh.
      </p>
    </div>
  )
}

function Row({
  row,
  host,
  login,
  started,
  now,
  focused,
  onFocus
}: {
  readonly row: IssueRow
  readonly host: HostKind
  readonly login: string
  readonly started: boolean
  readonly now: number
  readonly focused: boolean
  readonly onFocus: () => void
}): React.JSX.Element {
  const classes = ['row', row.group === 'pickedUp' ? 'taken' : '', focused ? 'focused' : '']
    .filter((name) => name !== '')
    .join(' ')

  return (
    // A click moves the read and does nothing else. Starting work is a button
    // in the pane, never a double-click nobody meant.
    <div
      className={classes}
      id={rowId(row.reference)}
      role="option"
      aria-selected={focused}
      aria-label={row.reference}
      onClick={onFocus}
    >
      {/* `#341` on GitHub, `EK-341` on Jira: the host's own way of naming one. */}
      <span className="num">{named(row, host)}</span>
      <span className="ttl">{row.title}</span>
      <Labels labels={row.labels} />
      <span className="who2">{who(row, login)}</span>
      <span className="age">{issueAge(row.updatedAt, now)}</span>
      <span className={`state${started ? ' sess' : row.pr === undefined ? '' : ' pr'}`}>
        {started
          ? 'session'
          : row.pr === undefined
            ? comments(row.comments)
            : `PR #${row.pr.number} ${row.pr.state}`}
      </span>
    </div>
  )
}

/** The whole of one issue, which is what deciding to take it needs. */
function Reading({
  row,
  host,
  login,
  session,
  busy,
  now,
  onAlign,
  onOpenSession,
  onOpenIssue
}: {
  readonly row: IssueRow
  readonly host: HostKind
  readonly login: string
  readonly session?: IssueSession
  readonly busy: boolean
  readonly now: number
  readonly onAlign: (row: IssueRow, kind: 'align' | 'quick-align') => void
  readonly onOpenSession: (sessionId: string) => void
  readonly onOpenIssue: (row: IssueRow) => void
}): React.JSX.Element {
  const comment = row.latestComment
  const rest = row.comments - (comment === undefined ? 0 : 1)

  return (
    <>
      <div className="rhead">
        <div className="rnum">
          <span>{named(row, host)}</span>
          <span className="st">open</span>
          <span>
            opened {issueAge(row.createdAt, now)} ago by <b>{row.authorLogin}</b>
          </span>
        </div>
        <h3>{row.title}</h3>
        <div className="rmeta">
          <Labels labels={row.labels} />
          <span>
            {row.assignees.length === 0 ? (
              'unassigned'
            ) : (
              <>
                assignee <b>{who(row, login)}</b>
              </>
            )}
          </span>
          <span>updated {relativeTime(row.updatedAt, now)}</span>
        </div>
      </div>

      <div className="rbody">
        {row.body.trim() === '' ? (
          <p className="fade">No description.</p>
        ) : (
          <Markdown markdown={row.body} />
        )}
        {comment === undefined ? null : (
          <div className="cmt">
            <div className="cwho">
              {comment.login} · {relativeTime(comment.at, now)}
            </div>
            <Markdown markdown={comment.body} />
          </div>
        )}
        {rest <= 0 ? null : (
          <p className="cmt more">
            {rest} more comment{rest === 1 ? '' : 's'} · read {HOSTS[host].where}
          </p>
        )}
      </div>

      {session === undefined ? null : (
        <p className="taken-note">
          Already picked up here
          {session.title === undefined ? null : (
            <>
              {' · '}
              <b>{session.title}</b>
            </>
          )}
        </p>
      )}

      <div className="rfoot">
        {session === undefined ? (
          <>
            <button className="primary" disabled={busy} onClick={() => onAlign(row, 'align')}>
              Align<span className="k">⏎</span>
            </button>
            <button disabled={busy} onClick={() => onAlign(row, 'quick-align')}>
              Quick align<span className="k">⇧⏎</span>
            </button>
          </>
        ) : (
          <>
            <button className="primary" onClick={() => onOpenSession(session.id)}>
              Open session
            </button>
            {/* Nearly always a misclick, and still available: a second angle on
                one issue is the user's call, not the board's. */}
            <button disabled={busy} onClick={() => onAlign(row, 'align')}>
              Align again
            </button>
          </>
        )}
        <button className="browse" onClick={() => onOpenIssue(row)}>
          Open {HOSTS[host].where} {keyLabel('⌘⏎')}
        </button>
      </div>
    </>
  )
}

function Labels({ labels }: { readonly labels: readonly IssueLabel[] }): React.JSX.Element {
  return (
    <span className="labels">
      {labels.map((label) => (
        <i
          key={label.name}
          style={
            label.color === undefined
              ? undefined
              : {
                  color: `#${label.color}`,
                  borderColor: `color-mix(in srgb, #${label.color} 45%, transparent)`
                }
          }
        >
          {label.name}
        </i>
      ))}
    </span>
  )
}

function rowId(reference: string): string {
  return `issue-row-${reference}`
}

/** How this host names one issue: `#341`, or the key itself. */
function named(row: IssueRow, host: HostKind): string {
  return host === 'jira' ? row.reference : `#${row.number}`
}

/** Who is on it: you by name, somebody else by theirs, and a dash for nobody. */
function who(row: IssueRow, login: string): string {
  if (row.assignees.length === 0) return '—'
  if (row.assignees.includes(login)) return 'you'
  return row.assignees[0] ?? '—'
}

/** Number, title and labels: what a person would type looking for one issue. */
function matches(row: IssueRow, wanted: string): boolean {
  if (wanted === '') return true
  const haystack = [
    // The reference matches whichever form the host writes it in.
    row.reference,
    `#${row.number}`,
    row.title,
    ...row.labels.map((label) => label.name),
    ...row.assignees
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(wanted)
}

function comments(count: number): string {
  if (count === 0) return 'no comments'
  return `${count} comment${count === 1 ? '' : 's'}`
}
