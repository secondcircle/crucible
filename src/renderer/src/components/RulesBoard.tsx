import { useEffect, useMemo, useState } from 'react'
import {
  formatDollars,
  formatTook,
  type Attention,
  type BoardScope,
  type BoardWindow,
  type FiringView,
  type RuleRow,
  type RulesBoard as Board
} from '../../../shared/rules/board'
import { ruleMessage, type RuleAction } from '../../../shared/rules/ledger'
import type { RulesService } from '../../../shared/rules/service'
import { relativeTime } from '../labels'
import { FiringColumns, FiringRow } from '../rules/FiringRow'
import { agentText, explainCommand, spotText } from '../rules/format'
import './board-frame.css'
import './rules.css'
import './rules-board.css'

// The rules board: every rule the workspace declares, what each was fed and
// decided, what came of it, and one firing read whole. It reports and never
// acts: no mode toggles, no dismissals, no resets, and reading it sends
// nothing to a judge or an agent.

/** Ages on the board read as a clock while it is open. */
const TICK_MS = 30_000

const WINDOWS: readonly { readonly window: BoardWindow; readonly label: string }[] = [
  { window: 'today', label: 'today' },
  { window: '7d', label: '7 days' },
  { window: '30d', label: '30 days' },
  { window: 'all', label: 'all' }
]

const ACTION_ORDER: readonly RuleAction[] = ['pass', 'log', 'note', 'escalate', 'block', 'hold']

const ACTION_TONE: Readonly<Record<RuleAction, string>> = {
  pass: 'pass',
  log: 'esc',
  note: 'note',
  escalate: 'esc',
  block: 'block',
  hold: 'hold'
}

export interface RulesBoardDoor {
  /** What the numbers count when the board opens. */
  readonly scope: BoardScope
  /** A firing to open on, from a mark, a chip or a row. */
  readonly firingId?: string
}

export function RulesBoard({
  service,
  workspaceName,
  workspacePath,
  door,
  session,
  run,
  sessionTitle,
  onOpenInConversation,
  onExplain,
  onCopy,
  onClose
}: {
  readonly service: RulesService
  readonly workspaceName: string
  readonly workspacePath: string
  readonly door: RulesBoardDoor
  /** The session on screen, which the scope switch can narrow to. */
  readonly session?: { readonly sessionId: string }
  /** The run the board was opened from, which the scope switch can narrow to. */
  readonly run?: { readonly runId: string }
  readonly sessionTitle: (sessionId: string) => string | undefined
  readonly onOpenInConversation: (view: FiringView) => void
  /** Absent when there is no session whose terminal could run it. */
  readonly onExplain?: (command: string) => void
  readonly onCopy: (text: string) => void
  readonly onClose: () => void
}): React.JSX.Element {
  const [scope, setScope] = useState<BoardScope>(door.scope)
  const [window, setWindow] = useState<BoardWindow>('7d')
  const [board, setBoard] = useState<{ readonly of: string; readonly board: Board } | undefined>(undefined)
  const [chosenRule, setChosenRule] = useState<string | undefined>(undefined)
  const [chosenFiring, setChosenFiring] = useState<string | undefined>(door.firingId)
  const [now, setNow] = useState(() => Date.now())
  const [asked, setAsked] = useState(0)

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(tick)
  }, [])

  // Any notice asks again: a worktree opened as a workspace reads its main
  // checkout's ledger, whose notices name that path rather than this one.
  useEffect(() => service.onEvent(() => setAsked((count) => count + 1)), [service])

  const of = JSON.stringify([workspacePath, scope, window])
  useEffect(() => {
    let current = true
    void service
      .board(workspacePath, scope, window)
      .then((answered) => {
        if (current) setBoard({ of, board: answered })
      })
      .catch(() => {
        // A ledger that cannot be read leaves the last answer standing.
      })
    return () => {
      current = false
    }
  }, [service, workspacePath, scope, window, of, asked])

  const shown = board?.board
  const rules = useMemo(() => shown?.rules ?? [], [shown])
  const opened = useMemo(
    () =>
      door.firingId === undefined
        ? undefined
        : rules.find((row) => row.firings.some((view) => view.firing.id === door.firingId))?.rule.name,
    [rules, door.firingId]
  )
  const selectedRow =
    rules.find((row) => row.rule.name === (chosenRule ?? opened)) ??
    rules.find((row) => row.firings.length > 0) ??
    rules[0]
  const firings = selectedRow?.firings ?? []
  const selected = firings.find((view) => view.firing.id === chosenFiring) ?? firings[0]

  function chooseRule(name: string): void {
    setChosenRule(name)
    setChosenFiring(undefined)
  }

  const scopes: readonly { readonly scope: BoardScope; readonly label: string }[] = [
    { scope: { kind: 'workspace' }, label: 'whole workspace' },
    ...(session === undefined
      ? []
      : [{ scope: { kind: 'session', sessionId: session.sessionId } as BoardScope, label: 'this session' }]),
    ...(run === undefined ? [] : [{ scope: { kind: 'run', runId: run.runId } as BoardScope, label: `run ${run.runId}` }])
  ]

  return (
    <section className="board rulesboard" role="dialog" aria-label="Rules board">
      <div className="bhead">
        <h1>Rules</h1>
        <span className="repo">
          in <b>{workspaceName}</b>
        </span>
        <button className="x" onClick={onClose}>
          Close <kbd>esc</kbd>
        </button>
      </div>

      <div className="bsub">
        <span>Declared by the repo</span>
        <span className="src">.crucible/rules/*.ts</span>
        <span className="seg scope" role="group" aria-label="What the numbers count">
          {scopes.map((option) => (
            <button
              key={option.label}
              aria-pressed={sameScope(option.scope, scope)}
              className={sameScope(option.scope, scope) ? 'on' : ''}
              onClick={() => setScope(option.scope)}
            >
              {option.label}
            </button>
          ))}
        </span>
        <span className="right">
          <span>window</span>
          <span className="seg" role="group" aria-label="Window">
            {WINDOWS.map((option) => (
              <button
                key={option.window}
                aria-pressed={option.window === window}
                className={option.window === window ? 'on' : ''}
                onClick={() => setWindow(option.window)}
              >
                {option.label}
              </button>
            ))}
          </span>
        </span>
      </div>

      <div className="split">
        <div className="scroll">
          {shown === undefined ? (
            <p className="reading">Reading this workspace's rules…</p>
          ) : (
            <>
              {shown.attention.length === 0 ? null : (
                <div className="group" aria-label="Needs attention">
                  <div className="ghead warn">
                    <h2>Needs attention</h2>
                    <span className="cnt">{shown.attention.length}</span>
                    <span className="why">a rule that cannot do its job — these light the chip; nothing else does</span>
                  </div>
                  {shown.attention.map((item) => (
                    <button
                      type="button"
                      className="hrow"
                      key={item.kind === 'rule' ? `rule:${item.rule}` : `judge:${item.model}`}
                      onClick={() => {
                        if (item.kind === 'rule') chooseRule(item.rule)
                      }}
                    >
                      <span className="what">
                        <span className="rn">{item.kind === 'rule' ? item.rule : item.model}</span>{' '}
                        <span className="desc">— {attentionText(item)}</span>
                      </span>
                      <span className="since">
                        {item.current ? `since ${relativeTime(item.kind === 'rule' ? item.since : item.from, now)}` : 'recovered'}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              <div className="group" aria-label="Rules">
                <div className="ghead">
                  <h2>Rules</h2>
                  <span className="cnt">{rules.length}</span>
                  <span className="why">
                    how often each is reached, what it decided, what came of it, and what it cost · click one for
                    its firings
                  </span>
                </div>
                {rules.length === 0 ? (
                  <p className="reading">No rule loaded yet. A rule is a file in .crucible/rules/.</p>
                ) : (
                  <>
                    <div className="rcolhead" aria-hidden="true">
                      <span>rule</span>
                      <span>reached</span>
                      <span>decided</span>
                      <span>came of it</span>
                      <span>took</span>
                      <span>cost</span>
                      <span>last</span>
                    </div>
                    {rules.map((row) => (
                      <RuleRowView
                        key={row.rule.name}
                        row={row}
                        now={now}
                        focused={row === selectedRow}
                        onClick={() => chooseRule(row.rule.name)}
                      />
                    ))}
                  </>
                )}
              </div>

              {selectedRow === undefined ? null : (
                <div className="group" aria-label={`Firings of ${selectedRow.rule.name}`}>
                  <div className="ghead">
                    <h2>Firings · {selectedRow.rule.name}</h2>
                    <span className="cnt">{firings.length}</span>
                    <span className="why">
                      everything the rule decided in this window, and the skips that mean something went wrong ·
                      newest first
                    </span>
                  </div>
                  {firings.length === 0 ? (
                    <p className="reading">Nothing fired here in this window.</p>
                  ) : (
                    <>
                      <FiringColumns />
                      {firings.map((view) => (
                        <FiringRow
                          key={view.firing.id}
                          view={view}
                          now={now}
                          focused={view === selected}
                          sessionTitle={sessionTitle}
                          onClick={() => setChosenFiring(view.firing.id)}
                        />
                      ))}
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <ReadingPane
          view={selected}
          now={now}
          sessionTitle={sessionTitle}
          onOpenInConversation={onOpenInConversation}
          {...(onExplain === undefined ? {} : { onExplain })}
          onCopy={onCopy}
        />
      </div>
    </section>
  )
}

function sameScope(a: BoardScope, b: BoardScope): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function attentionText(item: Attention): string {
  if (item.kind === 'rule') {
    return item.skips === 0
      ? item.message
      : `skipped ${item.skips} time${item.skips === 1 ? '' : 's'} on ${item.trigger} · ${item.message}`
  }
  const span = `${clock(item.from)}–${clock(item.to)}`
  return `unreachable ${span} · ${item.skips} firing${item.skips === 1 ? '' : 's'} fell back to ${item.fellBackTo}`
}

function clock(iso: string): string {
  const at = new Date(iso)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

function RuleRowView({
  row,
  now,
  focused,
  onClick
}: {
  readonly row: RuleRow
  readonly now: number
  readonly focused: boolean
  readonly onClick: () => void
}): React.JSX.Element {
  const { rule } = row
  const off = rule.running === 'off'
  const shadow = rule.running === 'shadow'
  const acted = ACTION_ORDER.filter((action) => (row.actions[action] ?? 0) > 0)
  const came = (['fixed', 'reworded', 'open', 'ignored'] as const).filter((outcome) => row.came[outcome] > 0)
  return (
    <button
      type="button"
      className={`rrow${off ? ' off' : ''}${focused ? ' focused' : ''}`}
      aria-label={`Rule ${rule.name}`}
      aria-current={focused ? 'true' : undefined}
      onClick={onClick}
    >
      <span className="rname">
        <span className={`mode ${rule.running}`}>{rule.running}</span>
        {rule.name} {rule.summary === '' ? null : <span className="desc">— {rule.summary}</span>}
      </span>
      {off ? (
        <>
          <span className={`rreach${rule.held?.broken === true ? ' err' : ''}`}>
            {rule.held === undefined ? '' : `⚠ ${rule.held.message}`}
          </span>
          <span className="racts" />
          <span className="rout" />
          <span className="rlat" />
          <span className="rcost" />
          <span className="rlast" />
        </>
      ) : (
        <>
          <span className={`rreach${row.broken > 0 ? ' err' : ''}`}>
            {row.broken > 0 ? (
              <>
                ⚠ {row.broken} skipped · broken
                <br />
              </>
            ) : null}
            <b>{row.admitted.toLocaleString()}</b> admitted
            <br />
            {rule.judge === undefined ? (
              <>
                <b>{row.decided.toLocaleString()}</b> decided · no judge
              </>
            ) : (
              <>
                <b>{row.judged.toLocaleString()}</b> judged · {row.nothingToJudge.toLocaleString()} nothing to judge
              </>
            )}
          </span>
          <span className="racts">
            {acted.length === 0
              ? '—'
              : acted.map((action, at) => (
                  <span key={action}>
                    {at === 0 ? '' : at === 2 ? <br /> : ' · '}
                    <b className={ACTION_TONE[action]}>
                      {row.actions[action]} {shadow && action !== 'pass' ? `would ${action}` : action}
                    </b>
                  </span>
                ))}
          </span>
          <span className="rout">
            {shadow ? (
              <>
                nothing delivered
                {row.came.fixed > 0 ? (
                  <>
                    <br />
                    <b className="fixed">{row.came.fixed}</b> fixed anyway
                  </>
                ) : null}
              </>
            ) : came.length === 0 ? (
              '—'
            ) : (
              came.map((outcome, at) => (
                <span key={outcome}>
                  {at === 0 ? '' : at === 2 ? <br /> : ' · '}
                  <b className={outcome}>
                    {row.came[outcome]} {outcome}
                  </b>
                </span>
              ))
            )}
          </span>
          <span className="rlat">
            {row.took === undefined ? (
              '—'
            ) : (
              <>
                <b>{formatTook(row.took.p50)}</b> p50
                <br />
                {formatTook(row.took.p95)} p95
              </>
            )}
          </span>
          <span className="rcost">
            {rule.judge === undefined ? (
              <b>$0</b>
            ) : (
              <>
                <b>{formatDollars(row.cost.dollars)}</b>
                <br />≈ {formatDollars(row.cost.perMonth)} /mo
              </>
            )}
          </span>
          <span className="rlast">{row.lastAt === undefined ? '—' : relativeTime(row.lastAt, now)}</span>
        </>
      )}
    </button>
  )
}

/** What the reading pane says about how a firing reached the agent. */
function deliveryPhrase(view: FiringView): string {
  const { firing } = view
  if (firing.skip !== undefined) return 'skipped · nothing delivered'
  if (firing.mode === 'shadow') return 'shadow · nothing delivered'
  switch (firing.delivery) {
    case 'inline':
      return `appended to the ${firing.change?.tool ?? firing.trigger} result`
    case 'steered':
      return 'steered in at the next tool boundary'
    case 'blocked':
      return 'refused the call, as its reason'
    case 'held':
      return 'held completion'
    case 'none':
      return firing.action === 'escalate' ? 'escalated · nothing delivered' : 'nothing delivered'
  }
}

function ReadingPane({
  view,
  now,
  sessionTitle,
  onOpenInConversation,
  onExplain,
  onCopy
}: {
  readonly view?: FiringView
  readonly now: number
  readonly sessionTitle: (sessionId: string) => string | undefined
  readonly onOpenInConversation: (view: FiringView) => void
  readonly onExplain?: (command: string) => void
  readonly onCopy: (text: string) => void
}): React.JSX.Element {
  if (view === undefined) {
    return (
      <aside className="read" aria-label="Firing">
        <div className="rbody">
          <p className="quiet">Choose a firing to read it whole.</p>
        </div>
      </aside>
    )
  }
  const { firing } = view
  const who = agentText(firing.agent, sessionTitle)
  const explain = explainCommand(firing)
  const wouldRead =
    firing.read === undefined && firing.feedback !== undefined ? ruleMessage(firing.rule, view.source, firing.feedback) : undefined
  return (
    <aside className="read" aria-label="Firing">
      <div className="rhead">
        <div className="meta">
          <span>{firing.rule}</span>
          <span className={`st ${firing.skip === undefined ? firing.action : 'skip'}`}>
            {firing.skip === undefined ? (firing.mode === 'shadow' ? `WOULD ${firing.action.toUpperCase()}` : firing.action.toUpperCase()) : 'SKIPPED'}
          </span>
          <span>
            {firing.delivery === 'none' ? 'not delivered' : firing.delivery} · {formatTook(firing.tookMs)}
          </span>
          <span>
            {who.run === undefined ? '' : `${who.run} · `}
            {who.text} · {relativeTime(firing.at, now)}
          </span>
        </div>
        <h3>
          <span className="path">{spotText(firing)}</span>
          {firing.skip === undefined ? null : <> — {firing.skip.message}</>}
        </h3>
      </div>
      <div className="rbody">
        <div className="sec" aria-label="What was judged">
          <h4>
            What was judged
            {firing.change === undefined ? null : (
              <span className="r">
                {firing.change.tool} · {firing.change.added} line{firing.change.added === 1 ? '' : 's'} added
                {firing.change.removed > 0 ? ` · ${firing.change.removed} removed` : ''}
              </span>
            )}
          </h4>
          {firing.item === undefined ? (
            <div className="codebox">{firing.where}</div>
          ) : firing.item.excerpt !== undefined ? (
            <div className="codebox">
              {firing.item.excerpt.before === '' ? null : `${firing.item.excerpt.before}\n`}
              <span className="hl">{firing.item.excerpt.focus}</span>
              {firing.item.excerpt.after === '' ? null : `\n${firing.item.excerpt.after}`}
            </div>
          ) : (
            <div className="codebox">
              {typeof firing.item.state === 'string' ? firing.item.state : JSON.stringify(firing.item.state, null, 2)}
            </div>
          )}
        </div>

        <div className="sec" aria-label="What the judge said">
          <h4>
            What the judge said
            {firing.judged === undefined ? null : (
              <span className="r">
                {firing.judged.model} · {firing.judged.tokens.toLocaleString()} tokens ·{' '}
                {formatDollars(firing.judged.cached ? 0 : firing.judged.dollars)} ·{' '}
                {firing.judged.cached ? 'cached' : formatTook(firing.judged.ms)}
              </span>
            )}
          </h4>
          {firing.judged === undefined ? (
            <p className="quiet">
              {firing.skip?.kind === 'judge-unreachable'
                ? firing.skip.message
                : 'No judge was asked: the rule decided from the item alone.'}
            </p>
          ) : (
            <Answers answers={firing.judged.answers} />
          )}
          <div className="facts">
            decided <b>{firing.action}</b>
            {firing.bounced === true ? ' · noted twice already on this key, so escalated' : ''}
          </div>
        </div>

        <div className="sec" aria-label="What the agent read">
          <h4>
            What the agent read <span className="r">{deliveryPhrase(view)}</span>
          </h4>
          {firing.read !== undefined ? (
            <div className="fb">
              <div className="who">§ {firing.rule} · rule {firing.action}</div>
              {firing.read}
            </div>
          ) : wouldRead !== undefined ? (
            <div className="fb would">
              <div className="who">§ {firing.rule} · would have read</div>
              {wouldRead}
            </div>
          ) : (
            <p className="quiet">Nothing: {firing.action === 'pass' ? 'a pass says nothing.' : 'there was nothing to say.'}</p>
          )}
        </div>

        <div className="sec" aria-label="What the agent did next">
          <h4>
            What the agent did next
            {view.reaction === undefined ? null : <span className="r">{formatTook(view.reaction.afterMs)} later</span>}
          </h4>
          {view.reaction === undefined ? (
            <p className="quiet">Nothing recorded yet.</p>
          ) : (
            <div className="react">
              {view.reaction.said === undefined ? null : (
                <div className="line">
                  <span className="k">said</span>
                  <span className="v">"{view.reaction.said}"</span>
                </div>
              )}
              {view.reaction.then === undefined ? null : (
                <>
                  <div className="line">
                    <span className="k">then</span>
                    <span className="v">
                      {view.reaction.then.tool} {view.reaction.then.path}
                    </span>
                  </div>
                  <div className="codebox">
                    {view.reaction.then.diff.split('\n').map((line, at) => (
                      <span
                        key={at}
                        className={line.startsWith('- ') ? 'del' : line.startsWith('+ ') ? 'add' : undefined}
                      >
                        {line}
                        {'\n'}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div className="sec" aria-label="What came of it">
          <h4>What came of it</h4>
          <div className="facts">
            {view.came === undefined ? (
              firing.action === 'block' && firing.delivery === 'blocked' ? (
                'the call was refused'
              ) : (
                'nothing is followed on a firing like this'
              )
            ) : (
              <>
                outcome <b>{view.came.outcome}</b>
                {view.came.how === undefined ? ' · still there' : ` · ${view.came.how}`}
              </>
            )}
            {firing.item === undefined ? null : (
              <>
                <br />
                key <b>{shortKey(firing.item.key)}</b>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="rfoot">
        <button className="act primary" onClick={() => onOpenInConversation(view)}>
          Open in the conversation →
        </button>
        <button
          className="act"
          disabled={explain === undefined || onExplain === undefined}
          onClick={() => {
            if (explain !== undefined) onExplain?.(explain)
          }}
        >
          Explain in terminal
        </button>
        <button
          className="act quiet"
          disabled={firing.item === undefined}
          onClick={() => {
            if (firing.item !== undefined) onCopy(firing.item.key)
          }}
        >
          Copy key
        </button>
      </div>
    </aside>
  )
}

function shortKey(key: string): string {
  return key.length <= 12 ? key : `${key.slice(0, 4)}…${key.slice(-3)}`
}

interface Probabilities {
  readonly probabilities?: Readonly<Record<string, number>>
  readonly noul?: number
  readonly choice?: string
}

/** Every answer the judge gave, every option's probability, the winner lit. */
function Answers({ answers }: { readonly answers: Readonly<Record<string, unknown>> }): React.JSX.Element {
  const questions = Object.entries(answers)
  return (
    <div className="probs">
      {questions.map(([question, raw]) => {
        const answer = raw as Probabilities
        const options: [string, number][] =
          answer.probabilities !== undefined
            ? Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1])
            : answer.noul !== undefined
              ? [
                  ['yes', answer.noul],
                  ['no', 1 - answer.noul]
                ]
              : []
        const top = options[0]?.[0]
        return (
          <div key={question} className="question">
            {questions.length === 1 ? null : <div className="qname">{question}</div>}
            {options.map(([option, p]) => (
              <div key={option} className={`prob${option === top ? ' lead' : ''}`}>
                <span>{option}</span>
                <span className="bar">
                  <i style={{ width: `${Math.round(p * 100)}%` }} />
                </span>
                <span>{p.toFixed(2)}</span>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
