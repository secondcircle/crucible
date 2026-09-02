import { useEffect, useRef, useState } from 'react'
import type { ShownLocation } from './exhibit-location'

/** How long "copied" stands in the row. The mock's 900ms. */
const COPIED_MS = 900

/** The address row: where the active tab's exhibit is, and the one refresh control. */
export function AddressRow({
  location,
  onCopy,
  onRefresh
}: {
  readonly location: ShownLocation
  /** Handed the whole location, so what is copied cannot be what was displayed. */
  readonly onCopy: (whole: string) => void
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
