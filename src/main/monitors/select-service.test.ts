import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LogEntry, LogSink } from '../log/sink'
import { selectMonitorService } from './select-service'

// Where the records live and which process seam answers a check: the one
// thing a flavor decides about monitors. Everything else — the model, the
// endings, the wording — is the same object in both.

let stateDir: string
const appended: LogEntry[] = []

const log: LogSink = {
  append: (entry: LogEntry) => {
    appended.push(entry)
  }
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'crucible-monitor-state-'))
  appended.length = 0
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

describe('choosing the monitor service', () => {
  it('keeps its records in Crucible\u2019s own state directory, and nowhere near .pi', async () => {
    const service = selectMonitorService('fake', log, {
      stateDir,
      deliver: async () => 'delivered',
      sessionExists: () => true
    })
    await service.tools.set({ kind: 'session', sessionId: 's1' }, stateDir, {
      description: 'a port to free up',
      reason: 'so I can start the dev server',
      command: 'watch pass'
    })

    const path = join(stateDir, 'monitors.json')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toContain('a port to free up')
    // The whole state directory is Crucible's, flavor-scoped by whoever made
    // it: nothing under a `.pi` folder is written on a monitor's account.
    expect(existsSync(join(stateDir, '.pi'))).toBe(false)
    service.dispose()
  })

  it('runs the scripted checks in the fake flavor, so a dev launch pays for nothing', async () => {
    const service = selectMonitorService('fake', log, {
      stateDir,
      deliver: async () => 'delivered',
      sessionExists: () => true
    })
    service.begin()
    await service.tools.set({ kind: 'session', sessionId: 's1' }, stateDir, {
      description: 'CI to finish',
      reason: 'so I can read the log',
      // The scripted runner reads the word, and no process is started at all.
      command: 'watch pass'
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    const [live] = (await service.snapshot()).monitors
    expect(live.checks).toBeGreaterThan(0)
    expect(live.last?.output.text).toBe('in_progress')
    service.dispose()
  })

  it('records which flavor answered', () => {
    selectMonitorService('sdk', log, {
      stateDir,
      deliver: async () => 'delivered',
      sessionExists: () => true
    }).dispose()
    expect(appended[0]).toMatchObject({ event: 'monitor_service_selected', service: 'sdk' })
  })
})
