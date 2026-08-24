// @vitest-environment node
//
// The scheduler's own file: what a relaunch reads back, and what happens when
// there is nothing to read. It lives under Crucible's state directory, never
// the repository and never anything of π's.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSchedulerStore, EMPTY_SCHEDULER_STATE, type SchedulerState } from './state'

const scratch: string[] = []

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crucible-scheduler-'))
  scratch.push(dir)
  return join(dir, 'schedules.json')
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const STATE: SchedulerState = {
  workspaces: {
    '/repos/crucible': {
      allPaused: true,
      schedules: {
        triage: { enabled: false, lastConsidered: '2026-08-24T09:00:00.000Z' },
        'deps-audit': { lastConsidered: '2026-08-24T07:00:00.000Z' }
      }
    }
  }
}

describe('the scheduler store', () => {
  it('round-trips the toggles, the instants and the pause', () => {
    const path = tempFile()
    const store = createSchedulerStore(path)

    store.save(STATE)

    expect(createSchedulerStore(path).load()).toEqual(STATE)
    // Written whole, as JSON a person can read.
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(STATE)
  })

  it('reads no file, and an unreadable one, as nothing remembered', () => {
    const path = tempFile()
    expect(createSchedulerStore(path).load()).toEqual(EMPTY_SCHEDULER_STATE)

    writeFileSync(path, 'not json at all', 'utf8')
    expect(createSchedulerStore(path).load()).toEqual(EMPTY_SCHEDULER_STATE)

    writeFileSync(path, '{"workspaces": 7}', 'utf8')
    expect(createSchedulerStore(path).load()).toEqual(EMPTY_SCHEDULER_STATE)
  })

  // A state file that cannot be written must not stop the scheduler: the
  // launch keeps firing from memory and says so on the log.
  it('reports a write it could not make instead of throwing at the scheduler', () => {
    const failures: unknown[] = []
    // A file where the directory would have to be: nothing can be written
    // under it, however many directories are made.
    const blocked = tempFile()
    writeFileSync(blocked, 'in the way', 'utf8')
    const store = createSchedulerStore(join(blocked, 'schedules.json'), (cause) =>
      failures.push(cause)
    )

    expect(() => store.save(STATE)).not.toThrow()
    expect(failures).toHaveLength(1)
  })
})
