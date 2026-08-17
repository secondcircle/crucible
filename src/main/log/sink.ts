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
 * The one place a record is made, for every adapter. The stamps go on first and
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

/** How anything inside a sink says a record was dropped, and why. */
type Report = (what: string, cause: unknown) => void

/**
 * One stderr line per sink, whatever goes wrong and however often: the app runs
 * on rather than drowning its own output. The line says a record was dropped,
 * not that the sink stopped — an unserializable record costs one record, a dead
 * file costs the rest of the launch, and the sink keeps taking `append` either
 * way.
 */
function createReporter(): Report {
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
 * Puts one line where this destination keeps them. `done` is the destination's
 * last words: one call that finishes it and says why, in that order, so nothing
 * the diagnostic itself does — a stderr interceptor that logs, a `write` that
 * throws — can reach a destination that is already finished. It is one call
 * rather than two because the order is the sink's to get right, not an
 * adapter's.
 */
type Write = (line: string, done: Report) => void

/**
 * Where an adapter's lines go, which is the whole of what an adapter has to
 * say. It is opened once, when the sink is made, and answers with its `Write` —
 * or with nothing at all, if the place could not be opened, which it may say
 * why of through `report`.
 *
 * A destination that cannot fail says nothing about failure. One that can is
 * the only thing that knows what its failure is called, so it names it; what a
 * failure *costs* is not its business but the sink's, below.
 */
type Destination = (report: Report) => Write | undefined

/**
 * Every sink there is, whatever it writes to: one number per `append` spent in
 * order, the stamps, the serialization, and everything the `LogSink` interface
 * promises about them — one diagnostic per sink whatever fails, an
 * unserializable record costing exactly one record, and a destination that is
 * done costing every record after it, without a line of work spent on any of
 * them. Holding all of it here is what leaves an adapter with nothing to get
 * wrong but the writing.
 */
function createSink(destination: Destination): LogSink {
  const report = createReporter()

  let write: Write | undefined
  const done: Report = (what, cause) => {
    // Finished before a word is said about it, so that whatever the diagnostic
    // itself does finds a destination that is already gone.
    write = undefined
    report(what, cause)
  }

  write = destination(report)
  let seq = 0
  return {
    append(entry) {
      // The number is spent before anything can go wrong with the record, so a
      // gap in the log is a reader's evidence that something was dropped.
      seq += 1
      if (write === undefined) return

      let line: string | undefined
      try {
        line = JSON.stringify(stamp(entry, seq))
      } catch (error) {
        report(`cannot serialize record ${seq}`, error)
        return
      }
      // A record whose own `toJSON` answers with nothing serializes to nothing:
      // `JSON.stringify` returns rather than throws, so there is no cause to
      // report and nothing to write.
      if (line === undefined) return

      write(line, done)
    }
  }
}

/**
 * The file adapter: one JSONL file per launch under `directory`, named from the
 * launch's start time. The directory is created if it is missing.
 */
export function createFileSink(directory: string): LogSink {
  const startedAt = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(directory, `${startedAt}.jsonl`)

  return createSink((report) => {
    let handle: number
    try {
      mkdirSync(directory, { recursive: true })
      handle = openSync(file, 'a')
    } catch (error) {
      report(`cannot open ${file}`, error)
      return undefined
    }

    return (line, done) => {
      try {
        writeSync(handle, `${line}\n`)
      } catch (error) {
        // A file that has failed once is done for the launch: no buffer, no
        // retry, and the app runs on without its log.
        done(`cannot write ${file}`, error)
      }
    }
  })
}

/** The in-memory adapter, for tests: what a file sink would have written. */
export function createMemorySink(): MemorySink {
  const lines: string[] = []
  return {
    lines,
    // An array has no way to fail and nothing to report: the whole destination
    // is where the line goes.
    ...createSink(() => (line) => {
      lines.push(line)
    })
  }
}
