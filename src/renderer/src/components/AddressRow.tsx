import { useEffect, useRef, useState } from 'react'
import type { ShownLocation } from './exhibit-location'

/** How long a copy says so. Shared, so every copy here flashes for as long. */
export const COPIED_MS = 900

export function AddressRow({
  location,
  lines,
  source,
  onCopy,
  onReveal,
  onToggleSource,
  onRefresh
}: {
  readonly location: ShownLocation
  /** How many lines the file has. Absent for anything not read as text. */
  readonly lines?: number
  // Which of the two views this tab is showing, where it has both. Absent
  // means there is nothing to flip to and no toggle at all.
  readonly source?: 'source' | 'rendered'
  readonly onCopy: (whole: string) => void
  /** Absent for a tab with no file to reveal, and where there is no OS to ask. */
  readonly onReveal?: () => void
  readonly onToggleSource: (source: boolean) => void
  readonly onRefresh: () => void
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  // Counts clicks rather than spins: the glyph is keyed on it, so React
  // replaces the node and the animation restarts even mid-spin.
  const [spins, setSpins] = useState(0)
  const flash = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(flash.current), [])

  return (
    <div className="where">
      <button
        className="loc"
        aria-label="Copy location"
        title={`Click to copy ${location.whole}`}
        onClick={() => {
          // The flash answers the click, not the write: a clipboard that
          // refuses has nowhere in a 26px row to say so.
          setCopied(true)
          clearTimeout(flash.current)
          flash.current = setTimeout(() => setCopied(false), COPIED_MS)
          onCopy(location.whole)
        }}
      >
        <span className="head">{location.lead}</span>
        <b className="tail">{location.tail}</b>
        {copied ? <span className="copied">copied</span> : null}
      </button>
      {lines === undefined ? null : (
        <span className="lines">
          {lines} {lines === 1 ? 'line' : 'lines'}
        </span>
      )}
      {source === undefined ? null : (
        <button
          className="rowtool"
          aria-label={source === 'source' ? 'Show rendered' : 'Show source'}
          onClick={() => onToggleSource(source !== 'source')}
        >
          {source === 'source' ? 'rendered' : 'source'}
        </button>
      )}
      {onReveal === undefined ? null : (
        <button className="rowtool" aria-label="Reveal in file manager" onClick={onReveal}>
          <span aria-hidden="true">↗</span> reveal
        </button>
      )}
      <button
        className="refresh"
        aria-label="Refresh exhibit"
        onClick={() => {
          setSpins((played) => played + 1)
          onRefresh()
        }}
      >
        {/* The glyph alone spins: the box, its background and its hover shape
            never rotate. `turning`, not `spin`: `spin` is a global class in
            transcript.css that draws a ringed loading circle. */}
        <span key={spins} className={spins === 0 ? 'glyph' : 'glyph turning'}>
          ⟳
        </span>
      </button>
    </div>
  )
}
