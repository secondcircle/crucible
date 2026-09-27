import { targetFolder, type RunRecord } from '../../../shared/workflows/run'
import { paged, type MoreRows } from './page'

// ⌘R groups one workspace's runs by what each wants from you: running, needs
// you, done.

export type Band = 'running' | 'needsYou' | 'done'

/** Total over `RunStatus`: no run is unclassified, and none is in two bands. */
export function bandOf(run: RunRecord): Band {
  // A dismissed run is one the user has cleared: it asks for nothing, whatever
  // its status. The service only ever stamps a settled run, so this clause
  // cannot hide live work.
  if (run.dismissedAt !== undefined) return 'done'
  if (run.status === 'complete' || run.status === 'cancelled') return 'done'
  // A failed run is the one most likely to need a human, and a paused one is
  // stopped until somebody moves it. An interrupted run is exactly as loud as
  // a failed one: a deliberate act is the only thing that moves it either.
  if (run.status === 'failed' || run.status === 'paused' || run.status === 'interrupted') {
    return 'needsYou'
  }
  return run.waiting === true ? 'needsYou' : 'running'
}

// Written through `bandOf` so the sidebar and ⌘R cannot drift apart on whether
// a run is asking for something. Not `runIsLive`, which counts paused as live.
export function runIsWorking(run: RunRecord): boolean {
  return bandOf(run) === 'running'
}

export interface RunBand {
  readonly band: Band
  /** What the band head prints. */
  readonly name: string
  readonly runs: readonly RunRecord[]
}

const ORDER: readonly { readonly band: Band; readonly name: string }[] = [
  { band: 'running', name: 'Running' },
  { band: 'needsYou', name: 'Needs you' },
  { band: 'done', name: 'Done' }
]

// In the user's order, and an empty band is gone rather than drawn as a
// header with nothing under it.
export function bandsOf(runs: readonly RunRecord[]): readonly RunBand[] {
  return ORDER.map(({ band, name }) => ({
    band,
    name,
    runs: runs.filter((run) => bandOf(run) === band).sort(newestFirst(band))
  })).filter((held) => held.runs.length > 0)
}

/** A band as ⌘R draws it: the rows on screen, and what its head counts. */
export interface ShownBand {
  readonly band: Band
  readonly name: string
  readonly runs: readonly RunRecord[]
  // Every run in the band, or every match while filtering — never only what
  // is on screen, which would hide that more history exists.
  readonly count: number
  /** Only ever on Done, and only while older runs are held back. */
  readonly more?: MoreRows
}

export interface ShownBandsOptions {
  /** What the filter box holds; blank filters nothing. */
  readonly filter: string
  /** How many Done rows are drawn while the filter is blank. */
  readonly doneShown: number
  /** The title of the session a run reports to, when that session still exists. */
  readonly titleOf: (run: RunRecord) => string | undefined
}

// Done opens on its newest page and grows at the foot. Running and Needs you
// are never cut: those runs are asking for something. A filter searches all
// history, so it lifts the cap, and a band with no match is gone like an
// empty one.
export function shownBands(
  runs: readonly RunRecord[],
  { filter, doneShown, titleOf }: ShownBandsOptions
): readonly ShownBand[] {
  const needle = filter.trim().toLowerCase()
  const wanted =
    needle === '' ? runs : runs.filter((run) => runMatches(run, needle, titleOf(run)))
  return bandsOf(wanted).map((held) => {
    if (held.band !== 'done' || needle !== '') return { ...held, count: held.runs.length }
    const { rows, more } = paged(held.runs, doneShown)
    return {
      ...held,
      runs: rows,
      count: held.runs.length,
      ...(more === undefined ? {} : { more })
    }
  })
}

// The words a row shows, and only those: workflow, target repository, run id
// and session title. Case-insensitive, anywhere in the word. Not the
// workspace: every row in ⌘R is the one workspace's, so no row shows it.
export function runMatches(
  run: RunRecord,
  filter: string,
  sessionTitle: string | undefined
): boolean {
  const needle = filter.trim().toLowerCase()
  if (needle === '') return true
  return [run.workflow, targetFolder(run), run.id, sessionTitle].some(
    (field) => field !== undefined && field.toLowerCase().includes(needle)
  )
}

// Newest first inside every band. A settled run's news is when it ended; a
// live one has no ending yet, so it is when it was made.
function newestFirst(band: Band): (left: RunRecord, right: RunRecord) => number {
  if (band !== 'done') {
    return (left, right) => stamp(right.createdAt) - stamp(left.createdAt)
  }
  return (left, right) =>
    stamp(right.endedAt ?? right.createdAt) - stamp(left.endedAt ?? left.createdAt)
}

function stamp(iso: string): number {
  const at = new Date(iso).getTime()
  return Number.isNaN(at) ? 0 : at
}

// Ended within the last day, which is what "finished today" has always meant.
// A dismissed run is never counted, though it ended within the day too: a
// dismissal is a clearing, not a finish.
export function finishedToday(runs: readonly RunRecord[], now = Date.now()): number {
  return runs.filter(
    (run) =>
      bandOf(run) === 'done' &&
      run.dismissedAt === undefined &&
      run.endedAt !== undefined &&
      now - stamp(run.endedAt) < 24 * 3_600_000
  ).length
}

// The line beside "Runs", in the bands' own words. Nothing running is worth
// saying; nothing needing you and nothing finished are not.
export function runsHeadline(runs: readonly RunRecord[], now = Date.now()): string {
  const running = runs.filter((run) => bandOf(run) === 'running').length
  const needing = runs.filter((run) => bandOf(run) === 'needsYou').length
  const finished = finishedToday(runs, now)
  const segments = [
    running === 0 ? 'nothing running' : `${running} running`,
    ...(needing === 0 ? [] : [needing === 1 ? '1 needs you' : `${needing} need you`]),
    ...(finished === 0 ? [] : [`${finished} finished today`])
  ]
  return segments.join(' · ')
}
