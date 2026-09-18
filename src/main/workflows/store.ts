import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TranscriptItem } from '../../shared/agent/port'
import type { RunRecord, WorkflowRunId } from '../../shared/workflows/run'

// The run record outlives the run: every record ever written stays readable,
// which is what lets the global runs view show finished work across
// launches. Everything lives under Crucible's own state directory — never
// the repository, and never anything of π's.
//
// Layout: <root>/<runId>/run.json, artifacts/, sessions/, transcripts/<node>.json.
//
// Nothing here writes on the caller's thread. `save` and `writeTranscript`
// only schedule: the store writes each file at most once per interval, never
// stacks a second write behind one in flight, and takes a transcript's
// snapshot at write time rather than at call time — so a node reporting
// activity ten times a second costs ten cheap calls and one write. The engine
// calls both from the main process, and a run at full activity was holding
// the window for seconds at a time when they wrote inline.

/** No file is rewritten more often than this, however often it changes. */
const WRITE_INTERVAL_MS = 3000

export interface RunStore {
  /** Every persisted record, newest first. Unreadable ones are skipped. */
  load(): readonly RunRecord[]
  /** Schedules a write of the record; rate-limited and coalesced per run. */
  save(run: RunRecord): void
  /** The run's own directory: run.json, artifacts/, sessions/, transcripts/. */
  runDir(runId: WorkflowRunId): string
  /** The run's artifact directory, created on first ask. */
  artifactDir(runId: WorkflowRunId): string
  // Where this run's node sessions are kept, created on first ask: what lets
  // a node the quit cut down be continued rather than run again.
  sessionDir(runId: WorkflowRunId): string
  /**
   * Schedules a write of one node's transcript, rate-limited and coalesced
   * per node. `snapshot` is called when the write happens and not before, so
   * a throttled call costs nothing at all — hand in a snapshot already taken
   * when the session behind it is about to go away.
   */
  writeTranscript(
    runId: WorkflowRunId,
    nodeId: string,
    snapshot: () => readonly TranscriptItem[]
  ): void
  /** Read off the loop: a long node's transcript is megabytes of JSON. */
  readTranscript(runId: WorkflowRunId, nodeId: string): Promise<readonly TranscriptItem[]>
  /**
   * Writes everything scheduled, now, synchronously. What a quit calls: the
   * app is going away and there is no later. Everywhere else the scheduled
   * write is the write.
   */
  flush(): void
}

/** One file the store writes, and where its next write stands. */
interface Scheduled {
  readonly path: string
  // What to write, asked at write time; replaced by every later call, and
  // absent when this file has nothing outstanding.
  take?: () => unknown
  // What the write in flight is writing. Kept so a flush can put it on disk
  // itself: the process is about to go, and an unfinished write goes with it.
  inflight?: () => unknown
  timer?: ReturnType<typeof setTimeout>
  writing: boolean
  /** When the last write of this file started, for the interval. */
  lastAt: number
}

export function createRunStore(
  root: string,
  onFailure?: (path: string, cause: unknown) => void,
  intervalMs: number = WRITE_INTERVAL_MS
): RunStore {
  const scheduled = new Map<string, Scheduled>()
  // Scratch names are unique per write, so a flush landing beside an
  // in-flight write cannot have the two trample one file.
  let scratchCount = 0

  function runDir(runId: WorkflowRunId): string {
    return join(root, runId)
  }

  function makeDir(dir: string): boolean {
    try {
      mkdirSync(dir, { recursive: true })
      return true
    } catch (cause) {
      onFailure?.(dir, cause)
      return false
    }
  }

  /** The body to write, or nothing when it could not be produced. */
  function body(entry: Scheduled, take: () => unknown): string | undefined {
    try {
      // Compact: this file is read by Crucible and by whoever is debugging
      // it, and pretty-printing a node's transcript multiplied its size by
      // four for nobody's benefit.
      return JSON.stringify(take())
    } catch (cause) {
      onFailure?.(entry.path, cause)
      return undefined
    }
  }

  async function writeNow(entry: Scheduled, take: () => unknown): Promise<void> {
    const text = body(entry, take)
    const scratch = `${entry.path}.${(scratchCount += 1)}.tmp`
    try {
      if (text === undefined) return
      await writeFile(scratch, text, 'utf8')
      await rename(scratch, entry.path)
    } catch (cause) {
      // A record that cannot be written must not take the run down with it:
      // the run is the work, the record is the receipt.
      onFailure?.(entry.path, cause)
      await unlink(scratch).catch(() => {})
    } finally {
      entry.writing = false
      entry.inflight = undefined
      // Anything that arrived while this was in flight gets a write of its
      // own, no sooner than the interval allows.
      arrange(entry)
    }
  }

  /** Starts the next write of this file, or sets the timer that will. */
  function arrange(entry: Scheduled): void {
    if (entry.timer !== undefined || entry.writing || entry.take === undefined) return
    const due = Math.max(0, entry.lastAt + intervalMs - Date.now())
    if (due > 0) {
      entry.timer = setTimeout(() => {
        entry.timer = undefined
        arrange(entry)
      }, due)
      // A record waiting to be written should not hold the app open.
      entry.timer.unref?.()
      return
    }
    const take = entry.take
    entry.take = undefined
    entry.inflight = take
    entry.writing = true
    entry.lastAt = Date.now()
    void writeNow(entry, take)
  }

  /** Every write goes through here: latest value wins, one file at a time. */
  function schedule(key: string, path: string, take: () => unknown, dir: string): void {
    let entry = scheduled.get(key)
    if (entry === undefined) {
      if (!makeDir(dir)) return
      // One entry per file for the store's whole life, so the interval and
      // the write in flight survive every coalescing call.
      entry = { path, writing: false, lastAt: 0 }
      scheduled.set(key, entry)
    }
    entry.take = take
    arrange(entry)
  }

  return {
    load(): readonly RunRecord[] {
      let entries: readonly string[]
      try {
        entries = readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      } catch {
        return []
      }
      const records: RunRecord[] = []
      for (const name of entries) {
        const path = join(root, name, 'run.json')
        try {
          const record = JSON.parse(readFileSync(path, 'utf8')) as RunRecord
          if (typeof record.id === 'string' && typeof record.workflow === 'string') {
            // Backfilled rather than trusted: the directory the record was
            // read from is where it lives, whatever a record written before
            // the field existed says.
            records.push({ ...record, dir: join(root, name) })
          }
        } catch (cause) {
          onFailure?.(path, cause)
        }
      }
      return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    },

    save(run: RunRecord): void {
      const dir = runDir(run.id)
      // The record is read when the write happens, not copied here: the
      // engine mutates its records in place and saves after every change, so
      // what reaches the disk is simply the freshest state of the same run.
      schedule(`run:${run.id}`, join(dir, 'run.json'), () => run, dir)
    },

    runDir,

    artifactDir(runId: WorkflowRunId): string {
      const dir = join(runDir(runId), 'artifacts')
      mkdirSync(dir, { recursive: true })
      return dir
    },

    sessionDir(runId: WorkflowRunId): string {
      const dir = join(runDir(runId), 'sessions')
      mkdirSync(dir, { recursive: true })
      return dir
    },

    writeTranscript(
      runId: WorkflowRunId,
      nodeId: string,
      snapshot: () => readonly TranscriptItem[]
    ): void {
      const dir = join(runDir(runId), 'transcripts')
      schedule(
        `transcript:${runId}:${nodeId}`,
        join(dir, `${transcriptName(nodeId)}.json`),
        snapshot,
        dir
      )
    },

    async readTranscript(runId: WorkflowRunId, nodeId: string): Promise<readonly TranscriptItem[]> {
      try {
        const raw = await readFile(
          join(runDir(runId), 'transcripts', `${transcriptName(nodeId)}.json`),
          'utf8'
        )
        const parsed: unknown = JSON.parse(raw)
        return Array.isArray(parsed) ? (parsed as TranscriptItem[]) : []
      } catch {
        // No transcript yet is an ordinary state, not a failure.
        return []
      }
    },

    flush(): void {
      for (const entry of scheduled.values()) {
        if (entry.timer !== undefined) {
          clearTimeout(entry.timer)
          entry.timer = undefined
        }
        // A write in flight will not finish: this process is leaving.
        const take = entry.take ?? entry.inflight
        if (take === undefined) continue
        entry.take = undefined
        entry.lastAt = Date.now()
        const text = body(entry, take)
        if (text === undefined) continue
        const scratch = `${entry.path}.${(scratchCount += 1)}.tmp`
        try {
          writeFileSync(scratch, text, 'utf8')
          renameSync(scratch, entry.path)
        } catch (cause) {
          onFailure?.(entry.path, cause)
          try {
            unlinkSync(scratch)
          } catch {
            // It was never written; there is nothing to clean up.
          }
        }
      }
    }
  }
}

/** Node ids carry `·` for revisions; the file name keeps to the safe side. */
function transcriptName(nodeId: string): string {
  return encodeURIComponent(nodeId)
}
