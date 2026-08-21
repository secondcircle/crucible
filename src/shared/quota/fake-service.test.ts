// @vitest-environment node
//
// The canned quota service: what an agent-driven check sees, and what it must
// never do — no network, no credential, no disk.
import { describe, expect, it, vi } from 'vitest'
import { cannedQuotaSnapshot, createFakeQuotaService } from './fake-service'
import { isStale, worstUsedPercent } from './freshness'
import { monthWindowStart } from './month'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const LAUNCH = Date.UTC(2026, 7, 15, 12, 0, 0)

describe('the canned quota service', () => {
  it('answers with the same snapshot however it is asked, and opens no socket', async () => {
    const fetching = vi.spyOn(globalThis, 'fetch')
    const service = createFakeQuotaService(LAUNCH)

    const read = await service.read()
    const refreshed = await service.refresh()
    const scoped = await service.refresh({ providers: ['xai'] })

    expect(refreshed).toBe(read)
    expect(scoped).toBe(read)
    expect(fetching).not.toHaveBeenCalled()
    fetching.mockRestore()
  })

  it('never has anything new to say, so a check cannot be surprised mid-run', () => {
    const service = createFakeQuotaService(LAUNCH)
    const heard: unknown[] = []

    const stop = service.onChange((snapshot) => heard.push(snapshot))
    stop()

    expect(heard).toEqual([])
  })

  it('reports the three providers with the meters their plans report', () => {
    const snapshot = cannedQuotaSnapshot(LAUNCH)

    expect(Object.keys(snapshot.providers).sort()).toEqual(['anthropic', 'openai-codex', 'xai'])
    expect(
      snapshot.providers.anthropic.meters.map(
        // The monthly percent is division over two dollar amounts, so it is
        // read to the cent rather than to the last float digit.
        (meter) => `${meter.label} ${Math.round(meter.usedPercent * 100) / 100}`
      )
    ).toEqual(['5H 73', '7D 29', 'FABLE 22', 'MO 42.39'])
    expect(
      snapshot.providers['openai-codex'].meters.map((meter) => `${meter.label} ${meter.usedPercent}`)
    ).toEqual(['5H 91', '7D 78'])
    expect(snapshot.providers.xai.meters.map((meter) => `${meter.label} ${meter.usedPercent}`)).toEqual(
      ['7D 19']
    )
  })

  it('meters the work account\u2019s dollar budget, which is what MO draws', () => {
    const monthly = cannedQuotaSnapshot(LAUNCH).providers.anthropic.meters.find(
      (meter) => meter.kind === 'monthly'
    )

    expect(monthly).toMatchObject({ label: 'MO', usedDollars: 2119.26, limitDollars: 5000 })
    // Twelve days to the reset, so most of the month is already behind it and
    // the tick sits ahead of the fill.
    expect((monthly?.resetsAt as number) - LAUNCH).toBe(12 * DAY)
    const window = (monthly?.resetsAt as number) - monthWindowStart(monthly?.resetsAt as number)
    const elapsed = (LAUNCH - ((monthly?.resetsAt as number) - window)) / window
    expect(elapsed * 100).toBeGreaterThan(monthly?.usedPercent as number)
  })

  it('anchors every reset to launch, so nothing lapses or goes stale during a check', () => {
    const snapshot = cannedQuotaSnapshot(LAUNCH)
    const weekly = (providerId: string): number =>
      Math.max(
        ...snapshot.providers[providerId].meters
          .filter((meter) => meter.kind === 'weekly' || meter.kind === 'weekly_scoped')
          .map((meter) => meter.resetsAt ?? 0)
      )

    // The countdowns these anchors print: 4d11, 3d04, 5d02.
    expect(weekly('anthropic') - LAUNCH).toBe(107 * HOUR)
    expect(weekly('openai-codex') - LAUNCH).toBe(76 * HOUR)
    expect(weekly('xai') - LAUNCH).toBe(122 * HOUR)

    for (const quota of Object.values(snapshot.providers)) {
      expect(isStale(quota, LAUNCH)).toBe(false)
      for (const meter of quota.meters) expect(meter.resetsAt).toBeGreaterThan(LAUNCH)
    }
  })

  it('is coherent arithmetic: Codex is past its pace, the other two are behind it', () => {
    const snapshot = cannedQuotaSnapshot(LAUNCH)
    const week = 7 * 24 * HOUR
    // The elapsed fraction of each weekly window, which is the number the pace
    // tick draws and the divisor the projection uses.
    const pace = (providerId: string): number[] =>
      snapshot.providers[providerId].meters
        .filter((meter) => meter.kind === 'weekly' || meter.kind === 'weekly_scoped')
        .map((meter) => meter.usedPercent / ((LAUNCH - ((meter.resetsAt as number) - week)) / week))

    expect((LAUNCH - (LAUNCH + 107 * HOUR - week)) / week).toBeCloseTo(0.363, 3)
    // Behind the tick: nothing is said about either of these.
    expect(Math.max(...pace('anthropic'))).toBeLessThan(100)
    expect(Math.max(...pace('xai'))).toBeLessThan(100)
    // Past it, which is what earns Codex the out-word.
    expect(Math.max(...pace('openai-codex'))).toBeGreaterThan(100)
  })

  it('answers the read seam with the worst live percent of each provider', () => {
    const snapshot = cannedQuotaSnapshot(LAUNCH)

    expect(worstUsedPercent(snapshot, 'anthropic', LAUNCH)).toBe(73)
    expect(worstUsedPercent(snapshot, 'openai-codex', LAUNCH)).toBe(91)
    // A provider nobody is signed into is unknown, never a zero.
    expect(worstUsedPercent(snapshot, 'google', LAUNCH)).toBeNull()
  })
})
