import type { RunRecord } from '../../../shared/workflows/run'

// ⌘R groups by what a run wants from you, not by where it ran: running, needs
// you, done. The workspace is a column on the row instead.

export type Band = 'running' | 'needsYou' | 'done'

/** Total over `RunStatus`: no run is unclassified, and none is in two bands. */
export function bandOf(run: RunRecord): Band {
  // A dismissed run is one the user has cleared: it asks for nothing, whatever
  // its status. The service only ever stamps a settled run, so this clause
  // cannot hide live work.
  if (run.dismissedAt !== undefined) return 'done'
  if (run.status === 'complete' || run.status === 'cancelled') return 'done'
  // A failed run is the one most likely to need a human, and a paused one is
  // stopped until somebody moves it.
  if (run.status === 'failed' || run.status === 'paused') return 'needsYou'
  return run.waiting === true ? 'needsYou' : 'running'
}

// Whether something is working on the session's behalf, which is what decides
// that a turn ending in that session is not news. Written in terms of `bandOf`
// and kept beside it so the sidebar and ⌘R cannot drift into disagreeing about
// whether a run is asking for something. Not `runIsLive`: that one counts a
// paused run as live, and a paused run is stopped until somebody moves it.
/** Working on the session's behalf: the runs view files it under Running. */
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
