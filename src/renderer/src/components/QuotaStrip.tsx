import { useMemo } from 'react'
import { quotaRows, type MeterView, type RowView } from '../quota/strip-model'
import type { QuotaView } from '../quota/use-quota'
import './quota-strip.css'

// One block for the whole app, the same numbers whichever session is open.
// Nothing here is clickable, focusable or hoverable, which is why the
// component takes no callbacks at all.

export function QuotaStrip({ snapshot, now }: QuotaView): React.JSX.Element | null {
  const rows = useMemo(() => quotaRows(snapshot, now), [snapshot, now])

  // The heading and the border go with the last provider: signed out of
  // everything looks like nothing at all.
  if (rows.length === 0) return null

  return (
    <div className="quota">
      {/* Reads SUBSCRIPTIONS on screen: the sidebar's label treatment
          uppercases it, as it does Workspaces above. */}
      <div className="qlabel">Subscriptions</div>
      {rows.map((row) => (
        <Row key={row.providerId} row={row} />
      ))}
    </div>
  )
}

function Row({ row }: { readonly row: RowView }): React.JSX.Element {
  return (
    <div className={row.state === 'stale' ? 'qrow qstale' : 'qrow'}>
      <div className="qline">
        <span>{row.name}</span>
        <span className="qreset">
          {row.right}
          {row.outWord === undefined ? null : (
            <>
              {row.right === '' ? '' : ' '}
              <span className="qout">{row.outWord}</span>
            </>
          )}
        </span>
      </div>
      {row.state === 'unknown' ? (
        <span className="qdash">—</span>
      ) : (
        row.meters.map((meter) => <Meter key={meter.key} meter={meter} />)
      )}
    </div>
  )
}

function Meter({ meter }: { readonly meter: MeterView }): React.JSX.Element {
  const emphasis = meter.level === 'normal' ? '' : ` ${meter.level}`
  return (
    // A dollar text is three times the width of a percent, so the monthly meter
    // sizes its number to the text and the bar takes what is left.
    <div className={meter.kind === 'monthly' ? 'qmeter qmonthly' : 'qmeter'}>
      <span className="qlbl">{meter.label}</span>
      <span className="qbar">
        {/* The exact percent; only the printed number is rounded. */}
        <i className={emphasis.trim()} style={{ width: `${meter.fillPercent}%` }} />
        {meter.tickPercent === undefined ? null : (
          <u style={{ left: `${meter.tickPercent}%` }} />
        )}
      </span>
      <span className={`qnum${emphasis}`}>{meter.text}</span>
    </div>
  )
}
