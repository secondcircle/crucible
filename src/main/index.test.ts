// @vitest-environment node
//
// A composition root's interface is what it does when Electron loads it, so
// Electron is what stands in here.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REQUEST_CHANNEL } from '../shared/agent/channels'
import { COMMAND_REQUEST_CHANNEL } from '../shared/commands/channels'
import { NEEDS_YOU_REQUEST_CHANNEL } from '../shared/needs-you/channels'
import { SCHEDULE_REQUEST_CHANNEL } from '../shared/schedules/channels'
import { QUOTA_REQUEST_CHANNEL } from '../shared/quota/channels'
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
  webContentsListeners: new Map<string, (...args: unknown[]) => void>(),
  privileged: [] as Array<{ scheme: string; privileges: Record<string, unknown> }>,
  schemeHandlers: new Set<string>(),
  menus: [] as unknown[]
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => harness.appPath,
    getVersion: () => '0.1.0',
    getPath: (name: string) => (name === 'userData' ? harness.userData : harness.appPath),
    setPath: (name: string, value: string) => {
      if (name === 'userData') harness.userData = value
    },
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
  // Off macOS main hides the menu entirely; on it the menu is left alone.
  Menu: {
    setApplicationMenu: (menu: unknown) => {
      harness.menus.push(menu)
    }
  },
  ipcMain: {
    handle: (channel: string) => {
      harness.ipcHandlers.add(channel)
    },
    removeHandler: (channel: string) => {
      harness.ipcHandlers.delete(channel)
    }
  },
  protocol: {
    registerSchemesAsPrivileged: (
      schemes: Array<{ scheme: string; privileges: Record<string, unknown> }>
    ) => {
      harness.privileged.push(...schemes)
    }
  },
  session: {
    defaultSession: {
      protocol: {
        handle: (scheme: string) => {
          harness.schemeHandlers.add(scheme)
        }
      }
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
  harness.privileged.length = 0
  harness.schemeHandlers.clear()
  harness.menus.length = 0
  vi.resetModules()
  vi.stubEnv('CRUCIBLE_AGENT', undefined)
  vi.stubEnv('CRUCIBLE_WORKSPACE', undefined)
  // A launch that carries no override of its own, which is what every launch
  // but a deliberate one looks like. Cleared per launch: main writes this one
  // itself, so a previous test's launch would otherwise be the environment the
  // next one inherits.
  vi.stubEnv('PI_CACHE_RETENTION', undefined)
  await import('./index')
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(harness.appPath, { recursive: true, force: true })
  rmSync(harness.userData, { recursive: true, force: true })
})

describe('what a launch does', () => {
  it('writes the launch records before a window exists', () => {
    // Retention is asked for before any agent exists; quota comes next
    // because the engine asks it what a node may spend on.
    expect(events()).toEqual([
      'app_starting',
      'cache_retention',
      'quota_service_selected',
      'workflow_run_service_selected',
      'schedule_service_selected',
      'adapter_selected',
      'workspace_service_selected',
      'command_service_selected'
    ])
    expect(records()[5]).toMatchObject({ adapter: 'fake' })
    // One flavor decision governs every seam: the fake launch runs scripted
    // runs, evaluates no schedule on a clock, reads no credential and never
    // touches the machine's quota cache.
    expect(records()[3]).toMatchObject({ service: 'fake' })
    expect(records()[4]).toMatchObject({ service: 'fake' })
    expect(records()[2]).toMatchObject({ event: 'quota_service_selected', service: 'canned' })
    expect(harness.windowsCreated).toBe(0)
  })

  it('asks for the hour before the first agent of the launch exists', () => {
    // Second record of the launch, ahead of the ledger, the adapter and the
    // workflow engine: π reads the variable per request, so it has to be in
    // the environment before anything can make one. The launch record itself
    // already carries the answer.
    expect(records()[0]).toMatchObject({ event: 'app_starting', retention: '1h' })
    expect(records()[1]).toMatchObject({
      event: 'cache_retention',
      retention: '1h',
      decidedBy: 'crucible'
    })
    expect(process.env.PI_CACHE_RETENTION).toBe('long')
  })

  it('starts though it can read no shipped prompt file, because the fake needs none', () => {
    // Nothing is shipped under this launch's app directory, prompts included.
    expect(existsSync(join(harness.appPath, 'resources'))).toBe(false)
    expect(records()[5]).toMatchObject({ event: 'adapter_selected', adapter: 'fake' })
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
    expect(harness.ipcHandlers.has(QUOTA_REQUEST_CHANNEL)).toBe(true)
    expect(harness.ipcHandlers.has(NEEDS_YOU_REQUEST_CHANNEL)).toBe(true)
    expect(harness.ipcHandlers.has(SCHEDULE_REQUEST_CHANNEL)).toBe(true)
    expect(events()).toEqual([
      'app_starting',
      'cache_retention',
      'quota_service_selected',
      'workflow_run_service_selected',
      'schedule_service_selected',
      'adapter_selected',
      'workspace_service_selected',
      'command_service_selected',
      'app_ready',
      // Per window rather than per launch: the dock badge and the banners
      // follow one window's focus.
      'needs_you_service_selected',
      'window_created'
    ])
  })

  it('registers no scheme of its own: exhibits load in webview guests', async () => {
    harness.releaseReady()
    await Promise.resolve()

    expect(harness.privileged).toEqual([])
    expect(harness.schemeHandlers.size).toBe(0)
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
