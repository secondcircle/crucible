// @vitest-environment node
//
// The wiring, not the engine: the engine's rules are proven at its own seam,
// and what nothing proved before this file is that a real launch hands the
// engine the seams it only pretends to have a default for. Only
// `createWorkflowEngine` is stood in for here — the loader, the store and the
// node-session factory are the real ones (the factory imports π lazily,
// inside `start`, so constructing it loads no SDK) — so a field dropped
// anywhere on the way down fails this test.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '../../shared/agent/port'
import type { LogEntry, LogSink } from '../log/sink'
import type { EngineOptions, WorkflowEngine } from './engine'
import { selectWorkflowRunService } from './select-service'

const stood = vi.hoisted(() => ({ options: [] as unknown[] }))

vi.mock('./engine', () => ({
  createWorkflowEngine: (options: unknown): WorkflowEngine => {
    stood.options.push(options)
    return {
      runs: () => [],
      start: () => Promise.reject(new Error('not this test')),
      pause: () => {},
      resume: () => Promise.reject(new Error('not this test')),
      cancel: () => {},
      wake: () => {},
      dismiss: () => {},
      adopt: () => {},
      answer: () => {},
      nodeTranscript: () => [],
      dispose: () => {}
    }
  }
}))

function memorySink(): { sink: LogSink; entries: LogEntry[] } {
  const entries: LogEntry[] = []
  return { sink: { append: (entry) => entries.push(entry) }, entries }
}

const dirs: string[] = []

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crucible-runs-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  stood.options.length = 0
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const engineOptions = (): EngineOptions | undefined =>
  stood.options.at(-1) as EngineOptions | undefined

describe('choosing a workflow run service', () => {
  it('tells the engine which orchestrator sessions still exist', () => {
    const alive = new Set(['kept'])

    selectWorkflowRunService('sdk', memorySink().sink, {
      appPath: process.cwd(),
      stateDir: stateDir(),
      deliver: () => {},
      sessionExists: (sessionId) => alive.has(sessionId)
    })

    // Absent, the engine presumes every recorded session is alive, so a run
    // resuming to a deleted orchestrator would report into nothing forever
    // and never park for adoption.
    const predicate = engineOptions()?.sessionExists
    expect(predicate).toBeTypeOf('function')
    expect(predicate?.('kept' as SessionId)).toBe(true)
    expect(predicate?.('deleted' as SessionId)).toBe(false)
  })

  it('builds no engine at all for the fake flavor', () => {
    selectWorkflowRunService('fake', memorySink().sink, {
      appPath: process.cwd(),
      stateDir: stateDir(),
      deliver: () => {},
      sessionExists: () => true
    })

    expect(stood.options).toEqual([])
  })

  it('records the choice, so every launch says which one it made', () => {
    const log = memorySink()

    selectWorkflowRunService('fake', log.sink, {
      appPath: process.cwd(),
      stateDir: stateDir(),
      deliver: () => {},
      sessionExists: () => true
    })

    expect(log.entries).toEqual([
      { source: 'main', event: 'workflow_run_service_selected', service: 'fake' }
    ])
  })
})
