import {
  BROKE_STRIKES,
  INTERVAL_DEFAULT_MS,
  INTERVAL_FLOOR_MS,
  TIMEOUT_CEILING_MS,
  TIMEOUT_DEFAULT_MS,
  numericSeconds,
  type MonitorOwner
} from '../monitors/monitor'

// Both adapters and the engine build the three monitor tools from these
// definitions, so a session agent and a run's node cannot end up meaning
// different things by a monitor. The descriptions carry the teaching too: a
// description rides the request's tools parameter, the one channel Crucible's
// system prompt does not replace.

export type MonitorToolName = 'crucible_monitor' | 'crucible_monitors' | 'crucible_monitor_stop'

export type ToolParameterKind = 'string' | 'number'

export interface MonitorToolParameter {
  readonly name: string
  readonly description: string
  /** Absent means required. */
  readonly optional?: boolean
  /** Absent means string. */
  readonly kind?: ToolParameterKind
}

export interface MonitorToolDefinition {
  readonly name: MonitorToolName
  /** Human-readable, for a tool row. */
  readonly label: string
  readonly description: string
  readonly parameters: readonly MonitorToolParameter[]
}

const INTERVAL_DEFAULT_SECONDS = Math.round(INTERVAL_DEFAULT_MS / 1000)
const INTERVAL_FLOOR_SECONDS = Math.round(INTERVAL_FLOOR_MS / 1000)
const TIMEOUT_DEFAULT_MINUTES = Math.round(TIMEOUT_DEFAULT_MS / 60_000)
const TIMEOUT_CEILING_HOURS = Math.round(TIMEOUT_CEILING_MS / 3_600_000)

export const MONITOR_TOOLS: readonly MonitorToolDefinition[] = [
  {
    name: 'crucible_monitor',
    label: 'Set Monitor',
    description:
      'Wait on something outside this conversation without spending turns on it. Crucible runs ' +
      'your shell command in your working directory every so often and sends you a message when ' +
      'it passes, or when the timeout runs out regardless. Exit 0 means the condition is met; ' +
      'any other exit code means keep waiting.\n\n' +
      'Set the monitor and end your turn. The wake arrives as a message and starts a turn of ' +
      'its own, so polling by hand — sleeping, re-running the command, asking again in a ' +
      'minute — only burns turns for an answer that was going to arrive anyway. The user can ' +
      'go on talking to you meanwhile; the wait costs nothing while it runs.\n\n' +
      'Write `description` in the user\'s terms, not the command\'s: "CI on PR #482 to finish", ' +
      '"the npm publish of 0.4.12 to land", "port 5222 to free up". It is shown to the user ' +
      'verbatim as the headline of the chip that says what you are waiting on, so a description ' +
      'like "gh pr checks exits 0" tells them nothing. `reason` says why you want to know, and ' +
      'is shown to them when they open the chip.\n\n' +
      `Timing: interval defaults to ${INTERVAL_DEFAULT_SECONDS}s and is never faster than ` +
      `${INTERVAL_FLOOR_SECONDS}s; timeout defaults to ${TIMEOUT_DEFAULT_MINUTES} minutes and ` +
      `never exceeds ${TIMEOUT_CEILING_HOURS} hours. Values outside those bounds are clamped, ` +
      'and the answer states what is actually in force.\n\n' +
      'When the check breaks the monitor ends there rather than retrying to the timeout, and ' +
      'you are woken with the error. "Broke" means the command could not run at all (no such ' +
      `command, exit 126 or 127), or that ${BROKE_STRIKES} consecutive checks failed with the ` +
      'identical error output on stderr. A non-zero exit that prints nothing on stderr is ' +
      'always just "keep waiting", however often it repeats — so send expected noise to ' +
      '/dev/null (`gh pr checks 482 2>/dev/null | grep -q IN_PROGRESS && exit 1`) and the ' +
      'monitor will wait as long as you asked it to.',
    parameters: [
      {
        name: 'description',
        description:
          'One line, in the user\'s terms, naming what is being waited on. Shown verbatim: ' +
          '"CI on PR #482 to finish".'
      },
      {
        name: 'reason',
        description: 'Why you want to know — one line, shown to the user when they open the chip.'
      },
      {
        name: 'command',
        description:
          'The shell command to check with, run as given in your working directory. Exit 0 ' +
          'means the condition is met; any other exit means keep waiting.'
      },
      {
        name: 'intervalSeconds',
        description: `How often to check. Defaults to ${INTERVAL_DEFAULT_SECONDS}, floor ${INTERVAL_FLOOR_SECONDS}.`,
        optional: true,
        kind: 'number'
      },
      {
        name: 'timeoutSeconds',
        description:
          `How long to keep waiting before giving up. Defaults to ${TIMEOUT_DEFAULT_MS / 1000}, ` +
          `ceiling ${TIMEOUT_CEILING_MS / 1000}.`,
        optional: true,
        kind: 'number'
      }
    ]
  },
  {
    name: 'crucible_monitors',
    label: 'List Monitors',
    description:
      'List what you are currently waiting on: each monitor\'s id, description, cadence, ' +
      'timeout, how long it has waited, how many checks it has made and the last thing the ' +
      'check printed. Read it when the user asks what you are waiting on. Never poll it to ' +
      'find out whether a monitor has fired — a monitor that ends wakes you with a message.',
    parameters: []
  },
  {
    name: 'crucible_monitor_stop',
    label: 'Stop Monitor',
    description:
      'Stop one of your live monitors. It stops checking immediately and no wake arrives for ' +
      'it. Stop a wait that has become pointless rather than leaving it to time out. A monitor ' +
      'that has already ended, or one that was never yours, stops nothing and says so.',
    parameters: [
      { name: 'monitorId', description: 'The monitor to stop, as crucible_monitor named it' }
    ]
  }
]

export function monitorTool(name: MonitorToolName): MonitorToolDefinition {
  const found = MONITOR_TOOLS.find((tool) => tool.name === name)
  if (found === undefined) throw new Error(`${name} is not a monitor tool.`)
  return found
}

/** What `crucible_monitor` is called with, already checked. */
export interface MonitorRequest {
  readonly description: string
  readonly reason: string
  readonly command: string
  readonly intervalSeconds?: number
  readonly timeoutSeconds?: number
}

/**
 * The tool boundary: a blank description, reason or command throws the
 * sentence the model reads, so a bad call fails in the model's face rather
 * than one transition later. A numeric string in a timing field is accepted as
 * a number — π's repairing parser hands one over often enough — and anything
 * else non-numeric is treated as absent, because a default is a better answer
 * than a refusal over a field the caller need not have sent at all.
 */
export function monitorRequestFrom(params: unknown): MonitorRequest {
  const given = (typeof params === 'object' && params !== null ? params : {}) as Record<
    string,
    unknown
  >
  const description = text(given.description)
  const reason = text(given.reason)
  const command = text(given.command)

  const missing = [
    description === '' ? 'description' : undefined,
    reason === '' ? 'reason' : undefined,
    command === '' ? 'command' : undefined
  ].filter((name): name is string => name !== undefined)
  if (missing.length > 0) {
    throw new Error(
      `A monitor needs ${missing.join(', ')}. No monitor was set. Call crucible_monitor again ` +
        'with a one-line description in the user\'s terms, the reason you want to know, and the ' +
        'shell command that exits 0 when the condition is met.'
    )
  }

  const intervalSeconds = numericSeconds(given.intervalSeconds)
  const timeoutSeconds = numericSeconds(given.timeoutSeconds)
  return {
    description,
    reason,
    command,
    ...(intervalSeconds === undefined ? {} : { intervalSeconds }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds })
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}


// An adapter is handed behaviors rather than the model itself. Every method
// resolves with exactly the text the tool result must show; a failure throws,
// carrying the sentence the model should read.
export interface MonitorTools {
  // `cwd` is the caller's working directory at call time: the bound directory
  // for a session, the run's worktree for a node.
  set(owner: MonitorOwner, cwd: string, request: MonitorRequest): Promise<string>
  list(owner: MonitorOwner): Promise<string>
  stop(owner: MonitorOwner, monitorId: string): Promise<string>
}

/** The same behaviors with the owner and directory fixed: what a tool builder is handed. */
export interface BoundMonitorTools {
  set(request: MonitorRequest): Promise<string>
  list(): Promise<string>
  stop(monitorId: string): Promise<string>
}

// Owner isolation is structural: an adapter binds to its own session id, the
// engine to its own node, and no tool takes an owner as an argument, so no
// agent can name another's monitors.
export function bindMonitorTools(
  tools: MonitorTools,
  owner: MonitorOwner,
  cwd: string
): BoundMonitorTools {
  return {
    set: (request: MonitorRequest) => tools.set(owner, cwd, request),
    list: () => tools.list(owner),
    stop: (monitorId: string) => tools.stop(owner, monitorId)
  }
}
