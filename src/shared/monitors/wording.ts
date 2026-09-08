import type { SystemMessage } from '../agent/port'
import {
  boundOutput,
  numericSeconds,
  timingInForce,
  WAKE_OUTPUT_CHARS,
  type LiveMonitor,
  type LostMonitor,
  type MonitorEnding,
  type MonitorId,
  type MonitorTiming,
  type WakeFacts,
  type WakeReason
} from './monitor'

// Every sentence a monitor says, in one module so the two flavors cannot say
// one thing two ways: the wake (the text the model reads and the card the
// person sees, composed together so they cannot disagree), the three tool
// answers, the note the user's stop leaves for the next turn, the notice a
// resumed node gets about what the quit cut down, the tool row's summary, and
// the two duration formats every monitor surface shares.
//
// Pure: nothing here holds a record, reads a clock of its own or touches a
// store.

/** Opens every wake, so a titler, a fake orchestrator and a reader know nobody typed it. */
export const WAKE_MESSAGE_PREFIX = '⏳ Crucible monitor'

/** Whether a message in a session's transcript is a monitor talking, not a human. */
export function isWakeMessage(text: string): boolean {
  return text.startsWith(WAKE_MESSAGE_PREFIX)
}

/** How each ending reads, wherever it is named. */
export function endingPhrase(reason: WakeReason): string {
  if (reason === 'met') return 'condition met'
  if (reason === 'timedOut') return 'timed out'
  return 'check broke'
}

/** The color role each ending wears: the monitor color, warning, bad. */
export function endingTone(reason: WakeReason): 'monitor' | 'warn' | 'bad' {
  if (reason === 'met') return 'monitor'
  if (reason === 'timedOut') return 'warn'
  return 'bad'
}

/**
 * The wake: what the agent reads and what the person sees, built from the same
 * facts in the same call. Everything the wake carries of what the check
 * printed is bounded here and says so when it was cut — the last output and a
 * broken check's error alike, because that error is the same bytes coming the
 * other way. The full retained output stays in the chip's detail until the
 * chip goes.
 */
export function composeWake(facts: WakeFacts): SystemMessage {
  const { ending, description, waitedMs, checks } = facts
  const phrase = endingPhrase(ending.reason)
  const carried =
    facts.lastOutput === undefined
      ? undefined
      : boundOutput(facts.lastOutput.text, WAKE_OUTPUT_CHARS)
  const cut = carried?.truncated === true || facts.lastOutput?.truncated === true

  const carriedError =
    ending.reason === 'broke' ? boundOutput(ending.error, WAKE_OUTPUT_CHARS) : undefined
  const error = carriedError?.text.trim()
  const errorCut = carriedError?.truncated === true
  const output = carried?.text.trim() ?? ''
  // A broken check's error usually is its last output; saying it twice makes
  // the wake read like a machine rather than a report.
  const echoes =
    error !== undefined &&
    output !== '' &&
    (error.includes(output) || output.includes(error))

  const lines: string[] = [
    `${WAKE_MESSAGE_PREFIX} ${facts.monitorId} — ${phrase}: ${description}`,
    '',
    `Waited ${longDuration(waitedMs)} over ${checks} ${checks === 1 ? 'check' : 'checks'}.`
  ]
  if (error !== undefined) {
    lines.push('', `The check stopped being runnable: ${error}`)
    if (errorCut) lines.push('(cut to the first part; the rest was not kept for you.)')
  }
  if (output !== '' && !echoes) {
    lines.push('', 'Last output:', output)
    if (cut) lines.push('(cut to the first part; the rest was not kept for you.)')
  } else if (output === '' && error === undefined) {
    lines.push('', 'The check printed nothing.')
  }
  lines.push(
    '',
    'This monitor has ended and will not check again. Set another if you still want to wait.'
  )

  const bodyLines: string[] = []
  if (error !== undefined) bodyLines.push(`${error}${errorCut ? ' …' : ''}`)
  if (output !== '' && !echoes) bodyLines.push(`last output: ${output}${cut ? ' …' : ''}`)

  return {
    text: lines.join('\n'),
    card: {
      badge: 'monitor',
      tone: endingTone(ending.reason),
      title: description,
      meta: `${phrase} · ${longDuration(waitedMs)} · ${checks} ${
        checks === 1 ? 'check' : 'checks'
      }`,
      ...(bodyLines.length === 0 ? {} : { body: bodyLines.join('\n') })
    }
  }
}

/** What `crucible_monitor` answers with: the id to stop it by, and the timing in force. */
export function setAnswer(
  monitor: { readonly id: MonitorId; readonly description: string; readonly cwd: string },
  timing: MonitorTiming
): string {
  return [
    `Monitor ${monitor.id} is watching: ${monitor.description}`,
    `Checking every ${briefDuration(timing.intervalMs)} in ${monitor.cwd}, ` +
      `giving up after ${briefDuration(timing.timeoutMs)}.`,
    'You will be woken with a message when it ends. End your turn now; do not poll.',
    `Stop it early with crucible_monitor_stop (monitorId "${monitor.id}").`
  ].join('\n')
}

/** The fields `crucible_monitors` lists a monitor by, session-owned or not. */
export type MonitorLine = Pick<
  LiveMonitor,
  'id' | 'description' | 'intervalMs' | 'timeoutMs' | 'setAt' | 'checks' | 'last'
>

/** One line per live monitor; the empty case has a sentence of its own. */
export function listAnswer(monitors: readonly MonitorLine[], now: number): string {
  if (monitors.length === 0) {
    return 'Nothing is being watched for you right now. Set a monitor with crucible_monitor.'
  }
  return monitors
    .map((monitor) => {
      const waited = longDuration(Math.max(0, now - Date.parse(monitor.setAt)))
      const output = monitor.last?.output.text ?? ''
      return [
        `- ${monitor.id} — ${monitor.description}`,
        `  every ${briefDuration(monitor.intervalMs)} · up to ${briefDuration(monitor.timeoutMs)}` +
          ` · waited ${waited} · ${monitor.checks} ${monitor.checks === 1 ? 'check' : 'checks'}`,
        `  last output: ${output === '' ? '(nothing yet)' : firstLine(output)}`
      ].join('\n')
    })
    .join('\n')
}

/** What `crucible_monitor_stop` answers with when it stopped something. */
export function stopAnswer(description: string): string {
  return `Stopped watching: ${description}. No wake will arrive for it.`
}

/** What it answers with when the id names nothing this agent is watching. */
export function stopRefusal(monitorId: string): string {
  return (
    `No live monitor of yours is named "${monitorId}", so nothing was stopped. ` +
    'Call crucible_monitors to see what you are waiting on.'
  )
}

// The R25 block, opened by a preamble that reads as Crucible's rather than as
// the user speaking, one line per monitor the user stopped since the last turn.
const STOPPED_PREAMBLE =
  'Crucible status update — automatic, and not sent by the user. The user stopped watching:'

export function stoppedNote(
  stopped: readonly {
    readonly description: string
    readonly waitedMs: number
    readonly checks: number
  }[]
): string {
  return [
    STOPPED_PREAMBLE,
    ...stopped.map(
      (monitor) =>
        `- ${monitor.description} — after ${longDuration(monitor.waitedMs)} and ` +
        `${monitor.checks} ${monitor.checks === 1 ? 'check' : 'checks'}. No wake is coming.`
    )
  ].join('\n')
}

/** The paragraph appended to a resumed node's first message about what the quit cut down. */
export function lostMonitorsNotice(lost: readonly LostMonitor[]): string {
  return [
    'Crucible quit while this node was waiting, so the monitors it had set are gone and no ' +
      'wake is coming for them. Set them again with crucible_monitor if they still matter:',
    ...lost.map(
      (monitor) =>
        `- ${monitor.description} — \`${monitor.command}\` — had waited ` +
        `${longDuration(monitor.waitedMs)} of ${briefDuration(monitor.timeoutMs)}.`
    )
  ].join('\n')
}

/** The tool row's words for a `crucible_monitor` call. */
export function monitorCallSummary(args: unknown): string {
  const given = (typeof args === 'object' && args !== null ? args : {}) as {
    description?: unknown
    intervalSeconds?: unknown
    timeoutSeconds?: unknown
  }
  const description = typeof given.description === 'string' ? given.description.trim() : ''
  // The same bounds the model applies, so the row never states a cadence the
  // monitor is not actually running at.
  const intervalSeconds = numericSeconds(given.intervalSeconds)
  const timeoutSeconds = numericSeconds(given.timeoutSeconds)
  const { intervalMs, timeoutMs } = timingInForce({
    ...(intervalSeconds === undefined ? {} : { intervalSeconds }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds })
  })
  return [
    description === '' ? 'a monitor' : description,
    `every ${briefDuration(intervalMs)}`,
    `up to ${briefDuration(timeoutMs)}`
  ].join(' · ')
}

/** `4m`, `30s`, `1h` — the chip's units. */
export function briefDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/** `6m 40s`, `1h 4m`, `45s` — the detail's and the wake's units. */
export function longDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) {
    const seconds = total % 60
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
  }
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

/** `4m 12s of 30m` — what the detail says under the hairline. */
export function elapsedOfTimeout(elapsedMs: number, timeoutMs: number): string {
  return `${longDuration(elapsedMs)} of ${briefDuration(timeoutMs)}`
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '') ?? ''
}

/** How an ending reads on one line, error and all. */
export function monitorEndingText(ending: MonitorEnding): string {
  return ending.reason === 'broke'
    ? `${endingPhrase(ending.reason)}: ${ending.error}`
    : endingPhrase(ending.reason)
}
