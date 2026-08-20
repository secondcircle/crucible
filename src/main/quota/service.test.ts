// @vitest-environment node
//
// The service over a stub store: it reads without fetching, announces the
// result of every refresh, and never rejects for fetch trouble.
import { describe, expect, it } from 'vitest'
import type { QuotaSnapshot } from '../../shared/quota/types'
import { createQuotaService } from './service'
import type { QuotaStore, RefreshOptions } from './store'

const CACHED: QuotaSnapshot = { fetchedAt: 1, providers: {} }
const FETCHED: QuotaSnapshot = {
  fetchedAt: 2,
  providers: { xai: { providerId: 'xai', fetchedAt: 2, meters: [] } }
}

function stubStore(over: Partial<QuotaStore> = {}): {
  store: QuotaStore
  calls: RefreshOptions[]
} {
  const calls: RefreshOptions[] = []
  const store: QuotaStore = {
    read: () => CACHED,
    refresh: async (opts = {}) => {
      calls.push(opts)
      return FETCHED
    },
    ...over
  }
  return { store, calls }
}

describe('the quota service', () => {
  it('reads the cache without asking the store to fetch anything', async () => {
    const { store, calls } = stubStore()
    const service = createQuotaService(store)

    await expect(service.read()).resolves.toBe(CACHED)
    expect(calls).toEqual([])
  })

  it('carries a scope through to the store', async () => {
    const { store, calls } = stubStore()
    const service = createQuotaService(store)

    await service.refresh()
    await service.refresh({ providers: ['anthropic'] })

    expect(calls).toEqual([{}, { providers: ['anthropic'] }])
  })

  it('announces the result of every completed refresh, and stops on unsubscribe', async () => {
    const { store } = stubStore()
    const service = createQuotaService(store)
    const heard: QuotaSnapshot[] = []

    const stop = service.onChange((snapshot) => heard.push(snapshot))
    await service.refresh()
    stop()
    await service.refresh()

    expect(heard).toEqual([FETCHED])
  })

  it('answers with the cache rather than rejecting when the store breaks', async () => {
    const { store } = stubStore({
      refresh: async () => {
        throw new Error('the store should never do this')
      }
    })
    const service = createQuotaService(store)
    const heard: QuotaSnapshot[] = []
    service.onChange((snapshot) => heard.push(snapshot))

    // Fetch trouble reaches the user as staleness in the data, never as an
    // error, so a refresh resolves whatever happened underneath it.
    await expect(service.refresh()).resolves.toBe(CACHED)
    expect(heard).toEqual([CACHED])
  })
})
