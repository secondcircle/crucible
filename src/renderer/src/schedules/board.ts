import type { ScheduleWarning } from '../../../shared/schedules/service'
import {
  runIsLive,
  runIsParked,
  type RunArtifact,
  type RunRecord
} from '../../../shared/workflows/run'

// Everything the schedule board says about runs, derived from run records and
// nothing else: parked rows, recent rows, each schedule's last outcome, and
// the chip's needs-you count. The schedule seam answers what a schedule is;
// it never restates a run fact, so these two can never disagree.

/** When a parked run stopped, which is the age its row shows. */
export function parkedAt(run: RunRecord): string {
  return run.question?.raisedAt ?? run.endedAt ?? run.createdAt
}

/** The node the stop happened at, when the record names one. */
export function parkedNode(run: RunRecord): string | undefined {
  if (run.question?.nodeId !== undefined) return run.question.nodeId
  return run.nodes.find((node) => node.status === 'failed')?.id
}

/** A short note of why it stopped, in the board's own words. */
export function parkedNote(run: RunRecord): string {
  if (run.status === 'failed') return 'node failed'
  const node = run.nodes.find((candidate) => candidate.id === run.question?.nodeId)
  if (node?.status === 'stalled') return 'stalled'
  return 'asked a question'
}

export interface RunStateCell {
  readonly text: string
  /** Amber for a wait, red for a failure. */
  readonly tone: 'blocked' | 'failed' | 'done' | 'live'
}

export function parkedStateCell(run: RunRecord): RunStateCell {
  if (run.status === 'failed') return { text: '✕ failed', tone: 'failed' }
  return { text: '⚑ waiting on answer', tone: 'blocked' }
}

/** Newest first, by when each run stopped. */
export function parkedRuns(
  runs: readonly RunRecord[],
  workspacePath: string
): readonly RunRecord[] {
  return runs
    .filter((run) => run.workspacePath === workspacePath && runIsParked(run))
    .sort((left, right) => stamp(parkedAt(right)) - stamp(parkedAt(left)))
}

/**
 * The Tab walk's parked queue: workspaces in rail order, newest first inside
 * each. A run leaves it the moment it is adopted or dismissed, because both
 * take it out of `runIsParked`.
 */
export function parkedWalk(
  runs: readonly RunRecord[],
  workspacePaths: readonly string[]
): readonly RunRecord[] {
  return workspacePaths.flatMap((path) => parkedRuns(runs, path))
}

/**
 * Recent runs: this workspace's scheduled runs that are not parked and not
 * dismissed, newest first. A failed run that was adopted lands here rather
 * than in Needs you — its attention rides its session.
 */
export function recentRuns(
  runs: readonly RunRecord[],
  workspacePath: string
): readonly RunRecord[] {
  return runs
    .filter(
      (run) =>
        run.scheduled === true &&
        run.workspacePath === workspacePath &&
        run.dismissedAt === undefined &&
        !runIsParked(run)
    )
    .sort((left, right) => stamp(newsOf(right)) - stamp(newsOf(left)))
}

/** A settled run's news is when it ended; a live one's is when it started. */
function newsOf(run: RunRecord): string {
  return run.endedAt ?? run.startedAt ?? run.createdAt
}

export interface LastOutcome {
  /** The glyph the cell opens with. */
  readonly mark: string
  readonly text: string
  /** ISO of the moment the outcome belongs to. */
  readonly at: string
  readonly tone: RunStateCell['tone']
}

/** The most recent scheduled run of this workflow, and what became of it. */
export function lastOutcome(
  runs: readonly RunRecord[],
  workspacePath: string,
  workflow: string
): LastOutcome | undefined {
  const latest = runs
    .filter(
      (run) =>
        run.scheduled === true &&
        run.workspacePath === workspacePath &&
        run.workflow === workflow
    )
    .sort((left, right) => stamp(newsOf(right)) - stamp(newsOf(left)))[0]
  if (latest === undefined) return undefined
  if (runIsParked(latest) && latest.status !== 'failed') {
    return { mark: '⚑', text: 'blocked', at: parkedAt(latest), tone: 'blocked' }
  }
  if (latest.status === 'failed') {
    return { mark: '✕', text: 'failed', at: newsOf(latest), tone: 'failed' }
  }
  if (latest.status === 'cancelled') {
    return { mark: '✕', text: 'cancelled', at: newsOf(latest), tone: 'failed' }
  }
  if (runIsLive(latest)) {
    return { mark: '●', text: 'running', at: newsOf(latest), tone: 'live' }
  }
  return { mark: '✓', text: 'ok', at: newsOf(latest), tone: 'done' }
}

/**
 * What a run's row says it did. A clean run's line is its completion message
 * — the summary the workflow returned — and a plain status wording when it
 * returned none.
 */
export function completionLine(run: RunRecord): string {
  if (runIsLive(run)) return 'running now'
  const summary = run.outputs?.summary
  if (typeof summary === 'string' && summary.trim() !== '') return summary.trim()
  switch (run.status) {
    case 'complete':
      return 'completed'
    case 'cancelled':
      return 'cancelled'
    default:
      return firstLine(run.error) ?? 'failed'
  }
}

/**
 * The run's report: the artifact its workflow declared under the name
 * `report`, backed by the furthest-written copy when revisions rewrote it. A
 * workflow that declares no report is legal and answers nothing.
 */
export function reportArtifact(run: RunRecord): RunArtifact | undefined {
  let found: RunArtifact | undefined
  for (const node of run.nodes) {
    for (const artifact of node.artifacts) {
      if (artifact.name !== 'report') continue
      if (found === undefined) {
        found = artifact
        continue
      }
      const later =
        artifact.writtenAt !== undefined &&
        (found.writtenAt === undefined || artifact.writtenAt >= found.writtenAt)
      if (later) found = artifact
      else if (found.writtenAt === undefined) found = artifact
    }
  }
  return found?.writtenAt === undefined ? undefined : found
}

// The state cell of a run in the Recent group. A live run's spend is appended
// where it renders: the number belongs to the row, the wording belongs here.
export function recentStateCell(run: RunRecord): RunStateCell {
  if (runIsLive(run)) return { text: '● running', tone: 'live' }
  if (run.status === 'failed') return { text: '✕ failed', tone: 'failed' }
  if (run.status === 'cancelled') return { text: '✕ cancelled', tone: 'failed' }
  return {
    text: reportArtifact(run) === undefined ? '✓ done' : '✓ report',
    tone: 'done'
  }
}

const MINUTE_MS = 60_000
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * The next-fire cell: minutes while that still means something, then the
 * clock time with the day it belongs to. A slot already passed reads as due,
 * because that is what a schedule waiting for the next evaluation is.
 */
export function nextFireText(nextFireAt: string, now = Date.now()): string {
  const at = new Date(nextFireAt)
  const when = at.getTime()
  if (Number.isNaN(when)) return ''
  if (when <= now) return 'due now'
  const minutes = Math.round((when - now) / MINUTE_MS)
  if (minutes < 60) return `next in ${Math.max(1, minutes)} min`
  const clock = `${at.getHours()}:${String(at.getMinutes()).padStart(2, '0')}`
  const days = calendarDaysBetween(new Date(now), at)
  if (days === 0) return `next ${clock} today`
  if (days === 1) return `next ${clock} tomorrow`
  if (days < 7) return `next ${clock} ${DAY_NAMES[at.getDay()]}`
  return `next ${clock} on ${at.getDate()} ${at.toLocaleString(undefined, { month: 'short' })}`
}

/** The warning cell, aged: "⚠ check failing 3h · 403 from api.github.com". */
export function warningText(warning: ScheduleWarning, now = Date.now()): string {
  const age = coarseAge(warning.since, now)
  const what = warningWhat(warning.kind)
  return `⚠ ${what}${age === '' ? '' : ` ${age}`} · ${firstLine(warning.message) ?? ''}`
}

function warningWhat(kind: ScheduleWarning['kind']): string {
  switch (kind) {
    case 'check':
      return 'check failing'
    case 'kickoff':
      return 'could not start'
    case 'cron':
      return 'cron unreadable'
    case 'inputs':
      return 'needs inputs'
  }
}

/** How long a warning has stood: `12m`, `3h`, `2d`; nothing under a minute. */
function coarseAge(iso: string, now: number): string {
  const at = stamp(iso)
  if (at === 0) return ''
  const minutes = Math.floor((now - at) / MINUTE_MS)
  if (minutes < 1) return ''
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** Whole days between two local dates, ignoring the time of day. */
function calendarDaysBetween(from: Date, to: Date): number {
  const left = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime()
  const right = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime()
  return Math.round((right - left) / (24 * 3_600_000))
}

function firstLine(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const line = text.split('\n')[0]?.trim()
  return line === undefined || line === '' ? undefined : line
}

function stamp(iso: string | undefined): number {
  if (iso === undefined) return 0
  const at = new Date(iso).getTime()
  return Number.isNaN(at) ? 0 : at
}
