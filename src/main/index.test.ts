// @vitest-environment node
//
// Characterization of the composition root. `src/main/index.ts` is a module
// whose interface is what it does when Electron loads it: it builds the run
// log, appends the launch's lifecycle records, and registers the app callbacks.
// So the test drives it the way Electron does — import the module, resolve
// readiness, fire the app events — with `electron` and the window factory
// replaced by stand-ins, and asserts on the real JSONL file the real sink
// writes under the app path. Nothing here reaches past that: the log file and
// the Electron calls are the only outputs this module has.
//
// The window the factory returns is a stand-in too, because the composition
// root now serves the agent channel over it (D6); what that channel then does
// is tested at its own interface, not here.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LogRecord } from './log/sink'

const harness = vi.hoisted(() => ({
  appPath: '',
  handlers: new Map<string, Array<(...args: unknown[]) => void>>(),
  windows: [] as object[],
  quits: 0,
  windowsCreated: 0,
  onCreateWindow: undefined as (() => void) | undefined,
  releaseReady: () => {},
  ipcHandlers: new Set<string>(),
  // What the newest window's `webContents` is listening for — the two renderer
  // output events among them (D9).
  webContentsListeners: new Map<string, (...args: unknown[]) => void>()
}))

vi.mock('electron', () => ({
  app: {
    getAppPath: () => harness.appPath,
    whenReady: () =>
      new Promise<void>((resolve) => {
        harness.releaseReady = () => resolve()
      }),
    on: (event: string, handler: (...args: unknown[]) => void) => {
      const registered = harness.handlers.get(event) ?? []
      registered.push(handler)
      harness.handlers.set(event, registered)
    },
    quit: () => {
      harness.quits += 1
    }
  },
  BrowserWindow: {
    getAllWindows: () => harness.windows
  },
  ipcMain: {
    handle: (channel: string) => {
      harness.ipcHandlers.add(channel)
    },
    removeHandler: (channel: string) => {
      harness.ipcHandlers.delete(channel)
    }
  }
}))

vi.mock('./window', () => ({
  createMainWindow: () => {
    harness.windowsCreated += 1
    // As much of a window as the agent channel touches.
    harness.webContentsListeners.clear()
    const window = {
      on: () => {},
      webContents: {
        on: (event: string, listener: (...args: unknown[]) => void) => {
          harness.webContentsListeners.set(event, listener)
        },
        send: () => {},
        isDestroyed: () => false
      }
    }
    harness.windows.push(window)
    harness.onCreateWindow?.()
    return window
  }
}))

const temporaryDirectories: string[] = []

/** A fresh app path: what `app.getAppPath()` answers for the next launch. */
function freshAppPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'crucible-main-'))
  temporaryDirectories.push(directory)
  harness.appPath = directory
  return directory
}

function logDirectory(): string {
  return join(harness.appPath, 'logs')
}

/** Every record the launch has persisted so far, read back off disk. */
function records(): LogRecord[] {
  const files = readdirSync(logDirectory())
  expect(files).toHaveLength(1)
  const text = readFileSync(join(logDirectory(), files[0]), 'utf8')
  return text === ''
    ? []
    : text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as LogRecord)
}

function events(): unknown[] {
  return records().map((record) => record.event)
}

/** Load main the way Electron does. */
async function launch(): Promise<void> {
  vi.resetModules()
  await import('./index')
}

/** Let `app.whenReady()` resolve, and let its continuation run. */
async function becomeReady(): Promise<void> {
  harness.releaseReady()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Fire an Electron app event at whatever main registered for it. */
function emit(event: string): void {
  const registered = harness.handlers.get(event) ?? []
  expect(registered.length).toBeGreaterThan(0)
  for (const handler of registered) handler()
}

const platform = Object.getOwnPropertyDescriptor(process, 'platform')

function runningOn(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

beforeEach(() => {
  harness.handlers.clear()
  harness.windows.length = 0
  harness.quits = 0
  harness.windowsCreated = 0
  harness.onCreateWindow = undefined
  harness.releaseReady = () => {}
  harness.ipcHandlers.clear()
  harness.webContentsListeners.clear()
  vi.stubEnv('ELECTRON_RENDERER_URL', undefined)
  vi.stubEnv('CRUCIBLE_AGENT', undefined)
  freshAppPath()
})

afterEach(() => {
  vi.unstubAllEnvs()
  if (platform !== undefined) Object.defineProperty(process, 'platform', platform)
  let directory = temporaryDirectories.pop()
  while (directory !== undefined) {
    rmSync(directory, { recursive: true, force: true })
    directory = temporaryDirectories.pop()
  }
})

describe('the main process', () => {
  it('opens one run log under the app path and says it is starting, before readiness', async () => {
    await launch()

    expect(readdirSync(logDirectory())).toHaveLength(1)
    const [starting, ...rest] = records()
    // The launch flavor is chosen before readiness too, and says so (D5).
    expect(rest).toHaveLength(1)
    expect(rest[0]).toMatchObject({ seq: 2, source: 'main', event: 'adapter_selected' })
    expect(starting).toMatchObject({
      seq: 1,
      source: 'main',
      event: 'app_starting',
      pid: process.pid,
      dev: false
    })
    expect(starting.electron).toBe(process.versions.electron)
    expect(starting.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(harness.windowsCreated).toBe(0)
  })

  it('calls any non-empty ELECTRON_RENDERER_URL a dev launch, "0" included', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '0')
    await launch()
    expect(records()[0].dev).toBe(true)

    vi.stubEnv('ELECTRON_RENDERER_URL', '')
    freshAppPath()
    await launch()
    expect(records()[0].dev).toBe(false)
  })

  it('logs readiness, then the window — "created" means the factory returned', async () => {
    await launch()
    let atFactoryCall: unknown[] = []
    harness.onCreateWindow = () => {
      atFactoryCall = events()
    }

    await becomeReady()

    expect(events()).toEqual(['app_starting', 'adapter_selected', 'app_ready', 'window_created'])
    expect(atFactoryCall).toEqual(['app_starting', 'adapter_selected', 'app_ready'])
    expect(harness.windowsCreated).toBe(1)
    expect(records().map((record) => record.seq)).toEqual([1, 2, 3, 4])
  })

  it('serves the agent channel over the window it opened, until it quits', async () => {
    await launch()
    expect(harness.ipcHandlers.has('agent:prompt')).toBe(false)

    await becomeReady()
    expect(harness.ipcHandlers.has('agent:prompt')).toBe(true)

    emit('will-quit')
    expect(harness.ipcHandlers.has('agent:prompt')).toBe(false)
  })

  it('forwards what the renderer says into the launch’s own log, in order', async () => {
    await launch()
    await becomeReady()

    const said = harness.webContentsListeners.get('console-message')
    expect(said).toBeDefined()
    said?.({
      message: '[crucible] preload loaded',
      level: 'info',
      lineNumber: 1,
      sourceId: 'preload'
    })

    expect(records().map((record) => [record.seq, record.source, record.event])).toEqual([
      [1, 'main', 'app_starting'],
      [2, 'main', 'adapter_selected'],
      [3, 'main', 'app_ready'],
      [4, 'main', 'window_created'],
      [5, 'renderer', 'console']
    ])
    expect(records().at(-1)).toMatchObject({ message: '[crucible] preload loaded', level: 'info' })
  })

  it('re-opens and logs a window on dock activate when none is open', async () => {
    await launch()
    await becomeReady()
    harness.windows.length = 0

    emit('activate')

    expect(harness.windowsCreated).toBe(2)
    expect(records().at(-1)).toMatchObject({
      seq: 5,
      source: 'main',
      event: 'window_created',
      reason: 'activate'
    })
  })

  it('does nothing at all on dock activate while a window is open', async () => {
    await launch()
    await becomeReady()

    emit('activate')

    expect(harness.windowsCreated).toBe(1)
    expect(events()).toEqual(['app_starting', 'adapter_selected', 'app_ready', 'window_created'])
  })

  it('logs the last window closing and quits, off macOS', async () => {
    runningOn('linux')
    await launch()
    await becomeReady()

    emit('window-all-closed')

    expect(harness.quits).toBe(1)
    expect(events()).toEqual([
      'app_starting',
      'adapter_selected',
      'app_ready',
      'window_created',
      'windows_closed'
    ])
  })

  it('logs the last window closing and stays alive, on macOS', async () => {
    runningOn('darwin')
    await launch()
    await becomeReady()

    emit('window-all-closed')

    expect(harness.quits).toBe(0)
    expect(events()).toEqual([
      'app_starting',
      'adapter_selected',
      'app_ready',
      'window_created',
      'windows_closed'
    ])
  })

  it('leaves the whole launch readable in order, down to the last record', async () => {
    runningOn('darwin')
    await launch()
    await becomeReady()

    emit('window-all-closed')
    emit('will-quit')

    expect(records().map((record) => [record.seq, record.event])).toEqual([
      [1, 'app_starting'],
      [2, 'adapter_selected'],
      [3, 'app_ready'],
      [4, 'window_created'],
      [5, 'windows_closed'],
      [6, 'app_quitting']
    ])
  })
})
