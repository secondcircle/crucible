import type { RailModel, RailRow } from '../runs/rail'
import './runs.css'

// The graph says which node ran when; this column says what moved between
// them. Nothing here acts on the run — a row opens the artifact reader and
// does nothing else.
export function ArtifactRail({
  rail,
  selected,
  onOpen
}: {
  readonly rail: RailModel
  /** Paths drawn as selected: the open artifact, else the shown node's outputs. */
  readonly selected: readonly string[]
  readonly onOpen: (path: string) => void
}): React.JSX.Element {
  const empty = rail.inputs.length === 0 && rail.produced.length === 0
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
      <div className="arlist">
        {empty ? <p className="arempty">This run declared no artifacts.</p> : null}
        {rail.inputs.length === 0 ? null : (
          <>
            <div className="argroup">Handed in at kickoff</div>
            {rail.inputs.map((row) => (
              <Row
                key={row.path}
                row={row}
                selected={selected.includes(row.path)}
                onOpen={onOpen}
              />
            ))}
          </>
        )}
        {rail.produced.length === 0 ? null : (
          <>
            <div className="argroup">Written by the run</div>
            {rail.produced.map((row) => (
              <Row
                key={row.path}
                row={row}
                selected={selected.includes(row.path)}
                onOpen={onOpen}
              />
            ))}
          </>
        )}
      </div>
      <div className="arnote">artifacts live in the run's own directory, never in the repo</div>
    </aside>
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
