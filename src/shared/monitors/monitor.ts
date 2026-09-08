// The port-crossing vocabulary of a monitor: who owns one, what its timing
// may be, what a check said, how it ended, and what the renderer sees of a
// live one. It imports the port and the run record and nothing else, so no
// engine, SDK or process concept can ride a monitor into the renderer.

import type { SessionId } from '../agent/port'
import type { WorkflowRunId } from '../workflows/run'

/** `m-` and four hex characters, unique across the store for the launch's life. */
export type MonitorId = string

// Who set the monitor and who its wake goes to. A node is named by the id
// that names its session (`job.id` in the engine), never by a revision id, so
// a monitor set in one revision still belongs to the session that set it.
export type MonitorOwner =
  | { readonly kind: 'session'; readonly sessionId: SessionId }
  | { readonly kind: 'node'; readonly runId: WorkflowRunId; readonly nodeId: string }

export type MonitorScope = MonitorOwner | { readonly kind: 'run'; readonly runId: WorkflowRunId }

export const INTERVAL_FLOOR_MS = 5_000
export const INTERVAL_DEFAULT_MS = 30_000
export const TIMEOUT_FLOOR_MS = 1_000
export const TIMEOUT_DEFAULT_MS = 30 * 60_000
export const TIMEOUT_CEILING_MS = 24 * 60 * 60_000
export const BROKE_STRIKES = 3
/** What the record keeps of a check's output, and what the detail shows. */
export const RETAINED_OUTPUT_CHARS = 4_000
/** What a wake carries of it. */
export const WAKE_OUTPUT_CHARS = 1_200

export interface MonitorTiming {
  readonly intervalMs: number
  readonly timeoutMs: number
}

// The bounds applied once, in one place both flavors and the tool row summary
// call: absent means the default, out of range means the bound. The only
// constructor of a `MonitorTiming`, which is what makes an out-of-bounds one
// unrepresentable rather than merely unlikely.
export function timingInForce(asked: {
  readonly intervalSeconds?: number
  readonly timeoutSeconds?: number
}): MonitorTiming {
  return {
    intervalMs: clamp(
      seconds(asked.intervalSeconds),
      INTERVAL_DEFAULT_MS,
      INTERVAL_FLOOR_MS,
      // An interval may not outlast the day a timeout may: the ceiling above
      // it is the timeout's, so no monitor can be set to check once, never.
      TIMEOUT_CEILING_MS
    ),
    timeoutMs: clamp(
      seconds(asked.timeoutSeconds),
      TIMEOUT_DEFAULT_MS,
      TIMEOUT_FLOOR_MS,
      TIMEOUT_CEILING_MS
    )
  }
}

// π's repairing parser hands a number over as a string often enough that both
// readers of a raw `crucible_monitor` call — the tool boundary that sets the
// monitor and the tool row's summary that says what it runs at — have to read
// one the same way, or the row states a cadence nothing is running at.
export function numericSeconds(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

function seconds(asked: number | undefined): number | undefined {
  if (asked === undefined || !Number.isFinite(asked)) return undefined
  return asked * 1000
}

function clamp(asked: number | undefined, fallback: number, floor: number, ceiling: number): number {
  if (asked === undefined) return fallback
  return Math.min(ceiling, Math.max(floor, Math.round(asked)))
}

export interface CheckOutput {
  readonly text: string
  readonly truncated: boolean
}

export function boundOutput(text: string, limit: number): CheckOutput {
  const trimmed = text.replace(/\s+$/, '')
  if (trimmed.length <= limit) return { text: trimmed, truncated: false }
  return { text: trimmed.slice(0, limit), truncated: true }
}

export interface LastCheck {
  /** ISO of the moment the check finished. */
  readonly at: string
  readonly output: CheckOutput
  readonly result:
    | { readonly kind: 'exited'; readonly exitCode: number }
    | { readonly kind: 'failed'; readonly message: string }
}

export type WakeReason = 'met' | 'timedOut' | 'broke'

// Why a wake-producing monitor ended. `broke` never travels without the error
// it carries, so the error is on the variant rather than beside it.
export type MonitorEnding =
  | { readonly reason: 'met' }
  | { readonly reason: 'timedOut' }
  | { readonly reason: 'broke'; readonly error: string }

// One live session monitor as the renderer sees it. Node monitors never cross
// this seam: every field a chip, a detail or a rail needs is here, and nothing
// about nodes is.
export interface LiveMonitor {
  readonly id: MonitorId
  readonly sessionId: SessionId
  readonly description: string
  readonly reason: string
  readonly command: string
  /** Absolute; the renderer says "checkout" or "worktree" by comparing it with the session's. */
  readonly cwd: string
  readonly intervalMs: number
  readonly timeoutMs: number
  /** ISO of the tool call. Time waited and the hairline count from it. */
  readonly setAt: string
  /** Checks actually run, across relaunches. */
  readonly checks: number
  readonly last?: LastCheck
}

/** The facts a wake is composed from; the model fills it, the wording reads it. */
export interface WakeFacts {
  readonly monitorId: MonitorId
  readonly description: string
  readonly ending: MonitorEnding
  readonly waitedMs: number
  readonly checks: number
  readonly lastOutput?: CheckOutput
}

/** A node monitor the quit cut down, as its node is told about it on Resume. */
export interface LostMonitor {
  readonly description: string
  readonly command: string
  readonly waitedMs: number
  readonly timeoutMs: number
  // How it ended, when the quit caught it already ended and holding its wake
  // for a paused run. Absent means it was still checking when the quit hit,
  // so there is no outcome to report. Either way no wake is delivered: the
  // notice carries what is known.
  readonly ending?: MonitorEnding
}
