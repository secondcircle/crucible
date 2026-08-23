// @vitest-environment node
//
// The transport is injected, so no socket is opened and no authenticated call
// is made. The fixtures are live captures kept byte-for-byte, floats (`8.0`)
// and all, because the float-versus-integer distinction is a fact under test.
import { beforeEach, describe, expect, it } from 'vitest'
import type { QuotaMeter } from '../../../shared/quota/types'
import { forgetOnceIn } from '../log'
import {
  ANTHROPIC_QUOTA_URL,
  anthropicAdapter,
  parseAnthropicQuota
} from './anthropic'
import type { FetchLike } from './types'

const A2_CAPTURE: unknown = JSON.parse(
  String.raw`{"five_hour":{"utilization":8.0,"resets_at":"2026-08-14T22:29:59.777251+00:00","limit_dollars":null,"used_dollars":null,"remaining_dollars":null},"seven_day":{"utilization":56.0,"resets_at":"2026-08-19T05:59:59.777293+00:00","limit_dollars":null,"used_dollars":null,"remaining_dollars":null},"seven_day_oauth_apps":null,"seven_day_opus":null,"seven_day_sonnet":null,"seven_day_cowork":null,"seven_day_omelette":null,"tangelo":null,"iguana_necktie":null,"omelette_promotional":null,"nimbus_quill":{"utilization":0.0,"resets_at":null,"limit_dollars":null,"used_dollars":null,"remaining_dollars":null},"cinder_cove":null,"amber_ladder":null,"extra_usage":{"is_enabled":false,"monthly_limit":25000,"used_credits":8.0,"utilization":0.032,"currency":"USD","decimal_places":2,"disabled_reason":"out_of_credits","user_disabled":false,"spend_limit_reached":false,"credits_ever_enabled":true,"daily":null,"weekly":null},"limits":[{"kind":"session","group":"session","percent":8,"severity":"normal","resets_at":"2026-08-14T22:29:59.777251+00:00","scope":null,"is_active":false},{"kind":"weekly_all","group":"weekly","percent":56,"severity":"normal","resets_at":"2026-08-19T05:59:59.777293+00:00","scope":null,"is_active":false},{"kind":"weekly_scoped","group":"weekly","percent":74,"severity":"normal","resets_at":"2026-08-19T05:59:59.777478+00:00","scope":{"model":{"id":null,"display_name":"Fable"},"surface":null},"is_active":true}],"spend":{"used":{"amount_minor":8,"currency":"USD","exponent":2},"limit":{"amount_minor":25000,"currency":"USD","exponent":2},"percent":0,"severity":"normal","enabled":false,"disabled_reason":"out_of_credits","cap":{"money":null,"credits":{"amount_minor":25000,"exponent":2}},"balance":null,"auto_reload":null,"disclaimer":"Usage credits cover you when you hit your plan limits.","can_purchase_credits":false,"can_toggle":false},"member_dashboard_available":false}`
)

// The work account, captured live: an empty `limits[]` and a $5,000 monthly
// spend budget at $2,119.26, which is the only signal this plan reports.
const WORK_CAPTURE: unknown = JSON.parse(
  String.raw`{"five_hour":null,"seven_day":null,"seven_day_oauth_apps":null,"seven_day_opus":null,"seven_day_sonnet":null,"seven_day_cowork":null,"seven_day_omelette":null,"tangelo":null,"iguana_necktie":null,"omelette_promotional":null,"nimbus_quill":{"utilization":0.0,"resets_at":null,"limit_dollars":null,"used_dollars":null,"remaining_dollars":null},"cinder_cove":{"utilization":100.0,"resets_at":"2026-09-22T18:55:57.572982+00:00","limit_dollars":1000,"used_dollars":1000.0,"remaining_dollars":0.0},"amber_ladder":null,"extra_usage":{"is_enabled":true,"monthly_limit":500000,"used_credits":211926.0,"utilization":42.3852,"currency":"USD","decimal_places":2,"disabled_reason":null,"user_disabled":false,"spend_limit_reached":false,"credits_ever_enabled":true,"daily":null,"weekly":null},"limits":[],"spend":{"used":{"amount_minor":211926,"currency":"USD","exponent":2},"limit":{"amount_minor":500000,"currency":"USD","exponent":2},"percent":42,"severity":"normal","enabled":true,"disabled_reason":null,"cap":{"money":null,"credits":{"amount_minor":500000,"exponent":2}},"balance":null,"auto_reload":null,"disclaimer":"Usage credits cover you when you hit your plan limits.","can_purchase_credits":false,"can_toggle":false},"member_dashboard_available":true}`
)

/** Mid-August, so the month the spend meter draws against is a known one. */
const NOW = Date.UTC(2026, 7, 15, 12, 0, 0)

// The same endpoint a day earlier, so the parser is never tuned to one body.
const EARLIER_CAPTURE: unknown = JSON.parse(
  String.raw`{"five_hour":{"utilization":7,"resets_at":"2026-08-14T04:29:59.999655+00:00"},"seven_day":{"utilization":46,"resets_at":"2026-08-19T05:59:59.999676+00:00"},"nimbus_quill":{"utilization":0,"resets_at":null},"limits":[{"kind":"session","group":"session","percent":7,"severity":"normal","resets_at":"2026-08-14T04:29:59.999655+00:00","scope":null,"is_active":false},{"kind":"weekly_all","group":"weekly","percent":46,"severity":"normal","resets_at":"2026-08-19T05:59:59.999676+00:00","scope":null,"is_active":false},{"kind":"weekly_scoped","group":"weekly","percent":58,"severity":"normal","resets_at":"2026-08-19T05:59:59.999857+00:00","scope":{"model":{"id":null,"display_name":"Fable"},"surface":null},"is_active":true}]}`
)

function quiet(): { log: (message: string) => void; messages: string[] } {
  const messages: string[] = []
  return { log: (message) => messages.push(message), messages }
}

// A fresh copy per payload, so one test cannot poison another.
function withLimits(limits: unknown[]): unknown {
  return { ...(A2_CAPTURE as Record<string, unknown>), limits }
}

function parsed(payload: unknown): QuotaMeter[] {
  const meters = parseAnthropicQuota(payload, { log: quiet().log, now: NOW })
  expect(meters).not.toBeNull()
  return meters as QuotaMeter[]
}

/** The capture with its `.spend` replaced, everything else left alone. */
function withSpend(spend: unknown): unknown {
  return { ...(WORK_CAPTURE as Record<string, unknown>), spend }
}

/** A transport that never touches the network. */
function stubFetch(
  handler: (url: string) => { ok: boolean; status: number; body: string }
): { impl: FetchLike; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers })
    const answer = handler(url)
    return { ok: answer.ok, status: answer.status, text: async () => answer.body }
  }
  return { impl, calls }
}

// The warn-once gate belongs to the process, so each test starts with a fresh
// memory rather than inheriting whatever the last one said.
beforeEach(() => forgetOnceIn())

describe('the Anthropic quota adapter', () => {
  it('reads exactly the three live meters out of the capture', () => {
    expect(parsed(A2_CAPTURE)).toEqual([
      { kind: 'session', label: '5H', usedPercent: 8, resetsAt: 1786746599777, isActive: false },
      { kind: 'weekly', label: '7D', usedPercent: 56, resetsAt: 1787119199777, isActive: false },
      {
        kind: 'weekly_scoped',
        label: 'FABLE',
        usedPercent: 74,
        resetsAt: 1787119199777,
        scopeName: 'Fable',
        isActive: true
      }
    ])
  })

  it('reads the same shape a day earlier, with that day\u2019s numbers', () => {
    expect(parsed(EARLIER_CAPTURE).map((meter) => `${meter.label} ${meter.usedPercent}%`)).toEqual([
      '5H 7%',
      '7D 46%',
      'FABLE 58%'
    ])
  })

  it('never parses the rotating codename keys', () => {
    // `nimbus_quill` is a present, non-null top-level meter with a percentage.
    // A positional parser would emit a fourth meter from it.
    expect(parsed(A2_CAPTURE).map((meter) => meter.label)).toEqual(['5H', '7D', 'FABLE'])
  })

  it('reads limits[] only, so drifting top-level slots change nothing', () => {
    const drifted = {
      ...(A2_CAPTURE as Record<string, unknown>),
      five_hour: { utilization: 99, resets_at: '2026-08-14T22:29:59.777251+00:00' },
      limits: [
        {
          kind: 'weekly_all',
          group: 'weekly',
          percent: 56,
          resets_at: '2026-08-19T05:59:59.777293+00:00',
          scope: null,
          is_active: false
        }
      ]
    }
    expect(parsed(drifted)).toEqual([
      { kind: 'weekly', label: '7D', usedPercent: 56, resetsAt: 1787119199777, isActive: false }
    ])
  })

  it('carries the scoped meter\u2019s own name, which lives nowhere but limits[]', () => {
    const onlyLimits = { limits: (A2_CAPTURE as { limits: unknown[] }).limits }
    expect(parsed(onlyLimits).find((meter) => meter.kind === 'weekly_scoped')).toEqual({
      kind: 'weekly_scoped',
      label: 'FABLE',
      usedPercent: 74,
      resetsAt: 1787119199777,
      scopeName: 'Fable',
      isActive: true
    })
  })

  it('reads floats and integers alike as percents on 0\u2013100, never a fraction', () => {
    const meters = parsed(
      withLimits([
        { kind: 'session', percent: 8.0, resets_at: null, scope: null },
        { kind: 'weekly_all', percent: 56, resets_at: null, scope: null },
        {
          kind: 'weekly_scoped',
          percent: 74.5,
          resets_at: null,
          scope: { model: { display_name: 'Fable' } }
        }
      ])
    )
    expect(meters.map((meter) => meter.usedPercent)).toEqual([8, 56, 74.5])
    // `extra_usage.utilization` (0.032) is a different scale and is not a meter.
    expect(parsed(A2_CAPTURE).some((meter) => meter.usedPercent < 1)).toBe(false)
  })

  it('converts ISO-8601 resets to epoch milliseconds', () => {
    const [session, weekly, scoped] = parsed(A2_CAPTURE)
    expect(session.resetsAt).toBe(Date.parse('2026-08-14T22:29:59.777251+00:00'))
    // Microsecond precision is below the record's unit: the weekly pair, ~200 µs
    // apart on the wire, lands on the same millisecond.
    expect(weekly.resetsAt).toBe(scoped.resetsAt)
  })

  it('turns an absent or unparseable reset into null rather than a guess', () => {
    const meters = parsed(
      withLimits([
        { kind: 'session', percent: 8, resets_at: null, scope: null },
        { kind: 'weekly_all', percent: 56, resets_at: 'not a timestamp', scope: null },
        { kind: 'weekly_scoped', percent: 74, scope: { model: { display_name: 'Fable' } } }
      ])
    )
    expect(meters.map((meter) => meter.resetsAt)).toEqual([null, null, null])
  })

  it('drops a meter whose percent is absent, NaN-ish or out of range', () => {
    for (const percent of [undefined, null, '8', Number.NaN, -1, 101, Number.POSITIVE_INFINITY]) {
      const meters = parsed(
        withLimits([
          { kind: 'session', percent, resets_at: null, scope: null },
          { kind: 'weekly_all', percent: 56, resets_at: null, scope: null }
        ])
      )
      // Dropped — never rendered as 0, never clamped.
      expect(meters.map((meter) => meter.label)).toEqual(['7D'])
    }
    // 0 and 100 are legitimate readings and survive.
    expect(
      parsed(withLimits([{ kind: 'session', percent: 0, resets_at: null, scope: null }])).map(
        (meter) => meter.usedPercent
      )
    ).toEqual([0])
    expect(
      parsed(withLimits([{ kind: 'weekly_all', percent: 100, resets_at: null, scope: null }])).map(
        (meter) => meter.usedPercent
      )
    ).toEqual([100])
  })

  it('keeps the valid meters of a partial payload and logs what it dropped', () => {
    const sink = quiet()
    const meters = parseAnthropicQuota(
      withLimits([
        { kind: 'session', percent: 8, resets_at: null, scope: null },
        { kind: 'some_future_kind', percent: 30, resets_at: null, scope: null },
        { kind: 'weekly_scoped', percent: 74, resets_at: null, scope: null }
      ]),
      { log: sink.log }
    )
    expect(meters?.map((meter) => meter.label)).toEqual(['5H'])
    expect(sink.messages).toHaveLength(2)
    expect(sink.messages[0]).toMatch(/unrecognized limits\[\] kind/)
    expect(sink.messages[1]).toMatch(/display_name/)
  })

  it('keeps a duplicated meter once and says so', () => {
    const sink = quiet()
    const meters = parseAnthropicQuota(
      withLimits([
        { kind: 'weekly_all', percent: 56, resets_at: null, scope: null },
        { kind: 'weekly_all', percent: 12, resets_at: null, scope: null }
      ]),
      { log: sink.log }
    )
    expect(meters).toEqual([{ kind: 'weekly', label: '7D', usedPercent: 56, resetsAt: null }])
    expect(sink.messages).toHaveLength(1)
    expect(sink.messages[0]).toMatch(/duplicate/)
  })

  it('is empty rather than null when the payload names no meter it knows', () => {
    expect(parseAnthropicQuota({ limits: [] }, { log: quiet().log })).toEqual([])
  })

  it('calls a payload with no limits[] array drift, and reports null', () => {
    for (const payload of [
      null,
      'a string',
      42,
      [],
      {},
      { limits: null },
      { limits: { session: {} } },
      // The pre-limits[] shape: top-level slots only. There is no fallback, so
      // this is absence, not data.
      { five_hour: { utilization: 8, resets_at: '2026-08-14T22:29:59.777251+00:00' } }
    ]) {
      expect(parseAnthropicQuota(payload, { log: quiet().log })).toBeNull()
    }
  })

  it('reads the work account\u2019s dollar budget as its one monthly meter', () => {
    const meters = parsed(WORK_CAPTURE)

    expect(meters).toHaveLength(1)
    expect(meters[0]).toMatchObject({
      kind: 'monthly',
      label: 'MO',
      resetsAt: Date.UTC(2026, 8, 1),
      usedDollars: 2119.26,
      limitDollars: 5000
    })
    expect(meters[0].usedPercent).toBeCloseTo(42.3852, 6)
  })

  it('reads limits[] and .spend side by side where a plan reports both', () => {
    // A2's own `.spend` is disabled; switching it on is a plan with both.
    const both = withSpend({
      ...((WORK_CAPTURE as { spend: Record<string, unknown> }).spend ?? {})
    }) as Record<string, unknown>
    both.limits = (A2_CAPTURE as { limits: unknown[] }).limits

    expect(parsed(both).map((meter) => meter.label)).toEqual(['5H', '7D', 'FABLE', 'MO'])
  })

  it('never reads the codename pools, extra_usage or severity for the monthly meter', () => {
    // `cinder_cove` is a pinned 100% pool, `extra_usage` a parallel 42.3852%
    // record, and `severity` a colour the strip decides for itself. Blanking
    // all three changes nothing, and only `.spend` moves the meter.
    const stripped = {
      ...(WORK_CAPTURE as Record<string, unknown>),
      cinder_cove: null,
      nimbus_quill: null,
      extra_usage: null
    }
    expect(parsed(stripped)).toEqual(parsed(WORK_CAPTURE))

    const halved = withSpend({
      ...(WORK_CAPTURE as { spend: Record<string, unknown> }).spend,
      used: { amount_minor: 105963, currency: 'USD', exponent: 2 },
      percent: 99,
      severity: 'critical'
    })
    expect(parsed(halved)[0]).toMatchObject({ usedDollars: 1059.63 })
    expect(parsed(halved)[0].usedPercent).toBeCloseTo(21.1926, 6)
  })

  it('says nothing at all about a plan with no spend budget', () => {
    for (const spend of [null, undefined, { enabled: false, used: {}, limit: {} }]) {
      const sink = quiet()
      const meters = parseAnthropicQuota(withSpend(spend), { log: sink.log, now: NOW })
      expect(meters).toEqual([])
      // A plan without a dollar budget is normal, not drift.
      expect(sink.messages).toEqual([])
    }
    // The A2 capture carries a disabled `.spend` beside three real meters.
    expect(parsed(A2_CAPTURE).some((meter) => meter.kind === 'monthly')).toBe(false)
  })

  it('drops an enabled budget it cannot read, once, and keeps the rest', () => {
    for (const spend of [
      { enabled: true },
      { enabled: true, used: { amount_minor: 1 } },
      { enabled: true, used: { amount_minor: 1 }, limit: { amount_minor: 0 } },
      { enabled: true, used: { amount_minor: '1' }, limit: { amount_minor: 500000 } },
      { enabled: true, used: { amount_minor: -1 }, limit: { amount_minor: 500000 } },
      { enabled: true, used: 5, limit: 100 },
      // An exponent this large would read $2,119.26 as $0.
      { enabled: true, used: { amount_minor: 211926, exponent: 40 }, limit: { amount_minor: 500000 } }
    ]) {
      forgetOnceIn()
      const sink = quiet()
      const meters = parseAnthropicQuota(withSpend(spend), { log: sink.log, now: NOW })
      expect(meters).toEqual([])
      expect(sink.messages).toHaveLength(1)
      expect(sink.messages[0]).toMatch(/MO/)
    }
  })

  it('defaults a missing exponent to two, as the working precedent does', () => {
    const meters = parsed(
      withSpend({
        enabled: true,
        used: { amount_minor: 3750 },
        limit: { amount_minor: 500000, exponent: 2 }
      })
    )
    expect(meters[0]).toMatchObject({ usedDollars: 37.5, limitDollars: 5000 })
  })

  it('clamps the fill at a full budget while the amounts stay as spent', () => {
    const meters = parsed(
      withSpend({
        enabled: true,
        used: { amount_minor: 520000, exponent: 2 },
        limit: { amount_minor: 500000, exponent: 2 }
      })
    )
    expect(meters[0]).toMatchObject({ usedPercent: 100, usedDollars: 5200, limitDollars: 5000 })
  })

  it('resets on the first of the next month, in UTC, from the clock it was given', () => {
    const at = (now: number): number =>
      parseAnthropicQuota(WORK_CAPTURE, { log: quiet().log, now })?.[0]?.resetsAt as number

    expect(new Date(at(Date.UTC(2026, 11, 31, 23, 0, 0))).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z'
    )
    expect(new Date(at(Date.UTC(2026, 1, 3, 5, 0, 0))).toISOString()).toBe(
      '2026-03-01T00:00:00.000Z'
    )
  })

  it('carries the bearer to the documented URL and sends no extra headers', async () => {
    const stub = stubFetch(() => ({ ok: true, status: 200, body: JSON.stringify(A2_CAPTURE) }))
    const result = await anthropicAdapter.fetchQuota('sk-ant-oat-EXAMPLE', {
      deadline: Date.now() + 5_000,
      fetchImpl: stub.impl,
      log: quiet().log
    })

    expect(result.ok && result.meters.map((meter) => `${meter.label} ${meter.usedPercent}%`)).toEqual([
      '5H 8%',
      '7D 56%',
      'FABLE 74%'
    ])
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0].url).toBe(ANTHROPIC_QUOTA_URL)
    expect(stub.calls[0].headers.authorization).toBe('Bearer sk-ant-oat-EXAMPLE')
    expect(stub.calls[0].headers['anthropic-beta']).toBeUndefined()
    expect(stub.calls[0].headers['user-agent']).toBeUndefined()
  })

  it('classifies every kind of no-data without throwing, and says nothing about it', async () => {
    const sink = quiet()
    const deadline = (): number => Date.now() + 5_000
    for (const [status, error] of [
      [401, 'unauthorized'],
      [403, 'unauthorized'],
      [429, 'unavailable'],
      [500, 'unavailable']
    ] as Array<[number, string]>) {
      const stub = stubFetch(() => ({ ok: false, status, body: '' }))
      await expect(
        anthropicAdapter.fetchQuota('t', {
          deadline: deadline(),
          fetchImpl: stub.impl,
          log: sink.log
        })
      ).resolves.toEqual({ ok: false, error })
    }

    const html = stubFetch(() => ({ ok: true, status: 200, body: '<html>nope</html>' }))
    await expect(
      anthropicAdapter.fetchQuota('t', { deadline: deadline(), fetchImpl: html.impl, log: sink.log })
    ).resolves.toEqual({ ok: false, error: 'unparsed' })

    const drift = stubFetch(() => ({
      ok: true,
      status: 200,
      body: '{"five_hour":{"utilization":8}}'
    }))
    await expect(
      anthropicAdapter.fetchQuota('t', {
        deadline: deadline(),
        fetchImpl: drift.impl,
        log: sink.log
      })
    ).resolves.toEqual({ ok: false, error: 'unparsed' })

    const boom: FetchLike = async () => {
      throw new Error('socket hang up')
    }
    await expect(
      anthropicAdapter.fetchQuota('t', { deadline: deadline(), fetchImpl: boom, log: sink.log })
    ).resolves.toEqual({ ok: false, error: 'unavailable' })

    // A failed request is a provider state, and the store reports those: one
    // transition must not produce two messages.
    expect(sink.messages).toEqual([])
  })

  it('gives up on an expired deadline before issuing a request', async () => {
    const stub = stubFetch(() => ({ ok: true, status: 200, body: JSON.stringify(A2_CAPTURE) }))
    await expect(
      anthropicAdapter.fetchQuota('t', {
        deadline: Date.now() - 1,
        fetchImpl: stub.impl,
        log: quiet().log
      })
    ).resolves.toEqual({ ok: false, error: 'unavailable' })
    expect(stub.calls).toHaveLength(0)
  })

  it('sends an abort signal, because node fetch has no default timeout', async () => {
    let signal: AbortSignal | undefined
    const impl: FetchLike = async (_url, init) => {
      signal = init.signal
      return { ok: true, status: 200, text: async () => JSON.stringify(A2_CAPTURE) }
    }
    await anthropicAdapter.fetchQuota('t', {
      deadline: Date.now() + 5_000,
      fetchImpl: impl,
      log: quiet().log
    })
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(false)
  })
})
