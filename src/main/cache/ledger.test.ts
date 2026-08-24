// @vitest-environment node
//
// The ledger against a temp directory: a real file, real appends, and no
// Electron anywhere. The directory is injected exactly as the quota cache's
// is, so nothing here can reach the machine's own ledger.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CacheMissChanges } from '../../shared/agent/adapter'
import { createCacheLedger, type RecordedCacheMiss } from './ledger'
import { cacheLedgerPath, LEDGER_FILE_NAME, useCacheLedgerDir } from './paths'
import { retentionInForce, useLongRetention } from './retention'

const directories: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crucible-ledger-'))
  directories.push(dir)
  return dir
}

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop() as string, { recursive: true, force: true })
  }
})

const unchanged: CacheMissChanges = {
  model: 'no',
  thinking: 'no',
  jump: 'no',
  compaction: 'no',
  tools: 'unknown',
  rolePrompt: 'unknown'
}

function miss(over: Partial<RecordedCacheMiss> = {}): RecordedCacheMiss {
  return {
    at: '2026-08-21T15:04:11.322Z',
    source: {
      kind: 'session',
      sessionId: 's1',
      title: 'cache miss alerting',
      workspace: '/Users/ike/repos/crucible'
    },
    provider: 'anthropic',
    model: 'claude-opus-5',
    thinkingLevel: 'high',
    tokensRebilled: 118_211,
    dollarsRebilled: 0.62,
    gapMs: 28_920_000,
    changed: unchanged,
    ...over
  }
}

function lines(dir: string): Array<Record<string, unknown>> {
  return readFileSync(join(dir, LEDGER_FILE_NAME), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('the cache ledger', () => {
  it('creates the file on first touch, stamped with a reset line', async () => {
    const dir = tempDir()
    const ledger = createCacheLedger({ dir, clock: () => '2026-08-19T15:04:00.000Z' })
    expect(existsSync(join(dir, LEDGER_FILE_NAME))).toBe(false)

    const health = await ledger.read()

    // The strip's "since" is defined even on a virgin install.
    expect(lines(dir)).toEqual([{ v: 1, type: 'reset', at: '2026-08-19T15:04:00.000Z' }])
    expect(health).toEqual({
      count: 0,
      dollars: 0,
      since: '2026-08-19T15:04:00.000Z',
      ledgerPath: join(dir, LEDGER_FILE_NAME),
      retention: '5m'
    })
  })

  it('writes one whole line per miss, with the retention in force', async () => {
    const dir = tempDir()
    const ledger = createCacheLedger({ dir, retention: '1h' })

    await ledger.append(miss())

    const [, written] = lines(dir)
    expect(written).toEqual({
      v: 1,
      type: 'miss',
      at: '2026-08-21T15:04:11.322Z',
      source: {
        kind: 'session',
        sessionId: 's1',
        title: 'cache miss alerting',
        workspace: '/Users/ike/repos/crucible'
      },
      provider: 'anthropic',
      model: 'claude-opus-5',
      thinkingLevel: 'high',
      retention: '1h',
      tokensRebilled: 118_211,
      dollarsRebilled: 0.62,
      gapMs: 28_920_000,
      changed: unchanged
    })
    // No cause, no severity, no prose warning: facts only.
    expect(JSON.stringify(written)).not.toContain('cause')
  })

  it('serializes concurrent appends into whole lines', async () => {
    const dir = tempDir()
    const ledger = createCacheLedger({ dir })

    await Promise.all(
      Array.from({ length: 25 }, (_unused, index) =>
        ledger.append(miss({ tokensRebilled: index, dollarsRebilled: 0.01 }))
      )
    )

    // Sessions run concurrently; every one of them left exactly one line.
    const written = lines(dir).filter((line) => line.type === 'miss')
    expect(written).toHaveLength(25)
    expect(written.map((line) => line.tokensRebilled).sort((a, b) => Number(a) - Number(b))).toEqual(
      Array.from({ length: 25 }, (_unused, index) => index)
    )
    expect((await ledger.read()).count).toBe(25)
  })

  it('counts and totals only what followed the last reset line', async () => {
    const dir = tempDir()
    let now = '2026-08-19T15:04:00.000Z'
    const ledger = createCacheLedger({ dir, clock: () => now })
    await ledger.append(miss({ dollarsRebilled: 1.2 }))
    await ledger.append(miss({ dollarsRebilled: 1.6 }))

    const before = await ledger.read()
    expect(before.count).toBe(2)
    expect(before.dollars).toBeCloseTo(2.8, 4)

    now = '2026-08-25T09:00:00.000Z'
    const after = await ledger.reset()

    // Nothing is deleted: the count is a view over a file that only grows.
    expect(after).toEqual(expect.objectContaining({ count: 0, dollars: 0, since: now }))
    expect(lines(dir).filter((line) => line.type === 'miss')).toHaveLength(2)

    await ledger.append(miss({ dollarsRebilled: 0.4 }))
    expect(await ledger.read()).toEqual(
      expect.objectContaining({ count: 1, dollars: 0.4, since: now })
    )
  })

  it('announces the counter to every listener after each change', async () => {
    const dir = tempDir()
    const ledger = createCacheLedger({ dir })
    const heard: number[] = []
    const stop = ledger.onChange((health) => heard.push(health.count))

    await ledger.append(miss())
    await ledger.append(miss())
    await ledger.reset()
    stop()
    await ledger.append(miss())

    expect(heard).toEqual([1, 2, 0])
  })

  it('skips lines it does not recognize rather than failing on them', async () => {
    const dir = tempDir()
    const ledger = createCacheLedger({ dir })
    await ledger.append(miss({ dollarsRebilled: 0.5 }))
    // A file this permanent has to survive its own future.
    appendFileSync(
      join(dir, LEDGER_FILE_NAME),
      'not json at all\n' +
        `${JSON.stringify({ v: 7, type: 'miss', dollarsRebilled: 99 })}\n` +
        `${JSON.stringify({ v: 1, type: 'weather', at: '2027-01-01T00:00:00.000Z' })}\n` +
        `${JSON.stringify({ v: 7, type: 'reset', at: '2027-01-01T00:00:00.000Z' })}\n`
    )

    const health = await ledger.read()
    expect(health.count).toBe(1)
    expect(health.dollars).toBeCloseTo(0.5, 4)
  })

  it('counts from the oldest miss when the file holds no reset line', async () => {
    const dir = tempDir()
    appendFileSync(
      join(dir, LEDGER_FILE_NAME),
      `${JSON.stringify({ v: 1, type: 'miss', at: '2026-08-20T10:00:00.000Z', dollarsRebilled: 0.25 })}\n`
    )
    const ledger = createCacheLedger({ dir })

    const health = await ledger.read()
    expect(health.count).toBe(1)
    expect(health.since).toBe('2026-08-20T10:00:00.000Z')
  })

  it('throws rather than guessing a path nobody configured', () => {
    // Every other test in this file injects its own directory, so nothing has
    // configured the module one: an unconfigured launch has no honest answer,
    // and a guess would write somebody else's file forever.
    expect(() => cacheLedgerPath()).toThrow(/never set/)

    const dir = tempDir()
    useCacheLedgerDir(dir)
    expect(cacheLedgerPath()).toBe(join(dir, LEDGER_FILE_NAME))
  })

  it('reads the retention in force from π\u2019s own environment variable', () => {
    expect(retentionInForce({})).toBe('5m')
    expect(retentionInForce({ PI_CACHE_RETENTION: 'long' })).toBe('1h')
    expect(retentionInForce({ PI_CACHE_RETENTION: '5m' })).toBe('5m')

    const dir = tempDir()
    const ledger = createCacheLedger({ dir })
    // Every miss carries whatever the launch is running, unasked.
    expect(ledger.retention).toBe(retentionInForce())
  })

  it('asks for the hour, and yields to an environment that already chose', () => {
    const asked: NodeJS.ProcessEnv = {}
    expect(useLongRetention(asked)).toBe('1h')
    expect(asked.PI_CACHE_RETENTION).toBe('long')

    // An explicit setting wins, which is what keeps the before-and-after in
    // the ledger runnable off one build.
    const chosen: NodeJS.ProcessEnv = { PI_CACHE_RETENTION: 'short' }
    expect(useLongRetention(chosen)).toBe('5m')
    expect(chosen.PI_CACHE_RETENTION).toBe('short')
  })

  it('never fails a turn over a write it could not make', async () => {
    const dir = tempDir()
    // A directory standing where the file belongs: nothing can be appended.
    mkdirSync(join(dir, LEDGER_FILE_NAME))
    const failures: unknown[] = []
    const ledger = createCacheLedger({ dir, onFailure: (cause) => failures.push(cause) })

    await expect(ledger.append(miss())).resolves.toBeUndefined()

    // Nobody was waiting on the write, so the trouble goes to the run log.
    expect(failures).toHaveLength(1)
  })
})
