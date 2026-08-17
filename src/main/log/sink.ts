import { mkdirSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Which process an entry came from. The renderer never writes the log itself
 * (D9); a later slice forwards its console output and preload errors to main,
 * which will append them with `source: 'renderer'`, so a reader can tell the
 * two apart in one stream.
 */
export type LogSource = 'main' | 'renderer'

/**
 * What a caller hands the sink. `source` says who it came from, `event` names
 * what happened, `turnId` is present on anything belonging to a turn, and any
 * other JSON-serializable field may be added — the sink writes them through.
 *
 * `ts` and `seq` are not a caller's to give: the sink stamps both, and an entry
 * carrying either name is written with the sink's value, not the caller's. That
 * matters because entries are forwarded payloads as often as they are literals,
 * and a payload that could displace the ordering stamps would make the log lie
 * about its own order.
 */
export interface LogEntry {
  readonly source: LogSource
  readonly event: string
  readonly turnId?: string
  readonly [field: string]: unknown
}

/** One line of the run log: a caller's entry under the sink's own stamps. */
export interface LogRecord {
  readonly ts: string
  readonly seq: number
  readonly source: LogSource
  readonly event: string
  readonly turnId?: string
  readonly [field: string]: unknown
}

/**
 * The single writer of Crucible's run log (D9).
 *
 * `append` is the whole interface. It is synchronous — a record is on disk by
 * the time it returns, so nothing has to be flushed at exit — it never throws,
 * and it never blocks the app: a sink that cannot write drops the record and
 * says so on stderr exactly once, then stays quiet for the rest of the launch.
 *
 * Sequence numbers are the sink's, assigned in `append` order starting at 1 and
 * scoped to one launch, so ordering is a property of the file rather than of
 * clock resolution. A dropped record still spends its number, so a gap in the
 * file is a reader's evidence that something was dropped.
 */
export interface LogSink {
  append(entry: LogEntry): void
}

/** The in-memory adapter: the same lines, kept in an array instead of a file. */
export interface MemorySink extends LogSink {
  /** The JSONL lines this sink would have written, in order, newline-free. */
  readonly lines: readonly string[]
}

/** The field names the sink owns; a caller's value for one of them is ignored. */
const stamped = new Set(['ts', 'seq'])

/**
 * The one place a record is made, for both adapters. The stamps go on first and
 * a caller's fields are copied in around them, so no entry — literal, forwarded
 * or hostile — can displace `ts` or `seq`.
 */
function stamp(entry: LogEntry, seq: number): LogRecord {
  const record: Record<string, unknown> = { ts: new Date().toISOString(), seq, source: entry.source }
  for (const [field, value] of Object.entries(entry)) {
    if (stamped.has(field)) continue
    record[field] = value
  }
  return record as unknown as LogRecord
}

/** One record, one line — or nothing at all, if it will not serialize. */
function serialize(
  entry: LogEntry,
  seq: number,
  report: (what: string, cause: unknown) => void
): string | undefined {
  try {
    return JSON.stringify(stamp(entry, seq))
  } catch (error) {
    report(`cannot serialize record ${seq}`, error)
    return undefined
  }
}

/**
 * One stderr line per sink, whatever goes wrong and however often: the app runs
 * on rather than drowning its own output. The line says a record was dropped,
 * not that the sink stopped — an unserializable record costs one record, a dead
 * file costs the rest of the launch, and the sink keeps taking `append` either
 * way.
 */
function createReporter(): (what: string, cause: unknown) => void {
  let reported = false
  return (what, cause) => {
    if (reported) return
    reported = true
    const detail = cause instanceof Error ? cause.message : String(cause)
    process.stderr.write(
      `[crucible] log sink dropped a record: ${what}: ${detail} (only line of its kind this launch)\n`
    )
  }
}

/**
 * The file adapter: one JSONL file per launch under `directory`, named from the
 * launch's start time. The directory is created if it is missing.
 */
export function createFileSink(directory: string): LogSink {
  const report = createReporter()
  const startedAt = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(directory, `${startedAt}.jsonl`)

  let handle: number | undefined
  try {
    mkdirSync(directory, { recursive: true })
    handle = openSync(file, 'a')
  } catch (error) {
    report(`cannot open ${file}`, error)
  }

  let seq = 0
  return {
    append(entry) {
      seq += 1
      if (handle === undefined) return
      const line = serialize(entry, seq, report)
      if (line === undefined) return
      try {
        writeSync(handle, `${line}\n`)
      } catch (error) {
        handle = undefined
        report(`cannot write ${file}`, error)
      }
    }
  }
}

/** The in-memory adapter, for tests: what a file sink would have written. */
export function createMemorySink(): MemorySink {
  const report = createReporter()
  const lines: string[] = []
  let seq = 0
  return {
    lines,
    append(entry) {
      seq += 1
      const line = serialize(entry, seq, report)
      if (line !== undefined) lines.push(line)
    }
  }
}
