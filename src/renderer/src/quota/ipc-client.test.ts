// @vitest-environment jsdom
//
// The preload surface is a stand-in, because this side of the boundary is all a
// document can see.
import { afterEach, describe, expect, it } from 'vitest'
import type { QuotaRequest, QuotaResult } from '../../../shared/quota/channels'
import type { QuotaSnapshot } from '../../../shared/quota/types'
import { createQuotaClient } from './ipc-client'

const SNAPSHOT: QuotaSnapshot = {
  fetchedAt: 1,
  providers: {
    xai: {
      providerId: 'xai',
      fetchedAt: 1,
      meters: [{ kind: 'weekly', label: '7D', usedPercent: 19, resetsAt: null }]
    }
  }
}

interface Surface {
  readonly requests: QuotaRequest[]
  announce(snapshot: QuotaSnapshot): void
}

function install(answer: (request: QuotaRequest) => QuotaResult): Surface {
  const requests: QuotaRequest[] = []
  const listeners = new Set<(snapshot: QuotaSnapshot) => void>()

  window.crucible = {
    quota: {
      request: async (request: QuotaRequest) => {
        requests.push(request)
        return answer(request)
      },
      onEvent: (listener: (snapshot: QuotaSnapshot) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
  }

  return {
    requests,
    announce: (snapshot) => {
      for (const listener of listeners) listener(snapshot)
    }
  }
}

afterEach(() => {
  delete window.crucible
})

describe('the quota client', () => {
  it('carries a read across as one named request', async () => {
    const surface = install(() => ({ ok: true, value: SNAPSHOT }))
    const service = createQuotaClient()

    await expect(service.read()).resolves.toEqual(SNAPSHOT)
    expect(surface.requests).toEqual([{ op: 'read', args: [] }])
  })

  it('carries a refresh across with its scope, and without one when unscoped', async () => {
    const surface = install(() => ({ ok: true, value: SNAPSHOT }))
    const service = createQuotaClient()

    await service.refresh()
    await service.refresh({ providers: ['anthropic'] })

    expect(surface.requests).toEqual([
      { op: 'refresh', args: [{}] },
      { op: 'refresh', args: [{ providers: ['anthropic'] }] }
    ])
  })

  it('turns a refused result back into a rejection a person can read', async () => {
    install(() => ({ ok: false, message: 'Crucible could not read the quota.' }))
    const service = createQuotaClient()

    await expect(service.refresh()).rejects.toThrow('Crucible could not read the quota.')
  })

  it('delivers every refresh result to every listener, and stops on unsubscribe', () => {
    const surface = install(() => ({ ok: true, value: SNAPSHOT }))
    const service = createQuotaClient()
    const heard: QuotaSnapshot[] = []
    const stop = service.onChange((snapshot) => heard.push(snapshot))

    surface.announce(SNAPSHOT)
    stop()
    surface.announce({ providers: {}, fetchedAt: 2 })

    expect(heard).toEqual([SNAPSHOT])
  })

  it('says so plainly when the preload did not load', () => {
    expect(() => createQuotaClient()).toThrow(/preload did not load/)
  })
})
