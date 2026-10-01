import { useState } from 'react'
import type {
  CatalogEntry,
  QuotedPrompt,
  ReadAgent,
  SourceQuote,
  WorkflowReading,
  WorkspaceCatalog
} from '../../../shared/workflows/catalog'
import type { CatalogReaderSettings } from '../../../shared/workflows/catalog-settings'
import {
  modelFact,
  pastRuns,
  shownReading,
  type ModelFact
} from '../../../shared/workflows/catalog-facts'
import type { PlannedModel } from '../../../shared/workflows/catalog'
import type { RunRecord } from '../../../shared/workflows/run'
import {
  commitText,
  entryState,
  fileName,
  modelSource,
  modelText,
  readerText,
  scheduleText,
  targetText
} from '../catalog/format'
import { relativeTime } from '../labels'
import { money } from '../runs/format'
import './board-frame.css'
import './catalog.css'

// The workflow catalog: every workflow the workspace on screen can run, and
// for the one chosen, what it does, what it takes, which agents it starts on
// which models with which prompts, when it asks, what it gives back and how
// its runs have gone. Agents are roles, never a graph: the flow is told in
// prose. Every section says quietly where its facts came from — the manifest
// the engine read, a model's reading of the file, or the run records — so a
// reading is never mistaken for something the engine guarantees.

export function WorkflowCatalog({
  workspaceName,
  workspacePath,
  catalog,
  reader,
  runs,
  selected,
  onOpenSource,
  onClose
}: {
  readonly workspaceName: string
  readonly workspacePath: string
  /** What the catalog answered for this workspace; absent until it has. */
  readonly catalog?: WorkspaceCatalog
  readonly reader: CatalogReaderSettings
  readonly runs: readonly RunRecord[]
  /** The workflow whose page opens first. */
  readonly selected?: string
  /** Shows a file at a line in the session's context panel; absent where there is nowhere to. */
  readonly onOpenSource?: (path: string, line: number) => void
  readonly onClose: () => void
}): React.JSX.Element {
  const entries = catalog?.entries ?? []
  // A click chooses a file; until one does, the name the board was opened on
  // is looked for, which still finds it when the catalog answers after the
  // board is up.
  const [chosenPath, setChosenPath] = useState<string | undefined>(undefined)
  const chosen =
    entries.find((entry) => entry.path === chosenPath) ??
    entries.find((entry) => entry.name === selected && entry.kind !== 'shadowed') ??
    entries[0]
  const workspace = entries.filter((entry) => entry.origin === 'workspace')
  const user = entries.filter((entry) => entry.origin === 'user')

  return (
    <section className="board catalog" role="dialog" aria-label="Workflow catalog">
      <div className="bhead">
        <h1>Workflows</h1>
        <span className="repo">
          in <b>{workspaceName}</b>
        </span>
        <button className="x" onClick={onClose}>
          Close <kbd>esc</kbd>
        </button>
      </div>

      <div className="bsub">
        <span>What each workflow does, read from its file</span>
        <span className="readby">read by {readerText(reader)}</span>
      </div>

      <div className="split">
        <nav className="scroll list" aria-label="Workflows">
          {catalog === undefined ? (
            <p className="reading">Reading this workspace’s workflow folders…</p>
          ) : entries.length === 0 ? (
            <p className="reading">
              No workflows here. A workflow is a TypeScript file in this workspace’s
              .crucible/workflows folder or in ~/.crucible/workflows.
            </p>
          ) : (
            <>
              <Group title="This workspace" entries={workspace} chosen={chosen} onChoose={setChosenPath} />
              <Group title="Yours, from ~/.crucible" entries={user} chosen={chosen} onChoose={setChosenPath} />
            </>
          )}
        </nav>

        {chosen === undefined ? (
          <article className="page" aria-label="Workflow page">
            <p className="quiet">Nothing to show yet.</p>
          </article>
        ) : (
          <Page
            key={chosen.path}
            entry={chosen}
            reader={reader}
            runs={runs}
            workspacePath={workspacePath}
            onOpenSource={onOpenSource}
          />
        )}
      </div>
    </section>
  )
}

function Group({
  title,
  entries,
  chosen,
  onChoose
}: {
  readonly title: string
  readonly entries: readonly CatalogEntry[]
  readonly chosen?: CatalogEntry
  readonly onChoose: (path: string) => void
}): React.JSX.Element | null {
  if (entries.length === 0) return null
  return (
    <div className="group" aria-label={title}>
      <div className="ghead">
        <h2>{title}</h2>
        <span className="cnt">{entries.length}</span>
      </div>
      {entries.map((entry) => {
        const state = entryState(entry)
        return (
          <button
            key={entry.path}
            className={`wrow${entry.path === chosen?.path ? ' focused' : ''}${entry.kind === 'shadowed' ? ' off' : ''}`}
            aria-label={`Workflow ${entry.name}${entry.kind === 'shadowed' ? ' (shadowed)' : ''}`}
            aria-current={entry.path === chosen?.path ? 'true' : undefined}
            onClick={() => onChoose(entry.path)}
          >
            <span className="wname">{entry.name}</span>
            <span className="wdesc">
              {entry.kind === 'workflow'
                ? entry.manifest.description
                : entry.kind === 'broken'
                  ? 'does not load'
                  : `${fileName(entry.winner)} in this workspace wins`}
            </span>
            {state === undefined ? null : (
              <span className={`wstate ${state}`}>
                {state === 'reading' ? <span className="spin" aria-hidden="true" /> : null}
                {state}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/** The quiet tag a section carries, saying where its facts came from. */
function Source({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return <span className="source">{children}</span>
}

function Page({
  entry,
  reader,
  runs,
  workspacePath,
  onOpenSource
}: {
  readonly entry: CatalogEntry
  readonly reader: CatalogReaderSettings
  readonly runs: readonly RunRecord[]
  readonly workspacePath: string
  readonly onOpenSource?: (path: string, line: number) => void
}): React.JSX.Element {
  const head = (
    <div className="phead">
      <h2>{entry.name}</h2>
      <span className="origin">{entry.origin}</span>
      <SourceLink path={entry.path} line={1} onOpenSource={onOpenSource} />
    </div>
  )

  if (entry.kind === 'shadowed') {
    return (
      <article className="page" aria-label={`Workflow ${entry.name}`}>
        {head}
        <div className="note warn">
          Shadowed. <code>{entry.winner}</code> has the same name and wins in this workspace, so
          nothing started here runs this file.
        </div>
      </article>
    )
  }

  if (entry.kind === 'broken') {
    return (
      <article className="page" aria-label={`Workflow ${entry.name}`}>
        {head}
        <div className="note bad" role="alert">
          <b>This file does not load</b>, so no run can start it.
          <pre>{entry.error}</pre>
        </div>
      </article>
    )
  }

  const state = entry.reading
  const reading = shownReading(state, reader)
  const readBy = reading === undefined ? undefined : `read by ${readerText(reading.reader)}`
  const past = pastRuns(runs, workspacePath, entry.name)
  const inputs = Object.entries(entry.manifest.inputs)

  return (
    <article className="page" aria-label={`Workflow ${entry.name}`}>
      {head}

      {state.status === 'failed' ? (
        <div className="note bad" role="alert">
          The last reading failed and is tried again when the file next changes: {state.error}
          {reading === undefined ? null : <span className="quiet"> The reading below is the last good one.</span>}
        </div>
      ) : null}

      <Section title="What it does" source={readBy ?? 'from the manifest'}>
        {reading === undefined ? (
          <p>
            {entry.manifest.description}
            {state.status === 'reading' ? <ReadingNote /> : null}
          </p>
        ) : (
          <p className="summary">
            {reading.summary}
            {state.status === 'reading' ? <ReadingNote again /> : null}
          </p>
        )}
      </Section>

      <Section title="What you give it" source="from the manifest">
        {inputs.length === 0 ? (
          <p className="quiet">Nothing. It takes no inputs.</p>
        ) : (
          <dl className="facts">
            {inputs.map(([name, what]) => (
              <div key={name}>
                <dt>
                  <code>{name}</code>
                </dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
        )}
      </Section>

      <Section title="Where it works" source="from the manifest">
        <p>{targetText(entry.manifest)}</p>
        <p>{commitText(entry.manifest)}</p>
      </Section>

      {entry.manifest.schedule === undefined ? null : (
        <Section title="Schedule" source="from the manifest">
          <p>Fires {scheduleText(entry.manifest.schedule)}.</p>
        </Section>
      )}

      <Section title="Agents" source={readBy ?? 'reading'}>
        {reading === undefined ? (
          <p className="quiet">The agents are named once the file has been read.</p>
        ) : reading.agents.length === 0 ? (
          <p className="quiet">It starts no agents; its own code does all the work.</p>
        ) : (
          <div className="agents">
            {reading.agents.map((agent) => (
              <Agent
                key={agent.role}
                agent={agent}
                fact={modelFact(agent, entry.plan)}
                plan={entry.plan}
                onOpenSource={onOpenSource}
              />
            ))}
          </div>
        )}
      </Section>

      {reading === undefined ? null : (
        <>
          <Section title="How a run goes" source={readBy}>
            <ol className="steps">
              {reading.steps.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
          </Section>

          <Section title="When it stops to ask you" source={readBy}>
            {reading.stops.length === 0 ? (
              <p className="quiet">Never. It runs to the end without asking the session that started it.</p>
            ) : (
              <ul className="plain">
                {reading.stops.map((stop, index) => (
                  <li key={index}>{stop}</li>
                ))}
              </ul>
            )}
          </Section>

          <Returns reading={reading} source={readBy} />
        </>
      )}

      <Section title="Past runs" source="from run records">
        {past.count === 0 ? (
          <p className="quiet">It has not run in this workspace yet.</p>
        ) : (
          <>
            <p>
              {past.count} run{past.count === 1 ? '' : 's'} in this workspace
              {past.typicalSpend === undefined ? '' : ` · typically ${money(past.typicalSpend)} each`}
            </p>
            <div className="recent">
              {past.recent.map((run) => (
                <span key={run.id} className={`outcome ${run.status}`} title={`run ${run.id}`}>
                  {run.status} · {relativeTime(run.endedAt ?? run.createdAt)}
                </span>
              ))}
            </div>
          </>
        )}
      </Section>
    </article>
  )
}

function ReadingNote({ again = false }: { readonly again?: boolean }): React.JSX.Element {
  return (
    <span className="readingnote" role="status">
      <span className="spin" aria-hidden="true" />
      {again ? 'the file changed — reading it again' : 'reading the file'}
    </span>
  )
}

function Section({
  title,
  source,
  children
}: {
  readonly title: string
  readonly source?: string
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="psec" aria-label={title}>
      <div className="ghead">
        <h2>{title}</h2>
        {source === undefined ? null : <Source>{source}</Source>}
      </div>
      {children}
    </section>
  )
}

function Returns({
  reading,
  source
}: {
  readonly reading: WorkflowReading
  readonly source?: string
}): React.JSX.Element {
  const { artifacts, branch, report } = reading.returns
  return (
    <Section title="What you get back" source={source}>
      <dl className="facts">
        {artifacts.map((artifact) => (
          <div key={artifact.file}>
            <dt>
              <code>{artifact.file}</code>
            </dt>
            <dd>{artifact.what}</dd>
          </div>
        ))}
        <div>
          <dt>branch</dt>
          <dd>{branch ?? 'nothing worth naming'}</dd>
        </div>
        <div>
          <dt>report</dt>
          <dd>{report}</dd>
        </div>
      </dl>
    </Section>
  )
}

function Agent({
  agent,
  fact,
  plan,
  onOpenSource
}: {
  readonly agent: ReadAgent
  readonly fact: ModelFact
  readonly plan?: readonly PlannedModel[]
  readonly onOpenSource?: (path: string, line: number) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const quote = fact.kind === 'named' ? fact.quote : undefined
  return (
    <div className={`agent${open ? ' open' : ''}`}>
      <button
        className="ahead"
        aria-expanded={open}
        aria-label={`Agent ${agent.role}`}
        onClick={() => setOpen(!open)}
      >
        <span className="chev" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="role">{agent.role}</span>
        <span className="nodes">{agent.nodes.join(', ')}</span>
        <span className="model">
          <b>{modelText(fact.model)}</b>
          <span className={`msrc${fact.kind === 'default' ? ' default' : ''}`}>{modelSource(fact)}</span>
        </span>
      </button>
      <p className="does">{agent.does}</p>
      {open ? (
        <div className="abody">
          <div className="mline">
            Model <b>{fact.model}</b>
            {fact.kind === 'default' ? (
              <span className="quiet"> — the engine’s default; the workflow names none</span>
            ) : fact.from === 'manifest' ? (
              <span className="quiet"> — forecast by plan() in the manifest</span>
            ) : null}
            {quote === undefined ? null : (
              <SourceLink path={quote.file} line={quote.start} onOpenSource={onOpenSource} />
            )}
            {fact.overruled === undefined ? null : (
              <span className="quiet">
                {' '}
                · the reading said {fact.overruled}; {plan === undefined ? 'the manifest' : 'plan()'} wins
              </span>
            )}
          </div>
          <Prompt title="System prompt" prompt={agent.system} onOpenSource={onOpenSource} />
          <Prompt title="Task prompt" prompt={agent.prompt} onOpenSource={onOpenSource} />
        </div>
      ) : null}
    </div>
  )
}

function Prompt({
  title,
  prompt,
  onOpenSource
}: {
  readonly title: string
  readonly prompt?: QuotedPrompt
  readonly onOpenSource?: (path: string, line: number) => void
}): React.JSX.Element {
  if (prompt === undefined) {
    return (
      <div className="prompt">
        <div className="qhead">
          {title} <span className="quiet">— none; the node gets Crucible’s short opening alone</span>
        </div>
      </div>
    )
  }
  return (
    <div className="prompt" aria-label={title}>
      <div className="qhead">
        {title} · <code>{prompt.name}</code>
        <SourceLink path={prompt.file} line={prompt.start} end={prompt.end} onOpenSource={onOpenSource} />
        <span className="legend">
          <mark className="fill">${'{…}'}</mark> filled in when the run starts the node
        </span>
      </div>
      <Quote quote={prompt} />
    </div>
  )
}

/** The lines exactly as the file has them, numbered, with what a run fills in marked. */
function Quote({ quote }: { readonly quote: SourceQuote }): React.JSX.Element {
  return (
    <pre className="quote">
      {quote.lines.map((line, index) => (
        <div className="ql" key={index}>
          <span className="ln">{quote.start + index}</span>
          <span className="lt">
            {line.map((segment, at) =>
              segment.filled ? (
                <mark className="fill" key={at}>
                  {segment.text}
                </mark>
              ) : (
                <span key={at}>{segment.text}</span>
              )
            )}
          </span>
        </div>
      ))}
    </pre>
  )
}

function SourceLink({
  path,
  line,
  end,
  onOpenSource
}: {
  readonly path: string
  readonly line: number
  readonly end?: number
  readonly onOpenSource?: (path: string, line: number) => void
}): React.JSX.Element {
  const label = `${fileName(path)}:${line}${end === undefined || end === line ? '' : `–${end}`}`
  return (
    <button
      className="srclink"
      title={
        onOpenSource === undefined
          ? `${path} — open a session to show it in the context panel`
          : `Show ${path} at line ${line} in the context panel`
      }
      disabled={onOpenSource === undefined}
      onClick={() => onOpenSource?.(path, line)}
    >
      {label}
    </button>
  )
}
