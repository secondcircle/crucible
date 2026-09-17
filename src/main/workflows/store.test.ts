// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TranscriptItem } from '../../shared/agent/port'
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

/** A transcript big enough that writing it inline would be felt. */
function bigTranscript(): readonly TranscriptItem[] {
  return Array.from({ length: 4000 }, (_, at) => ({
    kind: 'assistant' as const,
    markdown: `turn ${at} ${'x'.repeat(200)}`
  }))
}

const settled = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('run store', () => {
  it('loads what was saved, newest first, across store instances', async () => {
    const root = tempRoot()
    const store = createRunStore(root, undefined, 0)
    store.save(record('aa11', '2026-08-20T10:00:00.000Z'))
    store.save(record('bb22', '2026-08-20T11:00:00.000Z'))
    await settled()

    const again = createRunStore(root)
    expect(again.load().map((run) => run.id)).toEqual(['bb22', 'aa11'])
  })

  it('answers nothing for a root that does not exist yet', () => {
    expect(createRunStore(join(tempRoot(), 'never-made')).load()).toEqual([])
  })

  it('keeps transcripts per node, revision ids included', async () => {
    const store = createRunStore(tempRoot(), undefined, 0)
    store.save(record('cc33', '2026-08-20T10:00:00.000Z'))
    store.writeTranscript('cc33', 'review·r1', () => [{ kind: 'assistant', markdown: 'judged.' }])
    await settled()
    await expect(store.readTranscript('cc33', 'review·r1')).resolves.toEqual([
      { kind: 'assistant', markdown: 'judged.' }
    ])
    // No transcript yet is an ordinary state, not a failure.
    await expect(store.readTranscript('cc33', 'builder')).resolves.toEqual([])
  })

  it('makes an artifact directory and a session directory on first ask', () => {
    const root = tempRoot()
    const store = createRunStore(root)
    expect(store.artifactDir('dd44')).toBe(join(root, 'dd44', 'artifacts'))
    expect(existsSync(store.sessionDir('dd44'))).toBe(true)
    expect(store.sessionDir('dd44')).toBe(join(root, 'dd44', 'sessions'))
  })
})

describe('what a write costs the caller', () => {
  it('writes nothing on the thread that asked, however big the record', async () => {
    const root = tempRoot()
    const store = createRunStore(root, undefined, 0)
    const transcript = bigTranscript()
    const path = join(root, 'ee55', 'transcripts', 'builder.json')

    const before = Date.now()
    store.save(record('ee55', '2026-08-20T10:00:00.000Z'))
    store.writeTranscript('ee55', 'builder', () => transcript)
    const spent = Date.now() - before

    // The call scheduled and returned: nothing is on disk yet, and the
    // megabyte of JSON has not even been produced. The bound is loose
    // because a loaded machine is where this matters and where it is run.
    expect(existsSync(path)).toBe(false)
    expect(spent).toBeLessThan(100)

    await settled(60)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveLength(transcript.length)
  })

  it('does not hold the event loop while a run at full activity writes', async () => {
    const root = tempRoot()
    const store = createRunStore(root, undefined, 5)
    const transcript = bigTranscript()

    // Four nodes reporting activity ten times a second for a second, which
    // is what three or four nodes under load looked like.
    let worstLag = 0
    let last = Date.now()
    const sampler = setInterval(() => {
      const now = Date.now()
      worstLag = Math.max(worstLag, now - last - 10)
      last = now
    }, 10)
    try {
      for (let beat = 0; beat < 100; beat += 1) {
        for (const node of ['spec', 'builder', 'review', 'gate']) {
          store.save(record('ff66', '2026-08-20T10:00:00.000Z'))
          store.writeTranscript('ff66', node, () => transcript)
        }
        await settled(10)
      }
    } finally {
      clearInterval(sampler)
    }

    // The stall watchdog calls a quarter second late a stall; nothing here
    // comes near it, because nothing here writes on this thread.
    expect(worstLag).toBeLessThan(200)
  })

  it('coalesces a storm into one write per interval, latest value winning', async () => {
    const root = tempRoot()
    const store = createRunStore(root, undefined, 40)
    let taken = 0
    for (let at = 0; at < 50; at += 1) {
      store.writeTranscript('gg77', 'builder', () => {
        taken += 1
        return [{ kind: 'assistant', markdown: `turn ${at}` }]
      })
    }
    await settled(120)

    // One write went out at once and one trailing write carried the latest
    // value; the forty-eight in between cost nothing but a function call.
    expect(taken).toBeLessThanOrEqual(2)
    const written = JSON.parse(
      readFileSync(join(root, 'gg77', 'transcripts', 'builder.json'), 'utf8')
    ) as TranscriptItem[]
    expect(written).toEqual([{ kind: 'assistant', markdown: 'turn 49' }])
  })

  it('never stacks a write behind one in flight', async () => {
    const root = tempRoot()
    const store = createRunStore(root, undefined, 0)
    let taken = 0
    // Every call while the first write is in flight collapses into one
    // trailing write, so the snapshot is taken twice however many arrive.
    for (let at = 0; at < 200; at += 1) {
      store.writeTranscript('hh88', 'builder', () => {
        taken += 1
        return [{ kind: 'assistant', markdown: `turn ${at}` }]
      })
    }
    await settled(60)
    expect(taken).toBe(2)
  })

  it('writes compactly', async () => {
    const root = tempRoot()
    const store = createRunStore(root, undefined, 0)
    store.save(record('ii99', '2026-08-20T10:00:00.000Z'))
    await settled()
    const body = readFileSync(join(root, 'ii99', 'run.json'), 'utf8')
    expect(body).not.toContain('\n')
    expect(JSON.parse(body)).toMatchObject({ id: 'ii99' })
  })

  it('flushes what it was holding, synchronously, for a quit', async () => {
    const root = tempRoot()
    const store = createRunStore(root, undefined, 60_000)
    // The first write of a file goes out at once; everything after it waits
    // out the interval, which here is longer than the app has left.
    store.save(record('jj00', '2026-08-20T10:00:00.000Z'))
    store.writeTranscript('jj00', 'builder', () => [{ kind: 'assistant', markdown: 'first' }])
    await settled()

    store.save({ ...record('jj00', '2026-08-20T10:00:00.000Z'), status: 'interrupted' })
    store.writeTranscript('jj00', 'builder', () => [{ kind: 'assistant', markdown: 'last word' }])
    await settled()
    expect(createRunStore(root).load()[0].status).toBe('complete')

    store.flush()

    expect(createRunStore(root).load()[0].status).toBe('interrupted')
    expect(
      JSON.parse(readFileSync(join(root, 'jj00', 'transcripts', 'builder.json'), 'utf8'))
    ).toEqual([{ kind: 'assistant', markdown: 'last word' }])
  })

  it('reports a write it cannot make and keeps taking calls', async () => {
    const failures: string[] = []
    const root = tempRoot()
    const store = createRunStore(root, (path) => failures.push(path), 0)
    const circular: Record<string, unknown> = {}
    circular.self = circular
    store.writeTranscript('kk11', 'builder', () => circular as unknown as TranscriptItem[])
    await settled()
    expect(failures).toHaveLength(1)

    store.writeTranscript('kk11', 'builder', () => [{ kind: 'assistant', markdown: 'fine' }])
    await settled()
    await expect(store.readTranscript('kk11', 'builder')).resolves.toEqual([
      { kind: 'assistant', markdown: 'fine' }
    ])
    // The scratch file of the write that failed is not left behind.
    expect(existsSync(join(root, 'kk11', 'transcripts', 'builder.json.1.tmp'))).toBe(false)
  })
})
