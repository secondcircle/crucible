import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { MonitorRecord } from './model'

export interface MonitorStore {
  load(): readonly MonitorRecord[]
  save(records: readonly MonitorRecord[]): void
}

/** An unreadable or absent file is an empty store, never a failed launch. */
export function createMonitorStore(
  path: string,
  onFailure?: (cause: unknown) => void
): MonitorStore {
  return {
    load(): readonly MonitorRecord[] {
      let body: string
      try {
        body = readFileSync(path, 'utf8')
      } catch {
        return []
      }
      try {
        const parsed: unknown = JSON.parse(body)
        if (!Array.isArray(parsed)) return []
        return parsed.filter(isRecord)
      } catch (cause) {
        onFailure?.(cause)
        return []
      }
    },

    save(records: readonly MonitorRecord[]): void {
      try {
        mkdirSync(dirname(path), { recursive: true })
        const temporary = `${path}.tmp`
        writeFileSync(temporary, `${JSON.stringify(records, null, 2)}\n`, 'utf8')
        renameSync(temporary, path)
      } catch (cause) {
        // A store that cannot be written must not take the launch down with
        // it: the monitors of this launch go on working in memory.
        onFailure?.(cause)
      }
    }
  }
}

export function memoryMonitorStore(
  initial: readonly MonitorRecord[] = []
): MonitorStore & { readonly current: readonly MonitorRecord[] } {
  let held: readonly MonitorRecord[] = initial
  return {
    get current(): readonly MonitorRecord[] {
      return held
    },
    load: () => held,
    // A copy, so what the store holds is what was saved rather than whatever
    // the caller's array becomes next.
    save(records: readonly MonitorRecord[]): void {
      held = [...records]
    }
  }
}

// Enough of a shape check that a hand-edited or half-written file cannot crash
// the sweep. Anything else about a record is the model's business.
function isRecord(candidate: unknown): candidate is MonitorRecord {
  if (typeof candidate !== 'object' || candidate === null) return false
  const record = candidate as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.command !== 'string') return false
  if (record.status !== 'live' && record.status !== 'ended') return false
  const owner = record.owner as { kind?: unknown } | undefined
  return owner?.kind === 'session' || owner?.kind === 'node'
}
