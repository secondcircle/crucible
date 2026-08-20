// @vitest-environment node
//
// The transport is injected, so no socket is opened and no authenticated call
// is made. The fixture is a live capture whose identity fields are left as the
// redacted placeholders they were: none of that is anything Crucible keeps.
import { beforeEach, describe, expect, it } from 'vitest'
import type { QuotaMeter } from '../../../shared/quota/types'
import { forgetOnceIn } from '../log'
import { CODEX_QUOTA_URL, codexAdapter, parseCodexQuota } from './codex'
import type { FetchLike } from './types'

// A live account: its one weekly window sits in the slot called primary, and
// its scoped meter nests one level deeper.
const CAPTURE: Record<string, unknown> = JSON.parse(String.raw`{
  "account_id": "f659692f-8e71-4fa8-8909-ca04367fc8eb",
  "plan_type": "prolite",
  "rate_limit": {
    "allowed": true, "limit_reached": false,
    "primary_window": { "used_percent": 7, "limit_window_seconds": 604800,
                        "reset_after_seconds": 461564, "reset_at": 1787196985 },
    "secondary_window": null
  },
  "code_review_rate_limit": null,
  "additional_rate_limits": [
    { "limit_name": "GPT-5.3-Codex-Spark", "metered_feature": "codex_bengalfox",
      "rate_limit": { "allowed": true, "limit_reached": false,
        "primary_window": { "used_percent": 0, "limit_window_seconds": 604800,
                            "reset_after_seconds": 604800, "reset_at": 1787340221 },
        "secondary_window": null } }
  ],
  "credits": { "has_credits": false, "unlimited": false, "overage_limit_reached": false,
               "balance": "0", "approx_local_messages": [0,0], "approx_cloud_messages": [0,0] },
  "spend_control": { "reached": false, "individual_limit": null },
  "rate_limit_reached_type": null, "promo": null,
  "rate_limit_reset_credits": { "available_count": 0, "applicable_available_count": 0 }
}`)

function quiet(): { log: (message: string) => void; messages: string[] } {
  const messages: string[] = []
  return { log: (message) => messages.push(message), messages }
}

function parsed(payload: unknown): QuotaMeter[] {
  const meters = parseCodexQuota(payload, { log: quiet().log })
  expect(meters).not.toBeNull()
  return meters as QuotaMeter[]
}

function withRateLimit(rateLimit: unknown, additional: unknown = []): unknown {
  return { ...CAPTURE, rate_limit: rateLimit, additional_rate_limits: additional }
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

describe('the Codex quota adapter', () => {
  it('reads the weekly meter and the scoped Spark meter out of the capture', () => {
    expect(parsed(CAPTURE)).toEqual([
      { kind: 'weekly', label: '7D', usedPercent: 7, resetsAt: 1787196985000 },
      {
        kind: 'weekly_scoped',
        label: 'SPARK',
        usedPercent: 0,
        resetsAt: 1787340221000,
        scopeName: 'GPT-5.3-Codex-Spark'
      }
    ])
  })

  it('labels the weekly meter in the PRIMARY slot 7D, not 5H', () => {
    // This is the live account's shape: a positional parser reads primary as
    // "the five-hour one" and prints a weekly number under an hourly label.
    const [weekly] = parsed(CAPTURE)
    expect(weekly.label).toBe('7D')
    expect(weekly.kind).toBe('weekly')
  })

  it('classifies by limit_window_seconds wherever the window sits', () => {
    const swapped = withRateLimit({
      primary_window: { used_percent: 4, limit_window_seconds: 18000, reset_at: 1787196985 },
      secondary_window: { used_percent: 61, limit_window_seconds: 604800, reset_at: 1787340221 }
    })
    expect(parsed(swapped)).toEqual([
      { kind: 'session', label: '5H', usedPercent: 4, resetsAt: 1787196985000 },
      { kind: 'weekly', label: '7D', usedPercent: 61, resetsAt: 1787340221000 }
    ])
  })

  it('tolerates ±60 s on a duration and no more', () => {
    for (const seconds of [604_800 - 60, 604_800 + 60]) {
      expect(
        parsed(
          withRateLimit({
            primary_window: { used_percent: 5, limit_window_seconds: seconds, reset_at: 1 }
          })
        ).map((meter) => meter.label)
      ).toEqual(['7D'])
    }
    for (const seconds of [18_000 - 60, 18_000 + 60]) {
      expect(
        parsed(
          withRateLimit({
            primary_window: { used_percent: 5, limit_window_seconds: seconds, reset_at: 1 }
          })
        ).map((meter) => meter.label)
      ).toEqual(['5H'])
    }

    const sink = quiet()
    const meters = parseCodexQuota(
      withRateLimit({
        primary_window: { used_percent: 5, limit_window_seconds: 86_400, reset_at: 1 },
        secondary_window: { used_percent: 5, limit_window_seconds: 604_800 - 61, reset_at: 1 }
      }),
      { log: sink.log }
    )
    // Never guess a label: an unfamiliar duration is a missing meter, not a
    // wrong one.
    expect(meters).toEqual([])
    expect(sink.messages).toHaveLength(2)
    expect(sink.messages[0]).toMatch(/unrecognized limit_window_seconds: 86400/)
  })

  it('reads reset_at as unix seconds and leaves a millisecond value alone', () => {
    const seconds = parsed(
      withRateLimit({
        primary_window: { used_percent: 5, limit_window_seconds: 604800, reset_at: 1787196985 }
      })
    )
    expect(seconds[0].resetsAt).toBe(1787196985000)

    const millis = parsed(
      withRateLimit({
        primary_window: { used_percent: 5, limit_window_seconds: 604800, reset_at: 1787196985000 }
      })
    )
    expect(millis[0].resetsAt).toBe(1787196985000)

    const none = parsed(
      withRateLimit({ primary_window: { used_percent: 5, limit_window_seconds: 604800 } })
    )
    expect(none[0].resetsAt).toBeNull()
  })

  it('drops a meter whose percent is absent, NaN-ish or out of range', () => {
    for (const used of [undefined, null, '7', Number.NaN, -1, 101]) {
      expect(
        parsed(
          withRateLimit({
            primary_window: { used_percent: used, limit_window_seconds: 18000, reset_at: 1 },
            secondary_window: { used_percent: 61, limit_window_seconds: 604800, reset_at: 1 }
          })
        ).map((meter) => meter.label)
      ).toEqual(['7D'])
    }
    expect(
      parsed(
        withRateLimit({
          primary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: 1 }
        })
      ).map((meter) => meter.usedPercent)
    ).toEqual([0])
  })

  it('takes a scoped label from limit_name\u2019s last dash segment', () => {
    const meters = parsed(
      withRateLimit({ primary_window: null, secondary_window: null }, [
        {
          limit_name: 'GPT-6-Codex-Ember',
          rate_limit: {
            primary_window: { used_percent: 12, limit_window_seconds: 604800, reset_at: 1 }
          }
        },
        // No limit_name: there is no name to print, so nothing is printed.
        {
          rate_limit: {
            primary_window: { used_percent: 30, limit_window_seconds: 604800, reset_at: 1 }
          }
        },
        // No nested rate_limit: the struct nests one level deeper than the top.
        {
          limit_name: 'Nope',
          primary_window: { used_percent: 30, limit_window_seconds: 604800, reset_at: 1 }
        }
      ])
    )
    expect(meters).toEqual([
      {
        kind: 'weekly_scoped',
        label: 'EMBER',
        usedPercent: 12,
        resetsAt: 1000,
        scopeName: 'GPT-6-Codex-Ember'
      }
    ])
  })

  it('logs an unrecognized duration once per process, sink or no sink', () => {
    // The suppression belongs to the process rather than to the sink, or a
    // store that injects one would get a diagnostic per parse forever.
    const first = quiet()
    const second = quiet()
    const payload = withRateLimit({
      primary_window: { used_percent: 12, limit_window_seconds: 99_991, reset_at: 1 }
    })

    parseCodexQuota(payload, { log: first.log })
    parseCodexQuota(payload, { log: second.log })

    expect(first.messages).toHaveLength(1)
    expect(first.messages[0]).toMatch(/unrecognized limit_window_seconds: 99991/)
    expect(second.messages).toEqual([])
  })

  it('keeps a duplicated meter once and says so', () => {
    const sink = quiet()
    const meters = parseCodexQuota(
      withRateLimit({
        primary_window: { used_percent: 7, limit_window_seconds: 604800, reset_at: 1 },
        secondary_window: { used_percent: 99, limit_window_seconds: 604800, reset_at: 1 }
      }),
      { log: sink.log }
    )
    expect(meters).toEqual([{ kind: 'weekly', label: '7D', usedPercent: 7, resetsAt: 1000 }])
    expect(sink.messages.filter((message) => /duplicate/.test(message))).toHaveLength(1)
  })

  it('calls a payload with no rate_limit object drift, and reports null', () => {
    for (const payload of [
      null,
      'a string',
      42,
      [],
      {},
      { rate_limit: null },
      { additional_rate_limits: [] }
    ]) {
      expect(parseCodexQuota(payload, { log: quiet().log })).toBeNull()
    }
    // Present but empty is a real state, not drift: reachable, nothing metered.
    expect(parseCodexQuota({ rate_limit: {} }, { log: quiet().log })).toEqual([])
  })

  it('never maps a dollar field to a meter', () => {
    const meters = parsed(CAPTURE)
    expect(meters).toHaveLength(2)
    expect(
      meters.some((meter) => meter.label.includes('CREDIT') || meter.label.includes('SPEND'))
    ).toBe(false)
  })

  it('carries originator: pi to the documented URL, and no account id', async () => {
    const stub = stubFetch(200, JSON.stringify(CAPTURE))
    const result = await codexAdapter.fetchQuota('codex-token', {
      deadline: Date.now() + 5_000,
      fetchImpl: stub.impl,
      log: quiet().log
    })

    expect(result.ok && result.meters.map((meter) => `${meter.label} ${meter.usedPercent}%`)).toEqual(
      ['7D 7%', 'SPARK 0%']
    )
    expect(stub.calls[0].url).toBe(CODEX_QUOTA_URL)
    expect(stub.calls[0].headers.authorization).toBe('Bearer codex-token')
    expect(stub.calls[0].headers.originator).toBe('pi')
    // Optional, and deriving it would mean decoding the token's identity claims.
    expect(stub.calls[0].headers['chatgpt-account-id']).toBeUndefined()
  })

  it('classifies failures: 401/403 unauthorized, 429 unavailable, junk unparsed', async () => {
    const log = quiet().log
    const deadline = (): number => Date.now() + 5_000
    for (const [status, error] of [
      [401, 'unauthorized'],
      [403, 'unauthorized'],
      [429, 'unavailable'],
      [500, 'unavailable']
    ] as Array<[number, string]>) {
      const stub = stubFetch(status, '')
      await expect(
        codexAdapter.fetchQuota('t', { deadline: deadline(), fetchImpl: stub.impl, log })
      ).resolves.toEqual({ ok: false, error })
    }

    const html = stubFetch(200, '<html>nope</html>')
    await expect(
      codexAdapter.fetchQuota('t', { deadline: deadline(), fetchImpl: html.impl, log })
    ).resolves.toEqual({ ok: false, error: 'unparsed' })

    const drift = stubFetch(200, '{"plan_type":"prolite"}')
    await expect(
      codexAdapter.fetchQuota('t', { deadline: deadline(), fetchImpl: drift.impl, log })
    ).resolves.toEqual({ ok: false, error: 'unparsed' })

    const boom: FetchLike = async () => {
      throw new Error('socket hang up')
    }
    await expect(
      codexAdapter.fetchQuota('t', { deadline: deadline(), fetchImpl: boom, log })
    ).resolves.toEqual({ ok: false, error: 'unavailable' })
  })
})
