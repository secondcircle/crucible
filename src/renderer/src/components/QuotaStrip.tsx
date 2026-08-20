import { useMemo } from 'react'
import { quotaRows, type MeterView, type RowView } from '../quota/strip-model'
import type { QuotaView } from '../quota/use-quota'
import './quota-strip.css'

// The quota strip: how much of each provider subscription this machine has
// spent, and whether the spending is outrunning the week. One block for the
// whole app, the same numbers whichever session is open.
//
// Nothing here is clickable, focusable or hoverable — no buttons, no links, no
// tooltips, no title attributes. The mock shows no affordance and the ruling
// forbids inventing one, so this component takes no callbacks at all.

export function QuotaStrip({ snapshot, now }: QuotaView): React.JSX.Element | null {
  const rows = useMemo(() => quotaRows(snapshot, now), [snapshot, now])

  // Zero rows means zero block: the heading and the border go with the last
  // provider. Signed out of everything looks like nothing at all.
  if (rows.length === 0) return null

  return (
    <div className="quota">
      {/* Reads SUBSCRIPTIONS on screen: the sidebar's own label treatment
          uppercases it, exactly as it does Workspaces above. */}
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
    <div className="qmeter">
      <span className="qlbl">{meter.label}</span>
      <span className="qbar">
        {/* The fill is the exact percent; only the printed number is rounded. */}
        <i className={emphasis.trim()} style={{ width: `${meter.fillPercent}%` }} />
        {meter.tickPercent === undefined ? null : (
          <u style={{ left: `${meter.tickPercent}%` }} />
        )}
      </span>
      <span className={`qnum${emphasis}`}>{meter.text}</span>
    </div>
  )
}
