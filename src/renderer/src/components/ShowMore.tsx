import type { MoreRows } from '../runs/page'

// The foot of a capped list of runs: it adds the next rows below the ones
// already drawn and says how many older ones are still held back.
export function ShowMore({
  more,
  onMore
}: {
  readonly more: MoreRows
  readonly onMore: () => void
}): React.JSX.Element {
  return (
    <button className="more" onClick={onMore}>
      Show {more.next} more <span className="older">· {more.older} older</span>
    </button>
  )
}
