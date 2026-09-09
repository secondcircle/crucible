import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TranscriptItem } from '../../shared/agent/port'
import type { RunRecord, WorkflowRunId } from '../../shared/workflows/run'

// The run record outlives the run: every record ever written stays readable,
// which is what lets the global runs view show finished work across
// launches. Everything lives under Crucible's own state directory — never
// the repository, and never anything of π's.
//
// Layout: <root>/<runId>/run.json, artifacts/, transcripts/<node>.json.

export interface RunStore {
  /** Every persisted record, newest first. Unreadable ones are skipped. */
  load(): readonly RunRecord[]
  save(run: RunRecord): void
  /** The run's own directory: run.json, artifacts/, transcripts/. */
  runDir(runId: WorkflowRunId): string
  /** The run's artifact directory, created on first ask. */
  artifactDir(runId: WorkflowRunId): string
  writeTranscript(runId: WorkflowRunId, nodeId: string, items: readonly TranscriptItem[]): void
  /** Read off the loop: a long node's transcript is megabytes of JSON. */
  readTranscript(runId: WorkflowRunId, nodeId: string): Promise<readonly TranscriptItem[]>
}

export function createRunStore(
  root: string,
  onFailure?: (path: string, cause: unknown) => void
): RunStore {
  function runDir(runId: WorkflowRunId): string {
    return join(root, runId)
  }

  function writeJsonAtomic(path: string, value: unknown): void {
    try {
      const scratch = `${path}.tmp`
      writeFileSync(scratch, JSON.stringify(value, null, 2), 'utf8')
      renameSync(scratch, path)
    } catch (cause) {
      // A record that cannot be written must not take the run down with it:
      // the run is the work, the record is the receipt.
      onFailure?.(path, cause)
    }
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
      try {
        mkdirSync(runDir(run.id), { recursive: true })
      } catch (cause) {
        onFailure?.(runDir(run.id), cause)
        return
      }
      writeJsonAtomic(join(runDir(run.id), 'run.json'), run)
    },

    runDir,

    artifactDir(runId: WorkflowRunId): string {
      const dir = join(runDir(runId), 'artifacts')
      mkdirSync(dir, { recursive: true })
      return dir
    },

    writeTranscript(
      runId: WorkflowRunId,
      nodeId: string,
      items: readonly TranscriptItem[]
    ): void {
      const dir = join(runDir(runId), 'transcripts')
      try {
        mkdirSync(dir, { recursive: true })
      } catch (cause) {
        onFailure?.(dir, cause)
        return
      }
      writeJsonAtomic(join(dir, `${transcriptName(nodeId)}.json`), items)
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
    }
  }
}

/** Node ids carry `·` for revisions; the file name keeps to the safe side. */
function transcriptName(nodeId: string): string {
  return encodeURIComponent(nodeId)
}
