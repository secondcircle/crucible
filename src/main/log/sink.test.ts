// @vitest-environment node
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFileSink, createMemorySink, type LogEntry, type LogRecord } from './sink'

function parse(lines: readonly string[]): LogRecord[] {
  return lines.map((line) => JSON.parse(line) as LogRecord)
}

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
  return text === '' ? [] : parse(text.trim().split('\n'))
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
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

  it('creates its file when it is made, before any record is appended', () => {
    const directory = join(temporaryDirectory(), 'logs')

    createFileSink(directory)

    const files = readdirSync(directory)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d-]+Z\.jsonl$/)
    expect(statSync(join(directory, files[0])).size).toBe(0)
  })

  it('drops a record the file adapter cannot serialize and writes the next one', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const directory = temporaryDirectory()
    const circular: Record<string, unknown> = {}
    circular.self = circular

    const sink = createFileSink(directory)
    sink.append({ source: 'main', event: 'first' })
    sink.append({ source: 'main', event: 'bad', circular })
    sink.append({ source: 'main', event: 'third' })

    expect(fileRecords(directory).map((record) => [record.seq, record.event])).toEqual([
      [1, 'first'],
      [3, 'third']
    ])
    expect(stderr).toHaveBeenCalledTimes(1)
  })

  it('shares one file with a sink made in the same millisecond, sequences and all', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-17T09:15:00.000Z'))
    const directory = temporaryDirectory()

    const first = createFileSink(directory)
    const second = createFileSink(directory)
    first.append({ source: 'main', event: 'from_first' })
    second.append({ source: 'main', event: 'from_second' })
    first.append({ source: 'main', event: 'from_first_again' })

    expect(readdirSync(directory)).toEqual(['2026-08-17T09-15-00-000Z.jsonl'])
    expect(fileRecords(directory).map((record) => [record.seq, record.event])).toEqual([
      [1, 'from_first'],
      [1, 'from_second'],
      [2, 'from_first_again']
    ])
  })

  it('drops an own __proto__ field instead of writing it through', () => {
    const sink = createMemorySink()

    sink.append(
      JSON.parse('{"source":"main","event":"forwarded","__proto__":{"polluted":true}}') as LogEntry
    )

    expect(sink.lines).toHaveLength(1)
    const [record] = parse(sink.lines)
    expect(record).toMatchObject({ seq: 1, source: 'main', event: 'forwarded' })
    expect(Object.keys(record)).toEqual(['ts', 'seq', 'source', 'event'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('lets an own toJSON replace the whole stamped record', () => {
    const sink = createMemorySink()

    sink.append({ source: 'main', event: 'forwarded', toJSON: () => ({ replaced: true }) })

    expect(sink.lines).toEqual(['{"replaced":true}'])
  })

  it('takes any entry a cast can produce: the types are the only validation', () => {
    const sink = createMemorySink()
    const entry: LogEntry = { source: 'renderer', event: 'console', level: 'warn', count: 2 }

    sink.append(entry)
    // @ts-expect-error a source outside main | renderer is not a log source
    sink.append({ source: 'agent', event: 'turn_started' })
    // @ts-expect-error every entry names the event it records
    sink.append({ source: 'main' })

    expect(parse(sink.lines).map((record) => [record.seq, record.source, record.event])).toEqual([
      [1, 'renderer', 'console'],
      [2, 'agent', 'turn_started'],
      [3, 'main', undefined]
    ])
  })
})
