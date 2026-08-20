import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  BoardGroupId,
  BoardRow,
  BranchBoardSnapshot
} from '../../../shared/workspace/service'
import { boardAge, branchAge } from '../labels'
import './branch-board.css'

// The board reports and never acts on the repository: no delete, no checkout,
// no push, and no control that could grow into one.

/** The fixed order, and the only order. */
const GROUPS: readonly BoardGroupId[] = [
  'landed',
  'inFlight',
  'waitingOnYou',
  'localOnly',
  'stale'
]

const GROUP_NAMES: Readonly<Record<BoardGroupId, string>> = {
  landed: 'Landed',
  inFlight: 'In flight',
  waitingOnYou: 'Waiting on you',
  localOnly: 'Local only',
  stale: 'Stale'
}

/** The age line reads as a clock while the board is open. */
const TICK_MS = 1000

export function BranchBoard({
  board,
  refreshing,
  failure,
  hasSession,
  onRefresh,
  onOpenPr,
  onCopy,
  onAsk,
  onClose
}: {
  // Absent until the first collection for this workspace answers, which is
  // what the board says rather than showing an empty one.
  readonly board?: BranchBoardSnapshot
  readonly refreshing: boolean
  /** What the last collection failed with; the snapshot on screen still stands. */
  readonly failure?: string
  readonly hasSession: boolean
  readonly onRefresh: () => void
  readonly onOpenPr: (row: BoardRow) => void
  readonly onCopy: (name: string) => void
  readonly onAsk: (names: readonly string[]) => void
  readonly onClose: () => void
}): React.JSX.Element {
  // The widening lasts exactly as long as the board is open, which is what
  // makes it a look rather than a setting.
  const [scope, setScope] = useState<'yours' | 'all'>('yours')
  const [focused, setFocused] = useState<string | undefined>(undefined)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [now, setNow] = useState(() => Date.now())
  // What the last keystroke did, when it did nothing visible on its own. The
  // footer is where this board answers its keys, so a refusal answers there
  // too rather than passing in silence (ADR 0010).
  const [said, setSaid] = useState<string | undefined>(undefined)
  const overlay = useRef<HTMLElement>(null)

  const hosted = board?.host?.reachable === true
  const trunk = board?.trunk ?? ''

  const groups = useMemo(() => {
    const rows = board?.rows ?? []
    // Somebody else's pull request naming you is yours to answer whatever the
    // scope says, so it shows in both.
    const visible = rows.filter(
      (row) => scope === 'all' || row.yours || row.group === 'waitingOnYou'
    )
    return GROUPS.map((id) => ({
      id,
      // Most recently touched first, which is the board's own order and not
      // something the snapshot has to have arrived in.
      rows: visible
        .filter((row) => row.group === id)
        .sort((left, right) => touched(right) - touched(left))
    })).filter((group) => group.rows.length > 0)
  }, [board, scope])

  // One walk gives what is on screen and the order the arrows move in, so the
  // two can never disagree.
  const order = useMemo(() => groups.flatMap((group) => group.rows), [groups])
  // Selection and focus are kept by branch name, so both survive a refresh and
  // a row that left the board simply drops out of them.
  const chosen = useMemo(
    () => selected.filter((name) => order.some((row) => row.name === name)),
    [selected, order]
  )
  // The first row, until the person moves off it: derived rather than stored,
  // so a collection that drops the focused row cannot leave the ring nowhere.
  const focusedName =
    focused !== undefined && order.some((row) => row.name === focused)
      ? focused
      : order[0]?.name

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
  // never see an Enter meant for a pull request.
  useEffect(() => {
    function onKeyDown(pressed: KeyboardEvent): void {
      const at = order.findIndex((row) => row.name === focusedName)
      const row = at === -1 ? undefined : order[at]

      function claim(): void {
        pressed.preventDefault()
        pressed.stopPropagation()
      }

      if (pressed.key === 'ArrowDown' || pressed.key === 'ArrowUp') {
        claim()
        if (order.length === 0) return
        const next = Math.max(
          0,
          Math.min(order.length - 1, at + (pressed.key === 'ArrowDown' ? 1 : -1))
        )
        setFocused(order[next]?.name)
        setSaid(undefined)
        return
      }
      if (pressed.key === 'Enter' && (pressed.metaKey || pressed.ctrlKey)) {
        claim()
        // Nothing at all with no session: the entry already says so.
        if (chosen.length > 0 && hasSession) onAsk(chosen)
        return
      }
      if (pressed.key === 'Enter') {
        claim()
        if (row === undefined) return
        // The "no PR" cell cannot carry this on its own: a git-only board
        // drops that whole track, so on those rows Enter would answer with
        // nothing at all.
        if (row.pr === undefined) {
          setSaid(`${row.name} has no pull request to open`)
          return
        }
        setSaid(undefined)
        onOpenPr(row)
        return
      }
      if (pressed.key === ' ') {
        claim()
        if (row === undefined) return
        setSelected((current) =>
          current.includes(row.name)
            ? current.filter((name) => name !== row.name)
            : [...current, row.name]
        )
        return
      }
      if ((pressed.key === 'c' || pressed.key === 'C') && (pressed.metaKey || pressed.ctrlKey)) {
        claim()
        if (row !== undefined) onCopy(row.name)
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [order, focusedName, chosen, hasSession, onAsk, onOpenPr, onCopy])

  return (
    <section
      className="board branches"
      role="dialog"
      aria-label="Branch board"
      tabIndex={-1}
      ref={overlay}
    >
      <div className="bhead">
        <h1>Branches</h1>
        {board === undefined ? null : (
          <span className="repo">
            {board.repoLabel} · trunk <b>{trunk}</b> ·{' '}
            {hosted
              ? 'GitHub'
              : board.host === undefined
                ? 'no host connected'
                : 'GitHub unreachable — showing git only'}
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
            refreshed {boardAge(board.collectedAt, now)} ago
          </span>
          {/* The scope is a fact about what is on screen, so it is said on
              every board, hosted or not. */}
          <span className="scopeword">{scope === 'yours' ? 'yours only' : 'all branches'}</span>
          {scope === 'yours' ? (
            <button className="link" onClick={() => setScope('all')}>
              show everyone's
            </button>
          ) : null}
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
        </div>
      )}

      <div
        className="scroll"
        role="listbox"
        aria-label="Branches"
        aria-multiselectable="true"
        aria-activedescendant={focusedName === undefined ? undefined : rowId(focusedName)}
      >
        {board === undefined ? (
          <p className="reading">Reading branches…</p>
        ) : order.length === 0 ? (
          <p className="reading">
            {board.rows.length === 0
              ? `Nothing here but ${trunk}.`
              : "No branches of yours here — show everyone's to see the rest."}
          </p>
        ) : (
          groups.map((group) => (
            <div className="group" key={group.id} role="group" aria-label={GROUP_NAMES[group.id]}>
              <div className={`ghead ${group.id}`}>
                <h2>{GROUP_NAMES[group.id]}</h2>
                <span className="cnt">{group.rows.length}</span>
                <span className="why">{whyText(group.id, hosted, trunk)}</span>
              </div>
              {group.rows.map((row) => (
                <Row
                  key={row.name}
                  row={row}
                  trunk={trunk}
                  hosted={hosted}
                  now={now}
                  focused={row.name === focusedName}
                  selected={chosen.includes(row.name)}
                  onFocus={() => setFocused(row.name)}
                />
              ))}
            </div>
          ))
        )}
      </div>

      <div className="bfoot">
        <span>
          <kbd>⌘B</kbd> close
        </span>
        <span>
          <kbd>↑↓</kbd> move
        </span>
        {hosted ? (
          <span>
            <kbd>⏎</kbd> open PR in browser
          </span>
        ) : null}
        <span>
          <kbd>space</kbd> select
        </span>
        <span>
          <kbd>⌘C</kbd> copy branch name
        </span>
        {chosen.length === 0 ? null : (
          <span className={hasSession ? 'ask' : 'ask dim'}>
            <kbd>⌘⏎</kbd> ask about these
            {hasSession ? null : <span className="nosession"> · no session open</span>}
          </span>
        )}
        <span className="sp">
          {said ?? `${hosted ? 'git + GitHub via gh' : 'git only'} · nothing here is deleted for you`}
        </span>
      </div>
    </section>
  )
}

function Row({
  row,
  trunk,
  hosted,
  now,
  focused,
  selected,
  onFocus
}: {
  readonly row: BoardRow
  readonly trunk: string
  readonly hosted: boolean
  readonly now: number
  readonly focused: boolean
  readonly selected: boolean
  readonly onFocus: () => void
}): React.JSX.Element {
  const classes = [
    'row',
    hosted ? '' : 'nohost',
    row.group === 'landed' ? 'landed' : '',
    row.group === 'waitingOnYou' ? 'theirs' : '',
    focused ? 'focused' : '',
    selected ? 'selected' : ''
  ]
    .filter((name) => name !== '')
    .join(' ')

  return (
    // A click moves the focus ring and does nothing else: no double-click
    // action, and nothing on this board acts on the repository.
    <div
      className={classes}
      id={rowId(row.name)}
      role="option"
      aria-selected={selected}
      aria-label={row.name}
      onClick={onFocus}
    >
      <span className="cell name">
        <span className="txt">{row.name}</span>
        {row.checkedOut ? <span className="here">checked out</span> : null}
      </span>
      <span className="where">
        <i className={row.local ? 'on' : ''}>local</i>
        <i className={row.onOrigin ? 'on' : ''}>origin</i>
      </span>
      <span className="cell subj">{row.subject}</span>
      <span className="drift">{drift(row)}</span>
      <span className="age">{branchAge(row.touchedAt, now)}</span>
      {hosted ? (
        <span className={`cell signal ${tone(row)}`}>{signalText(row, trunk)}</span>
      ) : null}
      {hosted ? (
        <span className="pr">
          {row.pr === undefined ? (
            <span className="none">no PR</span>
          ) : (
            <>
              <span className="num">#{row.pr.number}</span>
              <span className={`st ${row.pr.state}`}>{row.pr.state}</span>
            </>
          )}
        </span>
      ) : null}
    </div>
  )
}

function rowId(name: string): string {
  return `board-row-${name}`
}

function touched(row: BoardRow): number {
  const at = new Date(row.touchedAt).getTime()
  return Number.isNaN(at) ? 0 : at
}

function drift(row: BoardRow): React.JSX.Element | string {
  if (row.drift.kind === 'squashed') return 'squashed'
  if (row.drift.kind === 'author') {
    return (
      <>
        by <b>{row.drift.login}</b>
      </>
    )
  }
  // A landed row is here because it is not ahead of the trunk, so that is the
  // whole of what the cell has to say.
  if (row.group === 'landed') {
    return (
      <>
        <b>{row.drift.ahead}</b> ahead
      </>
    )
  }
  return (
    <>
      <b>{row.drift.ahead}</b> ahead · <b>{row.drift.behind}</b> behind
    </>
  )
}

function signalText(row: BoardRow, trunk: string): string {
  const signal = row.signal
  if (signal === undefined) return ''
  switch (signal.kind) {
    case 'checksFailed':
      return `✕ ${signal.count} check${signal.count === 1 ? '' : 's'} failed`
    case 'checksRunning':
      return '◐ checks running'
    case 'checksPassed':
      return '✓ checks passed'
    case 'changesRequested':
      return 'changes requested'
    case 'yourReview':
      return 'your review'
    case 'assignedToYou':
      return 'assigned to you'
    case 'merged':
      return signal.byYou ? 'merged by you' : 'merged'
    case 'inTrunkHistory':
      return `in ${trunk}'s history`
  }
}

function tone(row: BoardRow): string {
  switch (row.signal?.kind) {
    case 'checksFailed':
      return 'fail'
    case 'checksRunning':
      return 'run'
    case 'checksPassed':
      return 'pass'
    case 'changesRequested':
    case 'yourReview':
    case 'assignedToYou':
      return 'need'
    default:
      return 'quiet'
  }
}

/** Why every row in this group is in it, said once at the top of the group. */
function whyText(group: BoardGroupId, hosted: boolean, trunk: string): string {
  switch (group) {
    case 'landed':
      return hosted
        ? `their PR merged, or their commits are in ${trunk} — nothing here holds unique work`
        : `their commits are in ${trunk}`
    case 'inFlight':
      return hosted
        ? 'open PRs of yours, and pushed work without one'
        : `pushed and not yet in ${trunk}`
    case 'waitingOnYou':
      return "someone else's PR that names you as reviewer or assignee — no branch in this clone"
    case 'localOnly':
      return 'never pushed — this clone is the only copy that exists'
    case 'stale':
      return 'untouched over 30 days and never landed — listed, never counted, never touched'
  }
}
