// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunRecord } from '../../shared/workflows/run'
import { createRunStore } from './store'

const scratch: string[] = []

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crucible-run-store-'))
  scratch.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function record(id: string, createdAt: string): RunRecord {
  return {
    id,
    workflow: 'adhoc',
    status: 'complete',
    workspacePath: '/repos/thing',
    workspaceName: 'thing',
    inputs: {},
    nodes: [],
    createdAt
  }
}

describe('run store', () => {
  it('loads what was saved, newest first, across store instances', () => {
    const root = tempRoot()
    const store = createRunStore(root)
    store.save(record('aa11', '2026-08-20T10:00:00.000Z'))
    store.save(record('bb22', '2026-08-20T11:00:00.000Z'))

    const again = createRunStore(root)
    expect(again.load().map((run) => run.id)).toEqual(['bb22', 'aa11'])
  })

  it('answers nothing for a root that does not exist yet', () => {
    expect(createRunStore(join(tempRoot(), 'never-made')).load()).toEqual([])
  })

  it('keeps transcripts per node, revision ids included', () => {
    const store = createRunStore(tempRoot())
    store.save(record('cc33', '2026-08-20T10:00:00.000Z'))
    store.writeTranscript('cc33', 'review·r1', [{ kind: 'assistant', markdown: 'judged.' }])
    expect(store.readTranscript('cc33', 'review·r1')).toEqual([
      { kind: 'assistant', markdown: 'judged.' }
    ])
    // No transcript yet is an ordinary state, not a failure.
    expect(store.readTranscript('cc33', 'builder')).toEqual([])
  })

  it('makes an artifact directory on first ask', () => {
    const root = tempRoot()
    const store = createRunStore(root)
    expect(store.artifactDir('dd44')).toBe(join(root, 'dd44', 'artifacts'))
  })
})
