// @vitest-environment node
//
// The forwarding is tested where Electron meets it: a stand-in `webContents`
// that hands out the two events Electron documents for renderer output, and the
// in-memory sink on the other side. What is asserted is what a reader of the
// run log gets — a renderer line in main's stream, marked as the renderer's.
import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import { createMemorySink, type LogRecord } from './sink'
import { forwardRendererOutput } from './renderer-output'

type ConsoleMessage = {
  message: string
  level: 'debug' | 'info' | 'warning' | 'error'
  lineNumber: number
  sourceId: string
}

/** As much of a `webContents` as the forwarding touches, plus a way to fire. */
function stubWebContents(): {
  webContents: WebContents
  says(details: ConsoleMessage): void
  failsPreload(path: string, error: Error): void
} {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const webContents = {
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, listener)
    }
  }

  function fire(event: string, ...args: unknown[]): void {
    const listener = listeners.get(event)
    if (listener === undefined) throw new Error(`nothing is listening for ${event}`)
    listener(...args)
  }

  return {
    webContents: webContents as unknown as WebContents,
    says: (details) => fire('console-message', details),
    failsPreload: (path, error) => fire('preload-error', { preventDefault() {} }, path, error)
  }
}

function consoleMessage(overrides: Partial<ConsoleMessage> = {}): ConsoleMessage {
  return {
    message: '[crucible] preload loaded',
    level: 'info',
    lineNumber: 42,
    sourceId: 'http://localhost:5173/src/main.tsx',
    ...overrides
  }
}

describe('renderer output in main\u2019s log', () => {
  it('appends a console line to the same sink, marked as the renderer\u2019s', () => {
    const sink = createMemorySink()
    const renderer = stubWebContents()
    sink.append({ source: 'main', event: 'window_created' })

    forwardRendererOutput(renderer.webContents, sink)
    renderer.says(consoleMessage())

    const records = sink.lines.map((line) => JSON.parse(line) as LogRecord)
    expect(records.map((record) => [record.seq, record.source, record.event])).toEqual([
      [1, 'main', 'window_created'],
      [2, 'renderer', 'console']
    ])
    expect(records[1]).toMatchObject({
      level: 'info',
      message: '[crucible] preload loaded',
      lineNumber: 42,
      sourceId: 'http://localhost:5173/src/main.tsx'
    })
  })

  it('forwards all four levels, in the order the renderer said them', () => {
    const sink = createMemorySink()
    const renderer = stubWebContents()
    forwardRendererOutput(renderer.webContents, sink)

    for (const level of ['debug', 'info', 'warning', 'error'] as const) {
      renderer.says(consoleMessage({ level, message: `said at ${level}` }))
    }

    expect(sink.lines.map((line) => JSON.parse(line) as LogRecord)).toMatchObject([
      { seq: 1, source: 'renderer', event: 'console', level: 'debug', message: 'said at debug' },
      { seq: 2, source: 'renderer', event: 'console', level: 'info', message: 'said at info' },
      { seq: 3, source: 'renderer', event: 'console', level: 'warning', message: 'said at warning' },
      { seq: 4, source: 'renderer', event: 'console', level: 'error', message: 'said at error' }
    ])
  })

  it('appends a preload failure with the stack the renderer never sees', () => {
    const sink = createMemorySink()
    const renderer = stubWebContents()
    forwardRendererOutput(renderer.webContents, sink)

    renderer.failsPreload('/out/preload/index.js', new Error('contextBridge is not defined'))

    const [record] = sink.lines.map((line) => JSON.parse(line) as LogRecord)
    expect(record).toMatchObject({
      source: 'renderer',
      event: 'preload_error',
      preloadPath: '/out/preload/index.js',
      message: 'contextBridge is not defined'
    })
    expect(String(record.stack)).toContain('contextBridge is not defined')
  })
})
