// @vitest-environment node
//
// Every test passes a fixture directory, an injected clock and stand-in
// adapters, so nothing here opens a socket or goes near the machine's cache.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { monthlyResetAfter } from '../../shared/quota/month'
import type { QuotaMeter } from '../../shared/quota/types'
import { anthropicAdapter } from './adapters/anthropic'
import { ADAPTERS } from './adapters/index'
import type { AdapterResult, FetchLike, ProviderAdapter } from './adapters/types'
import { KNOWN_PROVIDER_IDS } from './paths'
import { readQuota } from './reader'
import { type AuthLike, createQuotaStore, credentialTypeFrom } from './store'

const HOUR = 60 * 60 * 1000

const directories: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crucible-quota-'))
  directories.push(dir)
  return dir
}

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop() as string, { recursive: true, force: true })
  }
})

/** A meter builder, so a test's numbers are the only thing it states. */
function meter(over: Partial<QuotaMeter> = {}): QuotaMeter {
  return { kind: 'weekly', label: '7D', usedPercent: 20, resetsAt: null, ...over }
}

const ok = (meters: QuotaMeter[]): AdapterResult => ({ ok: true, meters })

// The work account's usage response, captured live and kept byte for byte:
// what is under test is the whole path from the response body to the read seam.
const WORK_ACCOUNT_BODY = String.raw`{"five_hour":null,"seven_day":null,"seven_day_oauth_apps":null,"seven_day_opus":null,"seven_day_sonnet":null,"seven_day_cowork":null,"seven_day_omelette":null,"tangelo":null,"iguana_necktie":null,"omelette_promotional":null,"nimbus_quill":{"utilization":0.0,"resets_at":null,"limit_dollars":null,"used_dollars":null,"remaining_dollars":null},"cinder_cove":{"utilization":100.0,"resets_at":"2026-09-22T18:55:57.572982+00:00","limit_dollars":1000,"used_dollars":1000.0,"remaining_dollars":0.0},"amber_ladder":null,"extra_usage":{"is_enabled":true,"monthly_limit":500000,"used_credits":211926.0,"utilization":42.3852,"currency":"USD","decimal_places":2,"disabled_reason":null,"user_disabled":false,"spend_limit_reached":false,"credits_ever_enabled":true,"daily":null,"weekly":null},"limits":[],"spend":{"used":{"amount_minor":211926,"currency":"USD","exponent":2},"limit":{"amount_minor":500000,"currency":"USD","exponent":2},"percent":42,"severity":"normal","enabled":true,"disabled_reason":null,"cap":{"money":null,"credits":{"amount_minor":500000,"exponent":2}},"balance":null,"auto_reload":null,"disclaimer":"Usage credits cover you when you hit your plan limits.","can_purchase_credits":false,"can_toggle":false},"member_dashboard_available":true}`

/** Answers the usage endpoint with those bytes and opens no socket. */
const workAccountWire: FetchLike = async () => ({
  ok: true,
  status: 200,
  text: async () => WORK_ACCOUNT_BODY
})

const bearer = async (): Promise<AuthLike> => ({ auth: { apiKey: 'token' } })

/** An adapter that answers from a script and counts its calls. */
function fakeAdapter(
  providerId: string,
  answers: AdapterResult | (() => AdapterResult)
): { adapter: ProviderAdapter; calls: string[] } {
  const calls: string[] = []
  const adapter: ProviderAdapter = {
    providerId,
    async fetchQuota(given: string) {
      calls.push(given)
      return typeof answers === 'function' ? answers() : answers
    }
  }
  return { adapter, calls }
}

/** A store on a fixture directory with a clock the test moves by hand. */
function harness(
  dir: string,
  adapters: ProviderAdapter[],
  over: Partial<Parameters<typeof createQuotaStore>[0]> = {}
): {
  store: ReturnType<typeof createQuotaStore>
  messages: string[]
  now: () => number
  advance: (ms: number) => void
} {
  let at = Date.UTC(2026, 7, 15, 12, 0, 0)
  const messages: string[] = []
  const store = createQuotaStore({
    getAuth: bearer,
    adapters,
    dir,
    now: () => at,
    log: (message) => messages.push(message),
    ...over
  })
  return {
    store,
    messages,
    now: () => at,
    advance: (ms: number) => {
      at += ms
    }
  }
}

describe('the quota store', () => {
  it('fetches once per provider, and not again inside the TTL', async () => {
    const dir = tempDir()
    const anthropic = fakeAdapter(
      'anthropic',
      ok([meter({ kind: 'session', label: '5H', usedPercent: 8 })])
    )
    const xai = fakeAdapter('xai', ok([meter({ usedPercent: 20 })]))
    const harnessed = harness(dir, [anthropic.adapter, xai.adapter])

    const first = await harnessed.store.refresh()
    expect(Object.keys(first.providers).sort()).toEqual(['anthropic', 'xai'])
    expect(anthropic.calls).toHaveLength(1)
    expect(xai.calls).toHaveLength(1)

    harnessed.advance(59_000)
    const second = await harnessed.store.refresh()
    expect(anthropic.calls).toHaveLength(1)
    expect(xai.calls).toHaveLength(1)
    expect(second.providers.anthropic.meters).toEqual(first.providers.anthropic.meters)

    // Past the TTL the next trigger is the retry — one attempt, no ladder.
    harnessed.advance(2_000)
    await harnessed.store.refresh()
    expect(anthropic.calls).toHaveLength(2)

    // `force` is for a consumer that needs guaranteed freshness and pays for it.
    await harnessed.store.refresh({ force: true })
    expect(anthropic.calls).toHaveLength(3)
  })

  it('scopes a refresh to the providers it names and spends nobody else\u2019s quota', async () => {
    const dir = tempDir()
    const anthropic = fakeAdapter('anthropic', ok([meter()]))
    const xai = fakeAdapter('xai', ok([meter()]))
    const harnessed = harness(dir, [anthropic.adapter, xai.adapter])

    await harnessed.store.refresh({ providers: ['xai'] })

    expect(xai.calls).toHaveLength(1)
    expect(anthropic.calls).toHaveLength(0)
  })

  it('writes one 0600 file per provider, carrying no identity', async () => {
    const dir = tempDir()
    const anthropic = fakeAdapter(
      'anthropic',
      ok([meter({ kind: 'weekly_scoped', label: 'FABLE', usedPercent: 74, scopeName: 'Fable' })])
    )
    const harnessed = harness(dir, [anthropic.adapter])

    await harnessed.store.refresh()

    const files = readdirSync(dir)
    expect(files).toEqual(['anthropic.json'])
    expect(statSync(join(dir, 'anthropic.json')).mode & 0o777).toBe(0o600)

    const raw = readFileSync(join(dir, 'anthropic.json'), 'utf8')
    expect(raw).not.toContain('token')
    // The disk keeps the field name `windows`, because the file is an interop
    // contract with apps this one does not control.
    const written = JSON.parse(raw) as { v: number; windows: unknown[] }
    expect(written.v).toBe(1)
    expect(written.windows).toHaveLength(1)
  })

  it('keeps the last good meters when a fetch fails, and ages them', async () => {
    const dir = tempDir()
    let answer: AdapterResult = ok([meter({ usedPercent: 42 })])
    const xai = fakeAdapter('xai', () => answer)
    const harnessed = harness(dir, [xai.adapter])

    await harnessed.store.refresh()
    const fetchedAt = harnessed.now()

    answer = { ok: false, error: 'unavailable' }
    harnessed.advance(61_000)
    const after = await harnessed.store.refresh()

    // The meters stand, the error is recorded, and the data's own age keeps
    // growing: dimmed and aged, never blanked.
    expect(after.providers.xai.meters).toEqual([meter({ usedPercent: 42 })])
    expect(after.providers.xai.error).toBe('unavailable')
    expect(after.providers.xai.fetchedAt).toBe(fetchedAt)
  })

  it('is present, empty and never a zero when a failure has nothing good behind it', async () => {
    const dir = tempDir()
    const xai = fakeAdapter('xai', { ok: false, error: 'unauthorized' })
    const harnessed = harness(dir, [xai.adapter])

    const snapshot = await harnessed.store.refresh()

    expect(snapshot.providers.xai.meters).toEqual([])
    expect(snapshot.providers.xai.error).toBe('unauthorized')
  })

  it('says a provider went down, recovered and went down again — once each', async () => {
    const dir = tempDir()
    let answer: AdapterResult = { ok: false, error: 'unavailable' }
    const xai = fakeAdapter('xai', () => answer)
    const harnessed = harness(dir, [xai.adapter])

    await harnessed.store.refresh()
    harnessed.advance(61_000)
    // Still down: an outage must not fill the log.
    await harnessed.store.refresh()
    expect(harnessed.messages).toHaveLength(1)

    answer = ok([meter()])
    harnessed.advance(61_000)
    await harnessed.store.refresh()
    expect(harnessed.messages).toHaveLength(2)
    expect(harnessed.messages[1]).toMatch(/recovered/)

    answer = { ok: false, error: 'unavailable' }
    harnessed.advance(61_000)
    await harnessed.store.refresh()
    expect(harnessed.messages).toHaveLength(3)
    expect(harnessed.messages[2]).toMatch(/failed \(unavailable\)/)
  })

  it('treats a credential lookup that threw as a failed attempt, never a logout', async () => {
    const dir = tempDir()
    const xai = fakeAdapter('xai', ok([meter({ usedPercent: 33 })]))
    let broken = false
    const harnessed = harness(dir, [xai.adapter], {
      getAuth: async () => {
        if (broken) throw new Error('token rotation in progress')
        return { auth: { apiKey: 'token' } }
      }
    })

    await harnessed.store.refresh()
    broken = true
    harnessed.advance(61_000)
    const after = await harnessed.store.refresh()

    // The provider is still there, with its last good reading dimmed by the
    // error rather than deleted.
    expect(after.providers.xai.meters).toEqual([meter({ usedPercent: 33 })])
    expect(after.providers.xai.error).toBe('unavailable')
  })

  it('deletes the cache file when the provider logs out', async () => {
    const dir = tempDir()
    const xai = fakeAdapter('xai', ok([meter()]))
    let loggedIn = true
    const harnessed = harness(dir, [xai.adapter], {
      getAuth: async () => (loggedIn ? { auth: { apiKey: 'token' } } : undefined)
    })

    await harnessed.store.refresh()
    expect(readdirSync(dir)).toContain('xai.json')

    loggedIn = false
    harnessed.advance(61_000)
    const after = await harnessed.store.refresh()

    expect(after.providers.xai).toBeUndefined()
    expect(readdirSync(dir).filter((name) => name.endsWith('.json'))).toEqual([])
  })

  it('treats an api-key account as absent rather than a row showing a dash', async () => {
    const dir = tempDir()
    const xai = fakeAdapter('xai', ok([meter()]))
    const harnessed = harness(dir, [xai.adapter], { credentialType: () => 'api_key' })

    const snapshot = await harnessed.store.refresh()

    expect(snapshot.providers).toEqual({})
    expect(xai.calls).toHaveLength(0)
  })

  it('maps a host\u2019s answer about OAuth the same way for every consumer', () => {
    expect(credentialTypeFrom(true)).toBe('oauth')
    expect(credentialTypeFrom(false)).toBe('api_key')
    // "The host does not know" stays distinct from "the host says no".
    expect(credentialTypeFrom(undefined)).toBeUndefined()
  })

  it('removes a cache file no registered adapter owns', async () => {
    const dir = tempDir()
    writeFileSync(
      join(dir, 'anthropic.json'),
      JSON.stringify({
        v: 1,
        providerId: 'anthropic',
        windows: [],
        fetchedAt: Date.now(),
        attemptedAt: Date.now()
      })
    )
    const xai = fakeAdapter('xai', ok([meter()]))
    const harnessed = harness(dir, [xai.adapter])

    const snapshot = await harnessed.store.refresh()

    expect(snapshot.providers.anthropic).toBeUndefined()
    expect(readdirSync(dir)).toEqual(['xai.json'])
  })

  it('lets one provider\u2019s outage leave every other row untouched', async () => {
    const dir = tempDir()
    const anthropic = fakeAdapter('anthropic', ok([meter({ usedPercent: 54 })]))
    const codex = fakeAdapter('openai-codex', () => {
      throw new Error('this adapter is broken')
    })
    const xai = fakeAdapter('xai', ok([meter({ usedPercent: 19 })]))
    const harnessed = harness(dir, [anthropic.adapter, codex.adapter, xai.adapter])

    const snapshot = await harnessed.store.refresh()

    expect(snapshot.providers.anthropic.meters).toEqual([meter({ usedPercent: 54 })])
    expect(snapshot.providers.xai.meters).toEqual([meter({ usedPercent: 19 })])
    // An adapter that throws is a bug, not a state, and it is still only its
    // own provider's problem.
    expect(snapshot.providers['openai-codex'].error).toBe('unavailable')
  })

  it('serves a fresh cache without touching the credential seam at all', async () => {
    const dir = tempDir()
    const xai = fakeAdapter('xai', ok([meter()]))
    let lookups = 0
    const harnessed = harness(dir, [xai.adapter], {
      getAuth: async () => {
        lookups += 1
        return { auth: { apiKey: 'token' } }
      }
    })

    await harnessed.store.refresh()
    harnessed.advance(30_000)
    await harnessed.store.refresh()

    // The TTL is checked before the credential lookup, because that lookup is
    // π's own path and may refresh an OAuth token over the network.
    expect(lookups).toBe(1)
  })

  it('starts no timer of its own: an idle store fetches nothing', async () => {
    const dir = tempDir()
    const xai = fakeAdapter('xai', ok([meter()]))
    const harnessed = harness(dir, [xai.adapter])

    await harnessed.store.refresh()
    // Whole days pass on the store's clock with nobody asking.
    harnessed.advance(48 * HOUR)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(xai.calls).toHaveLength(1)
  })

  it('reads a bearer out of an Authorization header as readily as an api key', async () => {
    const dir = tempDir()
    const xai = fakeAdapter('xai', ok([meter()]))
    const harnessed = harness(dir, [xai.adapter], {
      getAuth: async () => ({ auth: { headers: { Authorization: 'Bearer header-token' } } })
    })

    await harnessed.store.refresh()

    expect(xai.calls).toEqual(['header-token'])
  })

  it('registers exactly the provider ids the reader is willing to publish', () => {
    expect(ADAPTERS.map((adapter) => adapter.providerId).sort()).toEqual(
      [...KNOWN_PROVIDER_IDS].sort()
    )
  })

  it('leaves the cache readable by anything that reads it, store or not', async () => {
    const dir = tempDir()
    const xai = fakeAdapter('xai', ok([meter({ usedPercent: 61, resetsAt: null })]))
    const harnessed = harness(dir, [xai.adapter])

    await harnessed.store.refresh()

    // Read by the pure half with no store in sight, which is the shared-cache
    // contract the on-disk layout exists for.
    expect(readQuota({ dir, now: harnessed.now }).providers.xai.meters).toEqual([
      meter({ usedPercent: 61 })
    ])
  })

  it('carries the work account’s spend meter from the wire to the read seam', async () => {
    const dir = tempDir()
    // The adapter stamps the spend meter's reset off the wall clock, which the
    // store does not govern, so the expectation is computed from this instant.
    const at = Date.now()
    const store = createQuotaStore({
      getAuth: bearer,
      adapters: [anthropicAdapter],
      dir,
      now: () => at,
      log: () => {},
      fetchImpl: workAccountWire
    })

    await store.refresh()
    // The same gate the renderer's snapshot comes through: this round trip
    // returned `meters: []` before the gate learned the kind.
    const quota = store.read().providers.anthropic

    expect(quota.meters).toHaveLength(1)
    const [spend] = quota.meters
    expect(spend).toMatchObject({
      kind: 'monthly',
      label: 'MO',
      usedDollars: 2119.26,
      limitDollars: 5000,
      resetsAt: monthlyResetAfter(at)
    })
    expect(spend.usedPercent).toBeCloseTo(42.3852, 4)
    // Midnight UTC on the 1st, which is the window the pace tick measures.
    const reset = new Date(spend.resetsAt as number)
    expect([reset.getUTCDate(), reset.getUTCHours(), reset.getUTCMinutes()]).toEqual([1, 0, 0])
    // The rotating credit pool sits at a permanent 100% and is never a meter.
    expect(readFileSync(join(dir, 'anthropic.json'), 'utf8')).not.toContain('cinder_cove')
  })
})
