// @vitest-environment node
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFileSink, createMemorySink, type LogRecord } from './sink'

function parse(lines: readonly string[]): LogRecord[] {
  return lines.map((line) => JSON.parse(line) as LogRecord)
}

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'crucible-log-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  vi.restoreAllMocks()
  let directory = temporaryDirectories.pop()
  while (directory !== undefined) {
    rmSync(directory, { recursive: true, force: true })
    directory = temporaryDirectories.pop()
  }
})

describe('the log sink', () => {
  it('stamps each record with a sequence number of its own, in append order', () => {
    const sink = createMemorySink()

    sink.append({ source: 'main', event: 'app_starting' })
    sink.append({ source: 'main', event: 'window_created' })
    sink.append({ source: 'renderer', event: 'console', level: 'info' })

    expect(parse(sink.lines).map((record) => record.seq)).toEqual([1, 2, 3])
  })

  it('writes one line per record, whatever the record holds', () => {
    const sink = createMemorySink()

    sink.append({ source: 'main', event: 'prompt', prompt: 'two\nlines\r\nand a "quote"' })

    expect(sink.lines).toHaveLength(1)
    expect(sink.lines[0]).not.toMatch(/[\n\r]/)
    expect(parse(sink.lines)[0]).toMatchObject({
      seq: 1,
      source: 'main',
      event: 'prompt',
      prompt: 'two\nlines\r\nand a "quote"'
    })
  })

  it('stamps a timestamp and carries source and turn id through', () => {
    const sink = createMemorySink()

    sink.append({ source: 'main', event: 'turn_started', turnId: 't-3' })

    const [record] = parse(sink.lines)
    expect(record.source).toBe('main')
    expect(record.turnId).toBe('t-3')
    expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('keeps its own ts and seq when an entry carries those names', () => {
    const sink = createMemorySink()

    sink.append({ source: 'main', event: 'first' })
    sink.append({
      source: 'renderer',
      event: 'forwarded_payload',
      seq: 900,
      ts: 'caller-controlled',
      turnId: 't-1'
    })

    const [, record] = parse(sink.lines)
    expect(record.seq).toBe(2)
    expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(record.source).toBe('renderer')
    expect(record.turnId).toBe('t-1')
  })

  it('keeps its own ts and seq in the file adapter too', () => {
    const directory = temporaryDirectory()

    const sink = createFileSink(directory)
    sink.append({ source: 'main', event: 'app_starting' })
    sink.append({ source: 'main', event: 'hostile', ts: 0, seq: -1 })

    const file = join(directory, readdirSync(directory)[0])
    const records = parse(readFileSync(file, 'utf8').trim().split('\n'))
    expect(records.map((record) => record.seq)).toEqual([1, 2])
    expect(records[1].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('writes fields whose names collide with Object.prototype through', () => {
    const sink = createMemorySink()

    sink.append({ source: 'main', event: 'console', toString: 'renderer text', constructor: 1 })

    expect(parse(sink.lines)[0]).toMatchObject({
      seq: 1,
      event: 'console',
      toString: 'renderer text',
      constructor: 1
    })
  })

  it('drops a record it cannot serialize, keeping the numbers it spent', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const sink = createMemorySink()
    const circular: Record<string, unknown> = {}
    circular.self = circular

    sink.append({ source: 'main', event: 'first' })
    sink.append({ source: 'main', event: 'bad', circular })
    sink.append({ source: 'main', event: 'third' })

    expect(parse(sink.lines).map((record) => [record.seq, record.event])).toEqual([
      [1, 'first'],
      [3, 'third']
    ])
    expect(stderr).toHaveBeenCalledTimes(1)
  })

  it('creates a missing directory and writes one JSONL file for the launch', () => {
    const directory = join(temporaryDirectory(), 'logs')

    const sink = createFileSink(directory)
    sink.append({ source: 'main', event: 'app_starting' })
    sink.append({ source: 'main', event: 'app_ready' })

    const files = readdirSync(directory)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d-]+Z\.jsonl$/)

    const lines = readFileSync(join(directory, files[0]), 'utf8').split('\n')
    expect(lines.at(-1)).toBe('')
    expect(parse(lines.slice(0, -1))).toMatchObject([
      { seq: 1, source: 'main', event: 'app_starting' },
      { seq: 2, source: 'main', event: 'app_ready' }
    ])
  })

  it('says once on stderr that it cannot write, and lets the caller run on', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const blocked = join(temporaryDirectory(), 'logs')
    writeFileSync(blocked, 'not a directory')

    const sink = createFileSink(blocked)

    expect(stderr).toHaveBeenCalledTimes(1)
    expect(stderr.mock.calls[0][0]).toMatch(/^\[crucible\] log sink dropped a record:/)

    expect(() => {
      sink.append({ source: 'main', event: 'app_starting' })
      sink.append({ source: 'main', event: 'app_ready' })
    }).not.toThrow()
    expect(stderr).toHaveBeenCalledTimes(1)
  })
})
