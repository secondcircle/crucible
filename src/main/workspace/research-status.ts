import { redactKeys, type Redacted, type ResearchStatus } from '../../shared/workspace/research'
import type { ProcessOutcome } from './research-processes'

// Turning what a process did into a status: no spawning, no clock, no I/O, so
// the whole risk of an external output format sits behind captured fixtures.

/**
 * `doctor --json` is the CLI's machine-readable output; `--status` is the same
 * facts as prose, with terminal colours in it.
 */
export const STATUS_ARGS: readonly string[] = ['doctor', '--json']

/** How long a status read or a log-out may take before it is unreadable. */
export const RESEARCH_TIMEOUT_MS = 30_000

/** Terminal colour, which the CLI writes whether or not anyone is watching. */
// eslint-disable-next-line no-control-regex -- the escape is the thing matched
const ANSI = /\u001b\[[0-9;]*m/g

/** As much of a machine's shouting as a status row can carry. */
const REASON_LIMIT = 240

function plain(text: string): string {
  return text.replace(ANSI, '').trim()
}

function shortened(text: string): string {
  const flattened = plain(text).replace(/\s*\n\s*/g, ' ')
  return flattened.length <= REASON_LIMIT
    ? flattened
    : `${flattened.slice(0, REASON_LIMIT - 1)}…`
}

/** One line of `doctor --json`: a named check, its verdict and its words. */
interface Check {
  readonly name: string
  readonly status: string
  readonly message: string
}

function checksIn(text: string): readonly Check[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const checks = (parsed as { checks?: unknown } | null)?.checks
  if (!Array.isArray(checks)) return undefined
  const read: Check[] = []
  for (const entry of checks) {
    const { name, status, message } = (entry ?? {}) as {
      name?: unknown
      status?: unknown
      message?: unknown
    }
    if (typeof name !== 'string' || typeof status !== 'string') return undefined
    read.push({ name, status, message: typeof message === 'string' ? message : '' })
  }
  return read
}

function check(checks: readonly Check[], name: string): Check | undefined {
  return checks.find((candidate) => candidate.name === name)
}

/** `v1.23.3 (latest)`, `v1.23.3 (v1.24.0 available)`, `v1.23.3 (registry unreachable)`. */
function versionIn(message: string): string | undefined {
  return /v?(\d+\.\d+\.\d+[^\s)]*)/.exec(message)?.[1]
}

// `12,345 / 50,000 (75% left)`, `12,345 (pay-as-you-go)`, `0 remaining`, and
// `unavailable` or `no credit info in response` where the CLI has no figure.
function creditsIn(message: string): number | undefined {
  const found = /^\s*(\d[\d,]*)/.exec(message)?.[1]
  if (found === undefined) return undefined
  const figure = Number(found.replace(/,/g, ''))
  return Number.isFinite(figure) ? figure : undefined
}

function unreadable(reason: string): ResearchStatus {
  return { kind: 'unreadable', reason: redactKeys(reason) }
}

/**
 * `noBinary` is the only outcome that ever reads as not installed; everything
 * else that failed is unreadable, which claims neither presence nor absence.
 */
export function readResearchStatus(outcome: ProcessOutcome): ResearchStatus {
  switch (outcome.kind) {
    case 'noBinary':
      return { kind: 'notInstalled' }
    case 'timedOut':
      return unreadable('firecrawl did not answer in time.')
    case 'cancelled':
      return unreadable('The reading was stopped before it finished.')
    case 'failed':
      return unreadable(outcome.reason)
    case 'exited':
      // Recognizable output wins whatever the exit code was: the CLI exits
      // non-zero for any failing check, signed out among them.
      return fromOutput(outcome.stdout, outcome.stderr, outcome.code)
  }
}

function fromOutput(stdout: string, stderr: string, code: number): ResearchStatus {
  const checks = checksIn(stdout)
  const key = checks === undefined ? undefined : check(checks, 'API Key')
  const version =
    checks === undefined ? undefined : versionIn(check(checks, 'CLI Version')?.message ?? '')

  if (checks === undefined || key === undefined || version === undefined) {
    const said = shortened(`${stdout}\n${stderr}`)
    return unreadable(
      said === ''
        ? `firecrawl exited with code ${code} and said nothing.`
        : `firecrawl said: ${said}`
    )
  }

  if (key.status !== 'pass') return { kind: 'signedOut', version: redactKeys(version) }

  const credits = creditsIn(check(checks, 'Credits')?.message ?? '')
  return credits === undefined
    ? { kind: 'signedIn', version: redactKeys(version) }
    : { kind: 'signedIn', version: redactKeys(version), credits }
}

/** The CLI's own words for a failed connect or log-out, redacted. */
export function refusalMessage(outcome: ProcessOutcome): Redacted {
  switch (outcome.kind) {
    case 'noBinary':
      return redactKeys('firecrawl is not installed on this machine.')
    case 'timedOut':
      return redactKeys('firecrawl did not answer in time.')
    case 'cancelled':
      return redactKeys('That was stopped before it finished.')
    case 'failed':
      return redactKeys(outcome.reason)
    case 'exited': {
      const said = shortened(`${outcome.stderr}\n${outcome.stdout}`)
      return redactKeys(
        said === '' ? `firecrawl exited with code ${outcome.code}.` : said
      )
    }
  }
}
