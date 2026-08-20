// @vitest-environment node
//
// The xAI quota adapter, driven through its own seam: captured payloads in,
// normalized records out. No socket is opened here, and no authenticated call
// is made at all.
//
// Both fixtures are the live captures the legacy system's tests carry, embedded
// byte-for-byte (these bodies hold no identity field at all): the weekly pool,
// and the monthly dollar envelope the same URL returns without the `format`
// parameter. The second fixture is the whole point — one query parameter
// separates them, so the adapter refuses a period that does not call itself
// weekly.
import { beforeEach, describe, expect, it } from 'vitest'
import { forgetOnceIn } from '../log'
import type { FetchLike } from './types'
import { parseXaiQuota, XAI_QUOTA_URL, xaiAdapter } from './xai'

/** `?format=credits`, 200: the weekly usage pool. */
const CREDITS: unknown = JSON.parse(
  String.raw`{"config":{"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","start":"2026-08-14T15:39:31.212318+00:00","end":"2026-08-21T15:39:31.212318+00:00"},"creditUsagePercent":20.0,"onDemandCap":{"val":0},"onDemandUsed":{"val":0},"productUsage":[{"product":"GrokBuild","usagePercent":20.0}],"isUnifiedBillingUser":true,"prepaidBalance":{"val":0},"topUpMethod":"TOP_UP_METHOD_SAVED_PAYMENT_METHOD","billingPeriodStart":"2026-08-14T15:39:31.212318+00:00","billingPeriodEnd":"2026-08-21T15:39:31.212318+00:00"}}`
)

/** The same URL with no `format`, 200: dollars, monthly. */
const MONTHLY: unknown = JSON.parse(
  String.raw`{"config":{"monthlyLimit":{"val":0},"used":{"val":0},"onDemandCap":{"val":0},"billingPeriodStart":"2026-08-01T00:00:00+00:00","billingPeriodEnd":"2026-09-01T00:00:00+00:00","history":[{"billingCycle":{"year":2026,"month":7},"includedUsed":{"val":0},"onDemandUsed":{"val":0},"totalUsed":{"val":0}}]}}`
)

function quiet(): { log: (message: string) => void; messages: string[] } {
  const messages: string[] = []
  return { log: (message) => messages.push(message), messages }
}

/** A payload built on the credits capture, with `config` fields overridden. */
function withConfig(overrides: Record<string, unknown>): unknown {
  const base = (CREDITS as { config: Record<string, unknown> }).config
  return { config: { ...base, ...overrides } }
}

function stubFetch(
  status: number,
  body: string
): { impl: FetchLike; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers })
    return { ok: status >= 200 && status < 300, status, text: async () => body }
  }
  return { impl, calls }
}

beforeEach(() => forgetOnceIn())

describe('the xAI quota adapter', () => {
  it('reads one weekly meter out of the credits capture', () => {
    expect(parseXaiQuota(CREDITS, { log: quiet().log })).toEqual([
      {
        kind: 'weekly',
        label: '7D',
        usedPercent: 20,
        resetsAt: Date.parse('2026-08-21T15:39:31.212318+00:00')
      }
    ])
  })

  it('calls the monthly dollar envelope unparsed, never a meter', () => {
    // Same host, same path, one query parameter apart — and the reason two
    // third parties disagreed about this endpoint. Reading it as a quota window
    // would print a dollar percentage as a weekly meter.
    const sink = quiet()
    expect(parseXaiQuota(MONTHLY, { log: sink.log })).toBeNull()
    // Reported to the caller and logged by the store once, on the transition.
    expect(sink.messages).toEqual([])
  })

  it('refuses a period that does not call itself weekly', () => {
    for (const type of [
      'USAGE_PERIOD_TYPE_MONTHLY',
      'USAGE_PERIOD_TYPE_UNSPECIFIED',
      '',
      7,
      null,
      undefined
    ]) {
      expect(
        parseXaiQuota(withConfig({ currentPeriod: { type, end: '2026-08-21T15:39:31Z' } }), {
          log: quiet().log
        })
      ).toBeNull()
    }
    // Any weekly-suffixed period name is accepted: the suffix is the claim.
    expect(
      parseXaiQuota(
        withConfig({ currentPeriod: { type: 'USAGE_PERIOD_TYPE_ROLLING_WEEKLY', end: null } }),
        { log: quiet().log }
      )
    ).toEqual([{ kind: 'weekly', label: '7D', usedPercent: 20, resetsAt: null }])
  })

  it('never maps a dollar or credit field to a meter', () => {
    const meters = parseXaiQuota(
      withConfig({
        onDemandUsed: { val: 42 },
        prepaidBalance: { val: 99 },
        productUsage: [{ product: 'X', usagePercent: 88 }]
      }),
      { log: quiet().log }
    )
    // One meter, from creditUsagePercent alone: the per-product breakdown is
    // not a second meter, and overage is out of scope entirely.
    expect(meters).toHaveLength(1)
    expect(meters?.[0].usedPercent).toBe(20)
  })

  it('leaves no meter rather than a zero when the percent is unusable', () => {
    for (const percent of [undefined, null, '20', Number.NaN, -1, 101]) {
      expect(parseXaiQuota(withConfig({ creditUsagePercent: percent }), { log: quiet().log })).toEqual(
        []
      )
    }
    expect(
      parseXaiQuota(withConfig({ creditUsagePercent: 0 }), { log: quiet().log })?.map(
        (meter) => meter.usedPercent
      )
    ).toEqual([0])
  })

  it('turns an unparseable period end into null rather than a guess', () => {
    const meters = parseXaiQuota(
      withConfig({ currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: 'soon' } }),
      { log: quiet().log }
    )
    expect(meters?.[0].resetsAt).toBeNull()
  })

  it('calls a body that is not the billing document drift, and reports null', () => {
    for (const payload of [null, 'a string', 42, [], {}, { config: null }, { config: 7 }]) {
      expect(parseXaiQuota(payload, { log: quiet().log })).toBeNull()
    }
  })

  it('asks for format=credits, with the bearer and nothing else', async () => {
    const stub = stubFetch(200, JSON.stringify(CREDITS))
    const result = await xaiAdapter.fetchQuota('xai-token', {
      deadline: Date.now() + 5_000,
      fetchImpl: stub.impl,
      log: quiet().log
    })

    expect(result.ok && result.meters.map((meter) => `${meter.label} ${meter.usedPercent}%`)).toEqual(
      ['7D 20%']
    )
    expect(stub.calls[0].url).toBe(XAI_QUOTA_URL)
    expect(stub.calls[0].url).toMatch(/\?format=credits$/)
    expect(stub.calls[0].headers.authorization).toBe('Bearer xai-token')
    expect(stub.calls[0].headers['x-xai-token-auth']).toBeUndefined()
    expect(stub.calls[0].headers['user-agent']).toBeUndefined()
  })

  it('classifies failures: the 401 control unauthorized, the monthly body unparsed', async () => {
    const log = quiet().log
    const deadline = (): number => Date.now() + 5_000

    const unauthorized = stubFetch(401, '{"error":"Invalid or expired credentials"}')
    await expect(
      xaiAdapter.fetchQuota('t', { deadline: deadline(), fetchImpl: unauthorized.impl, log })
    ).resolves.toEqual({ ok: false, error: 'unauthorized' })

    const monthly = stubFetch(200, JSON.stringify(MONTHLY))
    await expect(
      xaiAdapter.fetchQuota('t', { deadline: deadline(), fetchImpl: monthly.impl, log })
    ).resolves.toEqual({ ok: false, error: 'unparsed' })

    const notFound = stubFetch(404, '<html>nginx</html>')
    await expect(
      xaiAdapter.fetchQuota('t', { deadline: deadline(), fetchImpl: notFound.impl, log })
    ).resolves.toEqual({ ok: false, error: 'unavailable' })
  })
})
