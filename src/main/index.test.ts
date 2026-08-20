// @vitest-environment node
//
// A composition root's interface is what it does when Electron loads it, so
// Electron is what stands in here.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REQUEST_CHANNEL } from '../shared/agent/channels'
import { COMMAND_REQUEST_CHANNEL } from '../shared/commands/channels'
import { WORKSPACE_REQUEST_CHANNEL } from '../shared/workspace/channels'
import type { LogRecord } from './log/sink'

const harness = vi.hoisted(() => ({
  appPath: '',
  userData: '',
  handlers: new Map<string, Array<(...args: unknown[]) => void>>(),
  windows: [] as object[],
  quits: 0,
  windowsCreated: 0,
  releaseReady: () => {},
  ipcHandlers: new Set<string>(),
  webContentsListeners: new Map<string, (...args: unknown[]) => void>()
}))

vi.mock('electron', () => ({
  app: {
    getAppPath: () => harness.appPath,
    getPath: (name: string) => (name === 'userData' ? harness.userData : harness.appPath),
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
    getAllWindows: () => harness.windows,
    getFocusedWindow: () => harness.windows[0] ?? null
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] })
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
    const window = {
      webContents: {
        isDestroyed: () => false,
        send: () => {},
        on: (event: string, listener: (...args: unknown[]) => void) => {
          harness.webContentsListeners.set(event, listener)
        }
      },
      on: () => {}
    }
    harness.windows.push(window)
    return window
  }
}))

function fire(event: string): void {
  for (const handler of harness.handlers.get(event) ?? []) handler()
}

function records(): LogRecord[] {
  const directory = join(harness.appPath, 'logs')
  const [file] = readdirSync(directory)
  return readFileSync(join(directory, file), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as LogRecord)
}

const events = (): string[] => records().map((record) => record.event)

beforeEach(async () => {
  harness.appPath = mkdtempSync(join(tmpdir(), 'crucible-app-'))
  harness.userData = mkdtempSync(join(tmpdir(), 'crucible-userdata-'))
  harness.handlers.clear()
  harness.windows.length = 0
  harness.quits = 0
  harness.windowsCreated = 0
  harness.ipcHandlers.clear()
  harness.webContentsListeners.clear()
  vi.resetModules()
  vi.stubEnv('CRUCIBLE_AGENT', undefined)
  vi.stubEnv('CRUCIBLE_WORKSPACE', undefined)
  await import('./index')
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(harness.appPath, { recursive: true, force: true })
  rmSync(harness.userData, { recursive: true, force: true })
})

describe('what a launch does', () => {
  it('writes the launch records before a window exists', () => {
    expect(events()).toEqual([
      'app_starting',
      'adapter_selected',
      'workspace_service_selected',
      'command_service_selected'
    ])
    expect(records()[1]).toMatchObject({ adapter: 'fake' })
    expect(harness.windowsCreated).toBe(0)
  })

  it('opens one window when Electron is ready and serves the port over it', async () => {
    harness.releaseReady()
    await Promise.resolve()

    expect(harness.windowsCreated).toBe(1)
    expect(harness.ipcHandlers.has(REQUEST_CHANNEL)).toBe(true)
    // Every seam is served over the same window: the agent port and, beside
    // it, the workspace service and the command service.
    expect(harness.ipcHandlers.has(WORKSPACE_REQUEST_CHANNEL)).toBe(true)
    expect(harness.ipcHandlers.has(COMMAND_REQUEST_CHANNEL)).toBe(true)
    expect(events()).toEqual([
      'app_starting',
      'adapter_selected',
      'workspace_service_selected',
      'command_service_selected',
      'app_ready',
      'window_created'
    ])
  })

  it('forwards what the renderer says into the same log', async () => {
    harness.releaseReady()
    await Promise.resolve()

    expect([...harness.webContentsListeners.keys()]).toEqual(
      expect.arrayContaining(['console-message', 'preload-error'])
    )
  })

  it('re-opens a window on dock activate when none is left', async () => {
    harness.releaseReady()
    await Promise.resolve()
    harness.windows.length = 0

    fire('activate')

    expect(harness.windowsCreated).toBe(2)
    expect(records().at(-1)).toMatchObject({ event: 'window_created', reason: 'activate' })
  })

  it('drops what was running at quit, and says so last', async () => {
    harness.releaseReady()
    await Promise.resolve()

    fire('will-quit')

    expect(harness.ipcHandlers.has(REQUEST_CHANNEL)).toBe(false)
    expect(events().at(-1)).toBe('app_quitting')
    expect(events()).toContain('shell_disposed')
  })

  it('quits with its last window off macOS, and stays alive on it', async () => {
    harness.releaseReady()
    await Promise.resolve()

    fire('window-all-closed')

    expect(harness.quits).toBe(process.platform === 'darwin' ? 0 : 1)
    expect(events()).toContain('windows_closed')
  })
})
