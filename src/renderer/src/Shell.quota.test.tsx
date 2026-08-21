// @vitest-environment jsdom
//
// Driven through a scripted service whose snapshots these tests author and
// whose calls they record, so no network, cache or adapter is involved.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeQuotaService } from '../../shared/quota/fake-service'
import type { QuotaService } from '../../shared/quota/service'
import type { QuotaMeter, QuotaSnapshot } from '../../shared/quota/types'
import { Shell } from './Shell'
import { createScriptedCommands } from './testing/scripted-commands'
import {
  createScriptedPort,
  oneSession,
  SESSION_TITLE,
  type ScriptedPort
} from './testing/scripted-port'
import { createScriptedQuota, refreshes } from './testing/scripted-quota'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { settled } from './testing/settled'

const MODEL = { id: 'fake/deterministic', label: 'Fake', thinkingLevels: ['off', 'low'] }

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

/** The instant every test in this file draws against. */
const NOW = Date.UTC(2026, 7, 15, 12, 0, 0)

function meter(over: Partial<QuotaMeter> = {}): QuotaMeter {
  return { kind: 'weekly', label: '7D', usedPercent: 20, resetsAt: NOW + 4 * DAY, ...over }
}

/** A weekly meter this far into its seven days, at this percent. */
function weekly(elapsed: number, usedPercent: number, over: Partial<QuotaMeter> = {}): QuotaMeter {
  return meter({ usedPercent, resetsAt: NOW - elapsed + WEEK, ...over })
}

function snapshotOf(
  providers: Record<string, { meters: QuotaMeter[]; fetchedAt?: number; error?: 'unavailable' }>,
  fetchedAt: number = NOW
): QuotaSnapshot {
  return {
    fetchedAt,
    providers: Object.fromEntries(
      Object.entries(providers).map(([providerId, quota]) => [
        providerId,
        {
          providerId,
          meters: quota.meters,
          fetchedAt: quota.fetchedAt ?? fetchedAt,
          ...(quota.error === undefined ? {} : { error: quota.error })
        }
      ])
    )
  }
}

let port: ScriptedPort

async function shellWith(quota?: QuotaService): Promise<HTMLElement> {
  port = createScriptedPort(oneSession({ model: MODEL.id, thinkingLevel: 'low' }))
  port.models = [MODEL]
  const { container } = render(
    <Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
      quota={quota}
    />
  )
  // The row is named by its title now, not by the hour it was created.
  await screen.findByRole('button', { name: SESSION_TITLE })
  await settled()
  return container
}

const strip = (container: HTMLElement): HTMLElement | null => container.querySelector('.quota')

const rows = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('.quota .qrow')
]

function readRow(row: HTMLElement): {
  name: string
  right: string
  stale: boolean
  meters: Array<{ label: string; text: string; fill: string; classes: string; tick?: string }>
} {
  const line = row.querySelector('.qline') as HTMLElement
  return {
    name: (line.firstElementChild as HTMLElement).textContent ?? '',
    right: (line.querySelector('.qreset') as HTMLElement).textContent ?? '',
    stale: row.classList.contains('qstale'),
    meters: [...row.querySelectorAll<HTMLElement>('.qmeter')].map((mrow) => {
      const fill = mrow.querySelector('i') as HTMLElement
      const tick = mrow.querySelector('u')
      return {
        label: (mrow.querySelector('.qlbl') as HTMLElement).textContent ?? '',
        text: (mrow.querySelector('.qnum') as HTMLElement).textContent ?? '',
        fill: fill.style.width,
        classes: `${fill.className} ${(mrow.querySelector('.qnum') as HTMLElement).className}`.trim(),
        ...(tick === null ? {} : { tick: (tick as HTMLElement).style.left })
      }
    })
  }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the quota strip', () => {
  it('does not exist without a quota service', async () => {
    const container = await shellWith(undefined)

    expect(strip(container)).toBeNull()
    expect(screen.queryByText('Subscriptions')).toBeNull()
  })

  it('renders no block at all when no provider is present', async () => {
    const container = await shellWith(createScriptedQuota(snapshotOf({})))

    // Heading and border included: signed out of everything looks like nothing.
    expect(strip(container)).toBeNull()
  })

  it('paints the cached reading before any refresh answers, then asks for one', async () => {
    const quota = createScriptedQuota(
      snapshotOf({ xai: { fetchedAt: NOW - 12 * MINUTE, meters: [meter({ usedPercent: 19 })] } })
    )
    // The refresh the strip asks for on launch is still running.
    quota.holdRefresh = true

    const container = await shellWith(quota)

    // The last cached reading is on screen already, dimmed with its age rather
    // than an empty block or a spinner.
    const painted = readRow(rows(container)[0])
    expect(painted.meters[0].text).toBe('19%')
    expect(painted.stale).toBe(true)
    expect(painted.right).toBe('·12m')
    expect(quota.calls[0]).toEqual({ op: 'read' })
    expect(refreshes(quota)).toEqual([{ op: 'refresh' }])

    // And nothing announces that a refresh is under way.
    expect(strip(container)?.textContent).not.toMatch(/loading|refreshing/i)

    await act(async () => {
      quota.snapshot = snapshotOf({ xai: { meters: [meter({ usedPercent: 21 })] } })
      quota.releaseRefresh()
    })

    expect(readRow(rows(container)[0]).meters[0].text).toBe('21%')
  })

  it('holds the providers in one alphabetical order as readings arrive', async () => {
    const quota = createScriptedQuota(
      snapshotOf({
        xai: { meters: [meter()] },
        'openai-codex': { meters: [meter()] },
        anthropic: { meters: [meter()] }
      })
    )
    const container = await shellWith(quota)

    expect(rows(container).map((row) => readRow(row).name)).toEqual([
      'Anthropic',
      'Codex',
      'Grok'
    ])

    // A later reading in a different order changes nothing about the rows.
    await act(async () => {
      quota.announce(
        snapshotOf({
          anthropic: { meters: [meter({ usedPercent: 31 })] },
          xai: { meters: [meter()] },
          'openai-codex': { meters: [meter()] }
        })
      )
    })

    expect(rows(container).map((row) => readRow(row).name)).toEqual([
      'Anthropic',
      'Codex',
      'Grok'
    ])
    expect(readRow(rows(container)[0]).meters[0].text).toBe('31%')
  })

  it('shows the longest live countdown over the meters, in kind order', async () => {
    const container = await shellWith(
      createScriptedQuota(
        snapshotOf({
          anthropic: {
            meters: [
              meter({ kind: 'weekly_scoped', label: 'FABLE', usedPercent: 22, resetsAt: NOW + 4 * DAY + 11 * HOUR }),
              meter({ kind: 'session', label: '5H', usedPercent: 73, resetsAt: NOW + 3 * HOUR }),
              meter({ usedPercent: 29, resetsAt: NOW + 4 * DAY + 11 * HOUR })
            ]
          }
        })
      )
    )

    const row = readRow(rows(container)[0])
    expect(row.right).toBe('⟳4d11')
    expect(row.meters.map((shown) => shown.label)).toEqual(['5H', '7D', 'FABLE'])
    expect(row.meters.map((shown) => shown.text)).toEqual(['73%', '29%', '22%'])
    expect(row.meters.map((shown) => shown.fill)).toEqual(['73%', '29%', '22%'])
  })

  it('renders a scoped meter at zero like any other, per Q1', async () => {
    const container = await shellWith(
      createScriptedQuota(
        snapshotOf({
          anthropic: {
            meters: [
              meter({ usedPercent: 29 }),
              meter({ kind: 'weekly_scoped', label: 'FABLE', usedPercent: 0 })
            ]
          }
        })
      )
    )

    const shown = readRow(rows(container)[0]).meters
    expect(shown.map((each) => each.label)).toEqual(['7D', 'FABLE'])
    // An empty bar reads as 0% used, which is the good end of the scale.
    expect(shown.map((each) => each.text)).toEqual(['29%', '0%'])
    expect(shown.map((each) => each.fill)).toEqual(['29%', '0%'])
  })

  it('colors at 70 and at 90, and prefixes the red number with a !', async () => {
    const container = await shellWith(
      createScriptedQuota(
        snapshotOf({
          anthropic: {
            meters: [
              meter({ kind: 'session', label: '5H', usedPercent: 91 }),
              meter({ usedPercent: 70 }),
              meter({ kind: 'weekly_scoped', label: 'FABLE', usedPercent: 69.9 })
            ]
          }
        })
      )
    )

    const shown = readRow(rows(container)[0]).meters
    expect(shown[0].text).toBe('!91%')
    expect(shown[0].classes).toBe('crit qnum crit')
    expect(shown[1].text).toBe('70%')
    expect(shown[1].classes).toBe('warn qnum warn')
    expect(shown[2].text).toBe('70%')
    expect(shown[2].classes).toBe('qnum')
  })

  it('ticks the weekly bars at the elapsed fraction and nothing else', async () => {
    const container = await shellWith(
      createScriptedQuota(
        snapshotOf({
          anthropic: {
            meters: [
              meter({ kind: 'session', label: '5H', usedPercent: 73, resetsAt: NOW + 3 * HOUR }),
              weekly(3.5 * DAY, 29),
              weekly(3.5 * DAY, 22, { kind: 'weekly_scoped', label: 'FABLE' })
            ]
          }
        })
      )
    )

    const shown = readRow(rows(container)[0]).meters
    // The 5H meter never gets a tick: hitting it is rare enough not to watch.
    expect(shown[0].tick).toBeUndefined()
    expect(shown[1].tick).toBe('50%')
    expect(shown[2].tick).toBe('50%')
  })

  it('says out and the day only for the provider whose burn lands past 100%', async () => {
    const container = await shellWith(
      createScriptedQuota(
        snapshotOf({
          'openai-codex': { meters: [weekly(92 * HOUR, 78)] },
          xai: { meters: [weekly(46 * HOUR, 19)] }
        })
      )
    )

    const [codex, grok] = rows(container).map(readRow)
    expect(codex.right).toMatch(/^⟳3d04 out \w{3}$/)
    // On track says nothing at all, which is what makes the word a signal.
    expect(grok.right).toBe('⟳5d02')
  })

  it('says nothing about pace in the first day of a window', async () => {
    const container = await shellWith(
      createScriptedQuota(snapshotOf({ xai: { meters: [weekly(6 * HOUR, 40)] } }))
    )

    const row = readRow(rows(container)[0])
    expect(row.meters[0].tick).toBeUndefined()
    expect(row.right).toBe('⟳6d18')
    expect(row.meters[0].text).toBe('40%')
  })

  it('dims a stale row, ages it, and drops both the emphasis and the word', async () => {
    const container = await shellWith(
      createScriptedQuota(
        snapshotOf({
          anthropic: {
            fetchedAt: NOW - 12 * MINUTE,
            meters: [meter({ kind: 'session', label: '5H', usedPercent: 91 }), weekly(4 * DAY, 80)]
          }
        })
      )
    )

    const row = readRow(rows(container)[0])
    expect(row.stale).toBe(true)
    expect(row.right).toBe('·12m')
    expect(row.meters.map((shown) => shown.text)).toEqual(['91%', '80%'])
    expect(row.meters.every((shown) => shown.classes === 'qnum')).toBe(true)
    // The tick is a clock fact and stays.
    expect(row.meters[1].tick).toBe('57.14285714285714%')
  })

  it('drops a reading past an hour to a dash, and never a stale number', async () => {
    const container = await shellWith(
      createScriptedQuota(
        snapshotOf({
          xai: { fetchedAt: NOW - 61 * MINUTE, meters: [meter({ usedPercent: 61 })] }
        })
      )
    )

    const row = rows(container)[0]
    expect(readRow(row).name).toBe('Grok')
    expect(readRow(row).right).toBe('')
    expect(row.querySelector('.qdash')?.textContent).toBe('—')
    expect(row.querySelectorAll('.qmeter')).toHaveLength(0)
  })

  it('asks for an unscoped refresh when the window takes focus', async () => {
    const quota = createScriptedQuota(snapshotOf({ xai: { meters: [meter()] } }))
    await shellWith(quota)
    const before = refreshes(quota).length

    await act(async () => {
      fireEvent.focus(window)
    })

    expect(refreshes(quota)).toHaveLength(before + 1)
    expect(refreshes(quota).at(-1)).toEqual({ op: 'refresh' })
  })

  it('asks for an unscoped refresh after every terminal turn event', async () => {
    const quota = createScriptedQuota(snapshotOf({ xai: { meters: [meter()] } }))
    await shellWith(quota)
    const before = refreshes(quota).length

    await act(async () => {
      port.emit({ type: 'turn_ended', sessionId: 's1', turnId: 't1' })
    })
    await act(async () => {
      port.emit({ type: 'turn_cancelled', sessionId: 's1', turnId: 't2' })
    })
    await act(async () => {
      port.emit({ type: 'turn_error', sessionId: 's1', turnId: 't3', message: 'it broke' })
    })

    // Cancelled and errored turns spent quota too.
    expect(refreshes(quota)).toHaveLength(before + 3)
    expect(refreshes(quota).slice(before)).toEqual([
      { op: 'refresh' },
      { op: 'refresh' },
      { op: 'refresh' }
    ])
  })

  it('asks once, for one provider, when a reset instant passes', async () => {
    const quota = createScriptedQuota(
      snapshotOf({
        anthropic: {
          meters: [
            meter({ usedPercent: 29, resetsAt: NOW + 30_000 }),
            // The weekly pair differs by microseconds, and is one reset.
            meter({ kind: 'weekly_scoped', label: 'FABLE', usedPercent: 22, resetsAt: NOW + 30_500 })
          ]
        },
        xai: { meters: [meter({ resetsAt: NOW + 5 * DAY })] }
      })
    )
    await shellWith(quota)
    const before = refreshes(quota).length

    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000)
    })

    expect(refreshes(quota).slice(before)).toEqual([{ op: 'refresh', providers: ['anthropic'] }])

    // A second pass over the same instants asks for nothing, and no other
    // provider's quota ever pays for a window that did not turn over.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000)
    })
    expect(refreshes(quota).slice(before)).toHaveLength(1)
    expect(refreshes(quota).some((call) => call.providers?.includes('xai') === true)).toBe(false)
  })

  it('repaints when main announces a refresh result', async () => {
    const quota = createScriptedQuota(snapshotOf({ xai: { meters: [meter({ usedPercent: 19 })] } }))
    const container = await shellWith(quota)

    await act(async () => {
      quota.announce(snapshotOf({ xai: { meters: [meter({ usedPercent: 44 })] } }))
    })

    expect(readRow(rows(container)[0]).meters[0].text).toBe('44%')
  })

  it('leaves the strip exactly as it was when a call is refused', async () => {
    const quota = createScriptedQuota(snapshotOf({ xai: { meters: [meter({ usedPercent: 19 })] } }))
    const container = await shellWith(quota)
    quota.refusal = 'Crucible could not read the quota.'

    await act(async () => {
      fireEvent.focus(window)
    })

    expect(readRow(rows(container)[0]).meters[0].text).toBe('19%')
    // Fetch trouble is never a UI error: nothing is announced anywhere.
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('offers nothing to click, focus or hover', async () => {
    const container = await shellWith(
      createScriptedQuota(
        snapshotOf({
          anthropic: { meters: [meter({ kind: 'session', label: '5H', usedPercent: 91 })] },
          xai: { fetchedAt: NOW - 61 * MINUTE, meters: [meter()] }
        })
      )
    )
    const block = strip(container) as HTMLElement

    expect(block.querySelectorAll('button, a, input, [role], [tabindex], [title]')).toHaveLength(0)
  })

  it('draws the canned flavor\u2019s every state at once, which is what it is for', async () => {
    const container = await shellWith(createFakeQuotaService(NOW))

    const [anthropic, codex, grok] = rows(container).map(readRow)

    // The monthly reset outlasts the weekly one, so it is what counts down.
    expect(anthropic.right).toBe('⟳12d00')
    expect(anthropic.meters.map((shown) => `${shown.label} ${shown.text}`)).toEqual([
      '5H 73%',
      '7D 29%',
      'FABLE 22%',
      'MO $2.1k/$5k · 42%'
    ])
    // Amber on the session meter, every windowed fill behind its tick.
    expect(anthropic.meters[0].classes).toBe('warn qnum warn')
    expect(Number.parseFloat(anthropic.meters[1].tick as string)).toBeCloseTo(36.3, 1)
    expect(Number.parseFloat(anthropic.meters[3].tick as string)).toBeCloseTo(61.3, 1)
    expect(Number.parseFloat(anthropic.meters[3].fill)).toBeCloseTo(42.4, 1)
    // Nothing is projected: two fifths of the budget with three fifths of the
    // month gone is on pace.
    expect(anthropic.right).not.toMatch(/out/)

    expect(codex.right).toMatch(/^⟳3d04 out \w{3}$/)
    expect(codex.meters[0].text).toBe('!91%')
    expect(codex.meters[0].classes).toBe('crit qnum crit')
    expect(Number.parseFloat(codex.meters[1].tick as string)).toBeCloseTo(54.8, 1)

    expect(grok.right).toBe('⟳5d02')
    expect(Number.parseFloat(grok.meters[0].tick as string)).toBeCloseTo(27.4, 1)
  })
})
