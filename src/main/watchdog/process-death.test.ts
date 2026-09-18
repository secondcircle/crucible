// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createMemorySink, type LogRecord } from '../log/sink'
import {
  watchProcessDeath,
  type ChildGone,
  type ProcessDeathSource,
  type RenderGone,
  type WatchedContents
} from './process-death'

/** Electron's `app`, as far as this watches it: an emitter of three events. */
interface FakeApp extends ProcessDeathSource {
  renderGone(contents: WatchedContents, details: RenderGone): void
  childGone(details: ChildGone): void
  created(contents: WatchedContents): void
}

function fakeApp(): FakeApp {
  type Render = (event: unknown, contents: WatchedContents, details: RenderGone) => void
  type Child = (event: unknown, details: ChildGone) => void
  type Made = (event: unknown, contents: WatchedContents) => void
  const render: Render[] = []
  const child: Child[] = []
  const made: Made[] = []
  const on = (event: string, listener: Render | Child | Made): void => {
    if (event === 'render-process-gone') render.push(listener as Render)
    if (event === 'child-process-gone') child.push(listener as Child)
    if (event === 'web-contents-created') made.push(listener as Made)
  }
  return {
    on: on as FakeApp['on'],
    renderGone(contents, details) {
      for (const listener of render) listener({}, contents, details)
    },
    childGone(details) {
      for (const listener of child) listener({}, details)
    },
    created(contents) {
      for (const listener of made) listener({}, contents)
    }
  }
}

function fakeContents(
  type = 'window',
  url = 'http://localhost:5222/'
): WatchedContents & { hang(): void; recover(): void; destroy(): void } {
  const listeners = new Map<string, () => void>()
  let destroyed = false
  return {
    getType: () => type,
    getURL: () => url,
    isDestroyed: () => destroyed,
    on(event, listener) {
      listeners.set(event, listener)
    },
    hang: () => listeners.get('unresponsive')?.(),
    recover: () => listeners.get('responsive')?.(),
    destroy: () => {
      destroyed = true
    }
  }
}

const read = (lines: readonly string[]): LogRecord[] =>
  lines.map((line) => JSON.parse(line) as LogRecord)

describe('process death on the run log', () => {
  it('records a renderer that died, with the reason and the exit code', () => {
    const log = createMemorySink()
    const app = fakeApp()
    watchProcessDeath(app, log)

    app.renderGone(fakeContents(), { reason: 'crashed', exitCode: 133 })

    expect(read(log.lines)).toEqual([
      expect.objectContaining({
        source: 'main',
        event: 'render_process_gone',
        reason: 'crashed',
        exitCode: 133,
        contentsType: 'window',
        url: 'http://localhost:5222/'
      })
    ])
  })

  it('records a GPU or utility child that died, naming which', () => {
    const log = createMemorySink()
    const app = fakeApp()
    watchProcessDeath(app, log)

    app.childGone({ type: 'GPU', reason: 'abnormal-exit', exitCode: 9, serviceName: 'viz' })

    expect(read(log.lines)).toEqual([
      expect.objectContaining({
        event: 'child_process_gone',
        processType: 'GPU',
        reason: 'abnormal-exit',
        exitCode: 9,
        serviceName: 'viz'
      })
    ])
  })

  it('records a renderer going unresponsive and coming back', () => {
    const log = createMemorySink()
    const app = fakeApp()
    watchProcessDeath(app, log)

    const window = fakeContents()
    app.created(window)
    window.hang()
    window.recover()

    expect(read(log.lines).map((line) => line.event)).toEqual([
      'renderer_unresponsive',
      'renderer_responsive'
    ])
  })

  it('watches an exhibit guest as closely as the window', () => {
    const log = createMemorySink()
    const app = fakeApp()
    watchProcessDeath(app, log)

    const guest = fakeContents('webview', 'https://example.invalid/mock.html')
    app.created(guest)
    guest.hang()

    expect(read(log.lines)[0]).toMatchObject({
      event: 'renderer_unresponsive',
      contentsType: 'webview',
      url: 'https://example.invalid/mock.html'
    })
  })

  it('still records the death of a renderer too far gone to describe itself', () => {
    const log = createMemorySink()
    const app = fakeApp()
    watchProcessDeath(app, log)

    const dead = fakeContents()
    dead.destroy()
    app.renderGone(dead, { reason: 'oom', exitCode: 0 })

    expect(read(log.lines)[0]).toMatchObject({
      event: 'render_process_gone',
      reason: 'oom',
      contentsType: 'destroyed',
      url: ''
    })
  })
})
