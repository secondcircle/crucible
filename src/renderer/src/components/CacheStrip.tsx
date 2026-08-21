import type { CacheHealth } from '../../../shared/cache/service'
import { missesText, moneyText, spanStart, stripLabel } from '../cache/format'
import './cache-strip.css'

// One block for the whole app, above the quota block and keeping the rail's
// gutter. It is the only clickable row at the foot of the sidebar: the quota
// strip beside it stays uninteractive, and this is a sibling of it rather
// than a row inside it.
//
// It renders at zero too. An absent strip would take the only door to the
// cache health view with it, and "no misses since Tuesday" is the answer the
// user most wants on a good day.
export function CacheStrip({
  health,
  onOpen
}: {
  /** Absent until the first read answers, and then no strip renders at all. */
  readonly health?: CacheHealth
  readonly onOpen: () => void
}): React.JSX.Element | null {
  if (health === undefined) return null

  const money = moneyText(health.count, health.dollars)

  return (
    <button className="cachestrip" aria-label={stripLabel(health.count)} onClick={onOpen}>
      <span className="cline">
        <span className="clabel">
          Cache · <b>{missesText(health.count)}</b>
        </span>
        {money === '' ? null : <span className="cmoney">{money}</span>}
      </span>
      {/* The number always states the span it covers: a bare count is a lie
          once resets exist. */}
      <span className="cwhen">since {spanStart(health.since)}</span>
    </button>
  )
}
