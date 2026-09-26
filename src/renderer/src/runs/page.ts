// A long list of runs opens on its newest rows and grows at the foot on
// request. Every record stays reachable: nothing is dropped, only held back
// until somebody asks for it.

/** How many rows a capped list opens on, and how many each "Show more" adds. */
export const RUN_PAGE = 20

/** The foot of a capped list: what the next click adds and what is still held back. */
export interface MoreRows {
  /** Never more than a page: the last batch says its real size. */
  readonly next: number
  readonly older: number
}

export interface Paged<T> {
  readonly rows: readonly T[]
  /** Absent when every row is drawn, so there is no foot to draw. */
  readonly more?: MoreRows
}

/** The first `shown` of `all`, and the foot when anything is left over. */
export function paged<T>(all: readonly T[], shown: number): Paged<T> {
  const rows = all.slice(0, Math.max(0, shown))
  const older = all.length - rows.length
  if (older <= 0) return { rows }
  return { rows, more: { next: Math.min(RUN_PAGE, older), older } }
}
