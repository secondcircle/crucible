// @vitest-environment node
//
// Characterization of what a file sink does when the filesystem, rather than
// the record, is what fails. The only way to make a write fail after the file
// is open is to fail it from underneath: `node:fs` is mocked here so writes can
// be made to throw mid-launch, and so opens and closes can be counted. Every
// assertion is still made through the sink's own interface — `append`, the file
// on disk, and stderr — plus the fs calls the sink makes, which is the seam the
// failure is injected at.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFileSink, type LogRecord } from './sink'

const filesystem = vi.hoisted(() => ({ failWrites: false, opens: 0, closes: 0, writes: 0 }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    default: actual,
    openSync: (path: string, flags: string): number => {
      filesystem.opens += 1
      return actual.openSync(path, flags)
    },
    closeSync: (handle: number): void => {
      filesystem.closes += 1
      actual.closeSync(handle)
    },
    writeSync: (handle: number, data: string): number => {
      filesystem.writes += 1
      if (filesystem.failWrites) throw new Error('ENOSPC: no space left on device')
      return actual.writeSync(handle, data)
    }
  }
})

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'crucible-log-'))
  temporaryDirectories.push(directory)
  return directory
}

function fileRecords(directory: string): LogRecord[] {
  const files = readdirSync(directory)
  expect(files).toHaveLength(1)
  const text = readFileSync(join(directory, files[0]), 'utf8')
  return text === '' ? [] : text.trim().split('\n').map((line) => JSON.parse(line) as LogRecord)
}

beforeEach(() => {
  filesystem.failWrites = false
  filesystem.opens = 0
  filesystem.closes = 0
  filesystem.writes = 0
})

afterEach(() => {
  vi.restoreAllMocks()
  let directory = temporaryDirectories.pop()
  while (directory !== undefined) {
    rmSync(directory, { recursive: true, force: true })
    directory = temporaryDirectories.pop()
  }
})

describe('a file sink whose disk gives out mid-launch', () => {
  it('stops writing for the rest of the launch after one write fails', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const directory = temporaryDirectory()
    const sink = createFileSink(directory)

    sink.append({ source: 'main', event: 'first' })
    filesystem.failWrites = true
    expect(() => sink.append({ source: 'main', event: 'second' })).not.toThrow()
    filesystem.failWrites = false
    const attemptsSoFar = filesystem.writes
    sink.append({ source: 'main', event: 'third' })

    // The sink neither retries the failed record nor attempts the later one:
    // a single write failure is permanent for that sink, with no buffering.
    expect(filesystem.writes).toBe(attemptsSoFar)
    expect(fileRecords(directory).map((record) => [record.seq, record.event])).toEqual([
      [1, 'first']
    ])
    expect(stderr).toHaveBeenCalledTimes(1)
    expect(stderr.mock.calls[0][0]).toMatch(/^\[crucible\] log sink dropped a record: cannot write /)
  })

  it('spends its one stderr line on the first failure of any kind', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const directory = temporaryDirectory()
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const sink = createFileSink(directory)

    sink.append({ source: 'main', event: 'first' })
    sink.append({ source: 'main', event: 'unserializable', circular })
    filesystem.failWrites = true
    sink.append({ source: 'main', event: 'third' })

    // One reporter per sink, shared by every failure kind: the serialization
    // failure consumed it, so the later write failure is reported nowhere.
    expect(stderr).toHaveBeenCalledTimes(1)
    expect(stderr.mock.calls[0][0]).toMatch(
      /^\[crucible\] log sink dropped a record: cannot serialize record 2:/
    )
    expect(fileRecords(directory).map((record) => [record.seq, record.event])).toEqual([
      [1, 'first']
    ])
  })

  it('never closes the file it opened, because no operation could', () => {
    const directory = temporaryDirectory()

    const sink = createFileSink(directory)
    sink.append({ source: 'main', event: 'app_starting' })
    sink.append({ source: 'main', event: 'app_quitting' })

    expect(Object.keys(sink)).toEqual(['append'])
    expect(filesystem.opens).toBe(1)
    expect(filesystem.closes).toBe(0)
  })
})
