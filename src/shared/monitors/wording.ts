import type { SystemMessage } from '../agent/port'
import {
  boundOutput,
  numericSeconds,
  timingInForce,
  WAKE_OUTPUT_CHARS,
  type LiveMonitor,
  type LostMonitor,
  type MonitorId,
  type MonitorTiming,
  type WakeFacts,
  type WakeReason
  // Spelled with its extension so plain Node can load this module for
  // `prove:sdk`: its ESM resolver does no extension guessing.
} from './monitor.ts'

export const WAKE_MESSAGE_PREFIX = '⏳ Crucible monitor'

export function isWakeMessage(text: string): boolean {
  return text.startsWith(WAKE_MESSAGE_PREFIX)
}

export function endingPhrase(reason: WakeReason): string {
  if (reason === 'met') return 'condition met'
  if (reason === 'timedOut') return 'timed out'
  return 'check broke'
}

export function endingTone(reason: WakeReason): 'monitor' | 'warn' | 'bad' {
  if (reason === 'met') return 'monitor'
  if (reason === 'timedOut') return 'warn'
  return 'bad'
}

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

export function setAnswer(
  monitor: { readonly id: MonitorId; readonly description: string; readonly cwd: string },
  timing: MonitorTiming
): string {
  return [
    `Monitor ${monitor.id} is watching: ${monitor.description}`,
    `Checking every ${exactDuration(timing.intervalMs)} in ${monitor.cwd}, ` +
      `giving up after ${exactDuration(timing.timeoutMs)}.`,
    'You will be woken with a message when it ends. End your turn now; do not poll.',
    `Stop it early with crucible_monitor_stop (monitorId "${monitor.id}").`
  ].join('\n')
}

export type MonitorLine = Pick<
  LiveMonitor,
  'id' | 'description' | 'intervalMs' | 'timeoutMs' | 'setAt' | 'checks' | 'last'
>

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
        `  every ${exactDuration(monitor.intervalMs)} · up to ${exactDuration(monitor.timeoutMs)}` +
          ` · waited ${waited} · ${monitor.checks} ${monitor.checks === 1 ? 'check' : 'checks'}`,
        `  last output: ${output === '' ? '(nothing yet)' : firstLine(output)}`
      ].join('\n')
    })
    .join('\n')
}

export function stopAnswer(description: string): string {
  return `Stopped watching: ${description}. No wake will arrive for it.`
}

export function stopRefusal(monitorId: string): string {
  return (
    `No live monitor of yours is named "${monitorId}", so nothing was stopped. ` +
    'Call crucible_monitors to see what you are waiting on.'
  )
}

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

export function lostMonitorsNotice(lost: readonly LostMonitor[]): string {
  return [
    'Crucible quit while this node was waiting, so the monitors it had set are gone and no ' +
      'wake is coming for them. Set them again with crucible_monitor if they still matter:',
    ...lost.map((monitor) => {
      const head = `- ${monitor.description} — \`${monitor.command}\` — `
      if (monitor.ending === undefined) {
        return (
          head +
          `had waited ${longDuration(monitor.waitedMs)} of ${exactDuration(monitor.timeoutMs)}.`
        )
      }
      // The same bound the wake puts on the same bytes: a check that died
      // shouting does not get to shout through this notice either.
      const outcome =
        monitor.ending.reason === 'broke'
          ? `${endingPhrase('broke')} (${boundOutput(monitor.ending.error, WAKE_OUTPUT_CHARS).text.trim()})`
          : endingPhrase(monitor.ending.reason)
      return (
        head +
        `${outcome} after ${longDuration(monitor.waitedMs)} of ` +
        `${exactDuration(monitor.timeoutMs)}, but the quit came before the wake reached you.`
      )
    })
  ].join('\n')
}

export function monitorCallSummary(args: unknown): string {
  const given = (typeof args === 'object' && args !== null ? args : {}) as {
    description?: unknown
    intervalSeconds?: unknown
    timeoutSeconds?: unknown
  }
  const description = typeof given.description === 'string' ? given.description.trim() : ''
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

// What an agent is told a monitor's timing is, and only that: the value in
// force, to the second, never rounded to a neater unit. An agent that asked
// for 90s and read "every 2m" cannot tell a rounding from a clamp, and being
// able to tell is the whole point of stating what is in force. Rounding is the
// chip's business, where a person is reading and a second either way is noise.
export function exactDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total === 0) return '0s'
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return [
    ...(hours === 0 ? [] : [`${hours}h`]),
    ...(minutes === 0 ? [] : [`${minutes}m`]),
    ...(seconds === 0 ? [] : [`${seconds}s`])
  ].join(' ')
}

export function briefDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

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

export function elapsedOfTimeout(elapsedMs: number, timeoutMs: number): string {
  return `${longDuration(elapsedMs)} of ${briefDuration(timeoutMs)}`
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '') ?? ''
}
