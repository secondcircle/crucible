import type { RailModel, RailRow, RailScope } from '../runs/rail'
import './runs.css'

// The graph says which node ran when; this column says what moved between
// them, for the node the graph has picked or for the whole run. Nothing here
// acts on the run — a row opens the artifact reader and does nothing else.
export function ArtifactRail({
  rail,
  openArtifact,
  onScope,
  onOpen
}: {
  readonly rail: RailModel
  /** The path the reader is showing, which is the one row drawn outlined. */
  readonly openArtifact: string | undefined
  // Throws the scope switch. Absent when there is no node scope to throw it
  // to — a run with no nodes — and then no switch is drawn.
  readonly onScope: ((scope: RailScope) => void) | undefined
  readonly onOpen: (path: string) => void
}): React.JSX.Element {
  const groups = groupsOf(rail)
  return (
    <aside className="arail" aria-label="Artifacts">
      <div className="arhead">
        <span className="t">Artifacts</span>
        {rail.declared === 0 ? null : (
          <span className="c">
            {rail.written} of {rail.declared} written
          </span>
        )}
      </div>
      {onScope === undefined ? null : (
        <div className="arscope" role="group" aria-label="Rail scope">
          <Scope
            on={rail.scope === 'this-node'}
            scope="this-node"
            label="this node"
            onScope={onScope}
          />
          <Scope
            on={rail.scope === 'whole-run'}
            scope="whole-run"
            label="whole run"
            onScope={onScope}
          />
        </div>
      )}
      <div className="arlist">
        {groups.every((group) => group.rows.length === 0) ? (
          <p className="arempty">{emptyWords(rail)}</p>
        ) : null}
        {groups.map((group) => (
          <Group
            key={group.key}
            heading={group.heading}
            rows={group.rows}
            openArtifact={openArtifact}
            onOpen={onOpen}
          />
        ))}
      </div>
      <div className="arnote">artifacts live in the run's own directory, never in the repo</div>
    </aside>
  )
}

/** One headed stretch of the list; a group with no rows is not drawn. */
interface RailGroup {
  readonly key: string
  readonly heading: React.ReactNode
  readonly rows: readonly RailRow[]
}

/** The groups of one scope, in the order the rail stacks them. */
function groupsOf(rail: RailModel): readonly RailGroup[] {
  if (rail.scope === 'whole-run') {
    return [
      { key: 'inputs', heading: 'Handed in at kickoff', rows: rail.inputs },
      { key: 'produced', heading: 'Written by the run', rows: rail.produced }
    ]
  }
  return [
    {
      key: 'made',
      heading: (
        <>
          Made by <b>{rail.node}</b>
        </>
      ),
      rows: rail.made
    },
    { key: 'took', heading: 'Took', rows: rail.took }
  ]
}

function emptyWords(rail: RailModel): React.JSX.Element {
  if (rail.scope === 'whole-run') return <>This run declared no artifacts.</>
  return (
    <>
      <b>{rail.node}</b> declared no artifacts: nothing to take, nothing to make.
    </>
  )
}

function Scope({
  on,
  scope,
  label,
  onScope
}: {
  readonly on: boolean
  readonly scope: RailScope
  readonly label: string
  readonly onScope: (scope: RailScope) => void
}): React.JSX.Element {
  return (
    <button className={on ? 'on' : ''} aria-pressed={on} onClick={() => onScope(scope)}>
      {label}
    </button>
  )
}

function Group({
  heading,
  rows,
  openArtifact,
  onOpen
}: {
  readonly heading: React.ReactNode
  readonly rows: readonly RailRow[]
  readonly openArtifact: string | undefined
  readonly onOpen: (path: string) => void
}): React.JSX.Element | null {
  if (rows.length === 0) return null
  return (
    <>
      <div className="argroup">{heading}</div>
      {rows.map((row) => (
        <Row
          key={row.path}
          row={row}
          selected={row.path === openArtifact}
          onOpen={onOpen}
        />
      ))}
    </>
  )
}

function Row({
  row,
  selected,
  onOpen
}: {
  readonly row: RailRow
  readonly selected: boolean
  readonly onOpen: (path: string) => void
}): React.JSX.Element {
  return (
    <button
      className={`art ${rowClass(row)}${selected ? ' sel' : ''}`}
      {...(selected ? { 'aria-current': true as const } : {})}
      onClick={() => onOpen(row.path)}
    >
      <span className="atop">
        <span className="s" />
        <span className="nm">{row.name}</span>
        <span className="by">{row.kind === 'input' ? 'input' : row.producer}</span>
      </span>
      {row.desc === undefined ? null : <span className="desc">{row.desc}</span>}
      <Flow row={row} />
    </button>
  )
}

function Flow({ row }: { readonly row: RailRow }): React.JSX.Element | null {
  if (row.state === 'never') return <span className="flow">never written</span>
  if (row.state !== 'written') {
    return <span className="flow">not written yet · node {row.producerStatus}</span>
  }
  if (row.readers.length === 0) return null
  return (
    <span className="flow">
      read by{' '}
      {row.readers.map((reader, at) => (
        <span key={reader}>
          {at === 0 ? '' : ', '}
          <b>{reader}</b>
        </span>
      ))}
    </span>
  )
}

function rowClass(row: RailRow): string {
  if (row.kind === 'input') return 'input'
  switch (row.state) {
    case 'written':
      return 'written'
    case 'live':
      return 'writing'
    case 'parked':
      return 'parked'
    case 'pending':
      return 'pending'
    default:
      return 'never'
  }
}
