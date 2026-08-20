// @vitest-environment node
//
// Electron and the service are both stand-ins here: what a refresh means is
// tested where it lives, and what is left is plumbing.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { QUOTA_EVENT_CHANNEL, QUOTA_REQUEST_CHANNEL, type QuotaResult } from '../../shared/quota/channels'
import type { QuotaListener, QuotaService } from '../../shared/quota/service'
import type { QuotaSnapshot } from '../../shared/quota/types'
import { serveQuotaChannel } from './channel'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (invocation: unknown, ...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle(channel: string, handler: (invocation: unknown, ...args: unknown[]) => unknown) {
      if (electron.handlers.has(channel)) throw new Error(`second handler for ${channel}`)
      electron.handlers.set(channel, handler)
    },
    removeHandler(channel: string) {
      electron.handlers.delete(channel)
    }
  }
}))

const SNAPSHOT: QuotaSnapshot = {
  fetchedAt: 1,
  providers: {
    xai: { providerId: 'xai', fetchedAt: 1, meters: [] }
  }
}

interface StubWindow {
  readonly window: BrowserWindow
  readonly sent: readonly QuotaSnapshot[]
  close(): void
}

function stubWindow(): StubWindow {
  const sent: QuotaSnapshot[] = []
  const closes: Array<() => void> = []
  let destroyed = false

  const window = {
    webContents: {
      isDestroyed: () => destroyed,
      send: (channel: string, snapshot: QuotaSnapshot) => {
        expect(channel).toBe(QUOTA_EVENT_CHANNEL)
        sent.push(snapshot)
      }
    },
    on: (event: string, listener: () => void) => {
      expect(event).toBe('closed')
      closes.push(listener)
    }
  }

  return {
    window: window as unknown as BrowserWindow,
    sent,
    close: () => {
      destroyed = true
      for (const closed of closes) closed()
    }
  }
}

interface StubService {
  readonly service: QuotaService
  readonly asked: ReadonlyArray<{ readonly op: string; readonly args: readonly unknown[] }>
  announce(snapshot: QuotaSnapshot): void
}

function stubService(): StubService {
  const asked: Array<{ op: string; args: readonly unknown[] }> = []
  const listeners = new Set<QuotaListener>()

  const service: QuotaService = {
    async read() {
      asked.push({ op: 'read', args: [] })
      return SNAPSHOT
    },
    async refresh(opts = {}) {
      asked.push({ op: 'refresh', args: [opts] })
      if (opts.providers?.includes('explode') === true) {
        throw new Error('Crucible could not read the quota.')
      }
      return SNAPSHOT
    },
    onChange(listener: QuotaListener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }

  return {
    service,
    asked,
    announce: (snapshot) => {
      for (const listener of listeners) listener(snapshot)
    }
  }
}

async function request(payload: unknown): Promise<QuotaResult> {
  const handler = electron.handlers.get(QUOTA_REQUEST_CHANNEL)
  if (handler === undefined) throw new Error('nothing is serving the quota channel')
  return (await handler({}, payload)) as QuotaResult
}

let stub: StubService
let host: StubWindow

beforeEach(() => {
  electron.handlers.clear()
  stub = stubService()
  host = stubWindow()
  serveQuotaChannel(stub.service, host.window)
})

describe('the quota channel', () => {
  it('dispatches an operation to the service by its own name', async () => {
    await expect(request({ op: 'read', args: [] })).resolves.toEqual({
      ok: true,
      value: SNAPSHOT
    })
    expect(stub.asked).toEqual([{ op: 'read', args: [] }])
  })

  it('carries a scope across, and drops anything that is not a list of ids', async () => {
    await request({ op: 'refresh', args: [{ providers: ['xai'] }] })
    await request({ op: 'refresh', args: [{ providers: 'xai' }] })
    await request({ op: 'refresh', args: [] })

    expect(stub.asked.map((call) => call.args[0])).toEqual([
      { providers: ['xai'] },
      {},
      {}
    ])
  })

  it('broadcasts the result of every completed refresh to the window it serves', () => {
    stub.announce(SNAPSHOT)

    expect(host.sent).toEqual([SNAPSHOT])
  })

  it('refuses an unknown operation as a value, not a throw', async () => {
    await expect(request({ op: 'delete-everything', args: [] })).resolves.toEqual({
      ok: false,
      message: expect.stringContaining('does not do')
    })
  })

  it('refuses a request that is not a request', async () => {
    await expect(request('read')).resolves.toMatchObject({ ok: false })
    await expect(request({ args: [] })).resolves.toMatchObject({ ok: false })
  })

  it('answers a service failure with a sentence rather than a rejection', async () => {
    await expect(request({ op: 'refresh', args: [{ providers: ['explode'] }] })).resolves.toEqual({
      ok: false,
      message: 'Crucible could not read the quota.'
    })
  })

  it('stops serving when its window closes', async () => {
    host.close()

    expect(electron.handlers.has(QUOTA_REQUEST_CHANNEL)).toBe(false)
    stub.announce(SNAPSHOT)
    expect(host.sent).toEqual([])
  })
})
