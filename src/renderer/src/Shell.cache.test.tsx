// @vitest-environment jsdom
//
// Every cache surface, driven through a scripted port and a cache service
// whose ledger these tests author: no filesystem, no adapter, no main.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CacheMissFacts, ShellSnapshot, TranscriptItem } from '../../shared/agent/port'
import { createFakeQuotaService } from '../../shared/quota/fake-service'
import {
  createFakeCacheService,
  fakeCacheHealth,
  type FakeCacheService
} from '../../shared/cache/fake-service'
import type { RunRecord } from '../../shared/workflows/run'
import { Shell } from './Shell'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedPort, oneSession, SESSION_TITLE, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkflowRuns } from './testing/scripted-workflow-runs'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { settled } from './testing/settled'

const LEDGER = '/Users/you/Library/Application Support/Crucible/cache-misses.jsonl'

/** Tuesday 3:04pm, local, which every "since" in this file is drawn from. */
const SINCE = new Date(2026, 7, 18, 15, 4, 0)

/** Two days after it, so the span still reads as a weekday. */
const NOW = SINCE.getTime() + 2 * 24 * 60 * 60 * 1000

function miss(over: Partial<CacheMissFacts> = {}): CacheMissFacts {
  return {
    tokensRebilled: 118_211,
    dollarsRebilled: 0.62,
    gapMs: 8 * 60 * 60 * 1000,
    modelChanged: 'no',
    thinkingChanged: 'no',
    jump: 'no',
    retention: '5m',
    ...over
  }
}

function health(over: { count?: number; dollars?: number; retention?: '5m' | '1h' } = {}) {
  return fakeCacheHealth({
    count: over.count ?? 9,
    dollars: over.dollars ?? 2.8,
    since: SINCE.toISOString(),
    ledgerPath: LEDGER,
    ...(over.retention === undefined ? {} : { retention: over.retention })
  })
}

let port: ScriptedPort
/** Elements the badge's jump scrolled to, oldest first. */
let scrolled: Element[]

interface Mounted {
  readonly container: HTMLElement
  readonly cache: FakeCacheService
}

async function mount(
  options: {
    /** Absent means a launch with no cache service at all. */
    readonly cache?: FakeCacheService
    readonly cacheless?: boolean
    readonly snapshot?: Partial<ShellSnapshot>
    readonly runs?: readonly RunRecord[]
    /** Settled history, as main would answer it. */
    readonly transcript?: readonly TranscriptItem[]
    /** Only where a test is about the two strips sharing the rail's foot. */
    readonly withQuota?: boolean
  } = {}
): Promise<Mounted> {
  const cache = options.cache ?? createFakeCacheService(health())
  port = createScriptedPort(options.snapshot ?? oneSession())
  if (options.transcript !== undefined) port.transcripts.set('s1', options.transcript)
  const { container } = render(
    <Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
      cache={options.cacheless === true ? undefined : cache}
      quota={options.withQuota === true ? createFakeQuotaService(NOW) : undefined}
      workflowRuns={
        options.runs === undefined ? undefined : createScriptedWorkflowRuns(options.runs)
      }
    />
  )
  await settled()
  return { container, cache }
}

const strip = (container: HTMLElement): HTMLElement | null =>
  container.querySelector('.cachestrip')

const seams = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('.cacheseam')
]

const badge = (): HTMLElement | null => screen.queryByRole('button', { name: /cache miss/i })

const facts = (seam: HTMLElement): string =>
  seam.querySelector('.csfacts')?.textContent ?? ''

/** A prompt sent the way a person sends one, through the composer. */
async function send(text: string): Promise<void> {
  const box = screen.getByLabelText('Message')
  fireEvent.change(box, { target: { value: text } })
  await act(async () => {
    fireEvent.keyDown(box, { key: 'Enter' })
  })
}

async function openDialog(container: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(strip(container) as HTMLElement)
  })
}

function runOf(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'en42',
    workflow: 'build',
    status: 'running',
    workspacePath: '/repos/crucible',
    workspaceName: 'crucible',
    sessionId: 's1',
    inputs: {},
    nodes: [
      { id: 'planner', status: 'complete', parents: [], reads: [], artifacts: [], cost: 1.2 },
      { id: 'builder', status: 'running', parents: ['planner'], reads: [], artifacts: [], cost: 0.7 }
    ],
    createdAt: '2026-08-20T10:00:00.000Z',
    startedAt: '2026-08-20T10:00:00.000Z',
    ...over
  }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
  scrolled = []
  // jsdom implements no scrolling, so the jump is observed by what it asked
  // to bring into view.
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element): void {
    scrolled.push(this)
  }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the cache strip', () => {
  it('does not exist without a cache service', async () => {
    const { container } = await mount({ cacheless: true })

    expect(strip(container)).toBeNull()
  })

  it('stays absent while nothing has been read', async () => {
    const cache = createFakeCacheService(health())
    cache.refusal = 'Crucible could not read the cache ledger.'
    const { container } = await mount({ cache })

    // A number nobody counted is worse than no strip at all.
    expect(strip(container)).toBeNull()
  })

  it('reads the ruled line: the count, the money, and the span it covers', async () => {
    const { container } = await mount()

    expect(strip(container)?.querySelector('.clabel')?.textContent).toBe('Cache · 9 misses')
    expect(strip(container)?.querySelector('.cmoney')?.textContent).toBe('$2.80 re-billed')
    expect(strip(container)?.querySelector('.cwhen')?.textContent).toBe('since Tue 3pm')
    expect(strip(container)?.getAttribute('aria-label')).toBe(
      'Cache health — 9 misses since your last reset'
    )
  })

  it('says one miss in the singular', async () => {
    const { container } = await mount({ cache: createFakeCacheService(health({ count: 1, dollars: 0.62 })) })

    expect(strip(container)?.querySelector('.clabel')?.textContent).toBe('Cache · 1 miss')
  })

  it('still renders at zero, with the money left off', async () => {
    const { container } = await mount({
      cache: createFakeCacheService(health({ count: 0, dollars: 0 }))
    })

    // An absent strip would take the only door to the view with it.
    expect(strip(container)?.querySelector('.clabel')?.textContent).toBe('Cache · 0 misses')
    expect(strip(container)?.querySelector('.cmoney')).toBeNull()
    expect(strip(container)?.querySelector('.cwhen')?.textContent).toBe('since Tue 3pm')
  })

  it('repaints while you watch when a miss lands anywhere', async () => {
    const { container, cache } = await mount({
      cache: createFakeCacheService(health({ count: 0, dollars: 0 }))
    })

    await act(async () => {
      cache.recordMiss(0.62)
    })

    expect(strip(container)?.querySelector('.clabel')?.textContent).toBe('Cache · 1 miss')
    expect(strip(container)?.querySelector('.cmoney')?.textContent).toBe('$0.62 re-billed')
  })

  it('sits above the quota block, which stays a block of nothing clickable', async () => {
    const { container } = await mount({ withQuota: true })
    const rail = container.querySelector('.side') as HTMLElement
    const at = (selector: string): number =>
      [...rail.children].findIndex((child) => child.matches(selector))

    expect(at('.cachestrip')).toBeGreaterThan(-1)
    expect(at('.cachestrip')).toBeLessThan(at('.quota'))
    // The cache strip is a sibling of the quota block, never a row in it.
    expect(container.querySelector('.quota .cachestrip')).toBeNull()
    expect(container.querySelectorAll('.quota button')).toHaveLength(0)
  })
})

describe('the cache health view', () => {
  it('opens from the strip with the facts already in hand', async () => {
    const { container } = await mount()

    await openDialog(container)

    const dialog = screen.getByRole('dialog', { name: 'Cache health' })
    const said = [...dialog.querySelectorAll('.cfact')].map((fact) => fact.textContent)
    expect(said).toEqual(['9misses', '$2.80re-billed', 'Tue 3:04pmcounting since'])
    // The path is the machine's way in, so it is shown whole: the home
    // directory shortened so the rest of it fits, and the absolute path on
    // the element itself.
    const path = dialog.querySelector('.cpath code')
    expect(path?.textContent).toBe('~/Library/Application Support/Crucible/cache-misses.jsonl')
    expect(path?.getAttribute('title')).toBe(LEDGER)
    expect(dialog.querySelector('.cretention')?.textContent).toBe(
      'Retention in force · 5 min (π default)'
    )
    // No list of misses: the ledger's reader is an agent.
    expect(dialog.textContent).not.toContain('118k')
  })

  it('names the retention when the hour is in force', async () => {
    const { container } = await mount({
      cache: createFakeCacheService(health({ retention: '1h' }))
    })

    await openDialog(container)

    expect(screen.getByRole('dialog').querySelector('.cretention')?.textContent).toBe(
      'Retention in force · 1 hour (PI_CACHE_RETENTION=long)'
    )
  })

  it('says it copied the path in the frame the click lands', async () => {
    const copied: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (text: string) => void copied.push(text) },
      configurable: true
    })
    const { container } = await mount()
    await openDialog(container)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy path' }))
    })

    expect(copied).toEqual([LEDGER])
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()

    // And it goes back to being a button.
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.getByRole('button', { name: 'Copy path' })).toBeTruthy()
  })

  it('disables reset in the click\u2019s frame and re-dates the counter when it lands', async () => {
    const cache = createFakeCacheService(health())
    cache.holdReset = true
    const { container } = await mount({ cache })
    await openDialog(container)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reset counter' }))
    })

    // Acknowledged before the ledger has answered (ADR 0010).
    const busy = screen.getByRole('button', { name: 'Resetting…' })
    expect((busy as HTMLButtonElement).disabled).toBe(true)
    // No confirmation dialog: reset deletes nothing, so it is deliberately cheap.
    expect(screen.getAllByRole('dialog')).toHaveLength(1)

    await act(async () => {
      cache.releaseReset()
    })

    expect(screen.getByRole('button', { name: 'Reset counter' })).toBeTruthy()
    expect(screen.getByRole('dialog').querySelector('.cfacts')?.textContent).toContain('0')
    expect(strip(container)?.querySelector('.clabel')?.textContent).toBe('Cache · 0 misses')
    // The count runs from the new instant, which is now.
    expect(strip(container)?.querySelector('.cwhen')?.textContent).toBe('since Thu 3pm')
  })

  it('repaints its facts while it is open', async () => {
    const { container, cache } = await mount()
    await openDialog(container)

    await act(async () => {
      cache.recordMiss(0.2)
    })

    expect(screen.getByRole('dialog').querySelector('.cfacts')?.textContent).toContain('10')
  })

  it('starts the investigation itself: a session, activated, already prompted', async () => {
    const { container } = await mount()
    await openDialog(container)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Investigate' }))
    })

    const created = port.calls.find((call) => call.op === 'createSession')
    const activated = port.calls.find((call) => call.op === 'activateSession')
    const prompted = port.calls.find((call) => call.op === 'prompt')
    // A new session in the active workspace, activated, and prompted.
    expect(created?.args).toEqual(['w1'])
    expect(activated?.args[0]).toBe(prompted?.args[0])
    expect(port.snapshotNow.activeSessionId).toBe(prompted?.args[0])
    const text = String(prompted?.args[1])
    // Everything the agent needs to begin: the file, the boundary, the setting.
    expect(text).toContain(LEDGER)
    expect(text).toContain(SINCE.toISOString())
    expect(text).toContain('5 minutes (π default)')
    expect(text).toContain('after the last reset')
    expect(text).toContain('Judge nothing away')
    // The prompt echoes in the transcript, as any prompt does.
    expect(screen.getByText(text, { exact: false })).toBeTruthy()
    // And the dialog is gone.
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says it is working, and holds the failure where the body is', async () => {
    const { container } = await mount()
    await openDialog(container)
    port.createSessionRefusal = 'That session could not be started.'

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Investigate' }))
    })

    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelector('.failure')?.textContent).toBe(
      'That session could not be started.'
    )
    // Re-enabled, so the person can try again.
    expect(
      (screen.getByRole('button', { name: 'Investigate' }) as HTMLButtonElement).disabled
    ).toBe(false)
  })

  it('disables Investigate with no workspace open, and says why', async () => {
    const { container } = await mount({ snapshot: { workspaces: [], sessions: [] } })
    await openDialog(container)

    const button = screen.getByRole('button', { name: 'Investigate' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getByRole('dialog').textContent).toContain('Investigate needs a workspace open')
  })

  it('closes on Escape and on Close', async () => {
    const { container } = await mount()

    await openDialog(container)
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(screen.queryByRole('dialog')).toBeNull()

    await openDialog(container)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('the per-session badge', () => {
  it('is absent until this session has paid for a miss', async () => {
    await mount()
    expect(badge()).toBeNull()

    await act(async () => {
      port.update((snapshot) => ({
        ...snapshot,
        sessions: snapshot.sessions.map((session) => ({
          ...session,
          cacheMisses: { count: 0, dollars: 0 }
        }))
      }))
    })
    expect(badge()).toBeNull()
  })

  it('shows the conversation\u2019s own count, whatever the strip says', async () => {
    await mount()

    await act(async () => {
      port.update((snapshot) => ({
        ...snapshot,
        sessions: snapshot.sessions.map((session) => ({
          ...session,
          cacheMisses: { count: 2, dollars: 1.24 }
        }))
      }))
    })

    const shown = badge()
    expect(shown?.textContent).toContain('2 misses')
    expect(shown?.getAttribute('aria-label')).toBe('2 cache misses in this session')
  })

  it('lands on the most recent seam when it is clicked', async () => {
    await mount({
      transcript: [
        { kind: 'cacheMiss', miss: miss({ tokensRebilled: 4_000 }) },
        { kind: 'assistant', markdown: 'the older answer' },
        { kind: 'cacheMiss', miss: miss() },
        { kind: 'assistant', markdown: 'the newer answer' }
      ]
    })

    await act(async () => {
      port.update((snapshot) => ({
        ...snapshot,
        sessions: snapshot.sessions.map((session) => ({
          ...session,
          cacheMisses: { count: 2, dollars: 1.24 }
        }))
      }))
    })
    await settled()

    await act(async () => {
      fireEvent.click(badge() as HTMLElement)
    })

    const all = seams(document.body)
    expect(all).toHaveLength(2)
    expect(scrolled.at(-1)).toBe(all[1])
  })
})

describe('the transcript seam', () => {
  it('renders a restored miss in place, above the message that paid for it', async () => {
    await mount({
      transcript: [
        { kind: 'user', text: 'pick that thread back up' },
        { kind: 'cacheMiss', miss: miss() },
        { kind: 'assistant', markdown: 'the writer appends on every turn end' }
      ]
    })
    await screen.findByRole('button', { name: SESSION_TITLE })

    const [seam] = seams(document.body)
    expect(seam.textContent).toContain('Cache miss')
    expect(facts(seam)).toBe(
      '118k tokens re-billed (+$0.62) · 8h since previous turn · model unchanged · ' +
        'thinking unchanged · retention 5 min'
    )
    // Immediately above the assistant message it happened on.
    const rows = [...(seam.closest('ol')?.children ?? [])]
    expect(rows.findIndex((row) => row.contains(seam)) + 1).toBe(
      rows.findIndex((row) => row.textContent?.includes('the writer appends'))
    )
  })

  it('lands above the paying assistant block on a live turn', async () => {
    await mount()
    await send('show me what a cache miss looks like')

    await act(async () => {
      port.text('s1', 'here is the answer that paid for it')
      port.emit({
        type: 'cache_miss',
        sessionId: 's1',
        turnId: port.turnOf('s1') as string,
        miss: miss()
      })
      port.endTurn('s1')
    })

    const [seam] = seams(document.body)
    const rows = [...(seam.closest('ol')?.children ?? [])]
    const seamAt = rows.findIndex((row) => row.contains(seam))
    expect(rows[seamAt - 1].textContent).toContain('show me what a cache miss looks like')
    expect(rows[seamAt + 1].textContent).toContain('here is the answer that paid for it')
  })

  // Review repro, left failing on purpose: the paying message's block is its
  // text plus the chain it opened, and the spec places the seam above the
  // whole block (§5.5). π maps `toolcall_start` before `message_end`, so at
  // the moment the miss event arrives the items already read
  // [assistant text, tool] — and `withSeam` walks back over the tools but
  // stops at the text, splitting the paying block in two.
  it('sits above the paid block when the paying message wrote text then called a tool', async () => {
    await mount()
    await send('break the cache')

    await act(async () => {
      port.text('s1', 'let me look at that file')
      port.toolStarted('s1', 'c1', 'bash', 'npm test')
      port.emit({
        type: 'cache_miss',
        sessionId: 's1',
        turnId: port.turnOf('s1') as string,
        miss: miss()
      })
    })

    const [seam] = seams(document.body)
    const rows = [...(seam.closest('ol')?.children ?? [])]
    const seamAt = rows.findIndex((row) => row.contains(seam))
    expect(rows[seamAt + 1].textContent).toContain('let me look at that file')
    expect(rows[seamAt + 2].querySelector('.chain')).not.toBeNull()
  })

  it('sits above the chain a tool-only message opened', async () => {
    await mount()
    await send('run the thing')

    await act(async () => {
      port.toolStarted('s1', 'c1', 'bash', 'npm test')
      port.toolEnded('s1', 'c1', true, 'ok')
      port.emit({
        type: 'cache_miss',
        sessionId: 's1',
        turnId: port.turnOf('s1') as string,
        miss: miss()
      })
    })

    const [seam] = seams(document.body)
    const rows = [...(seam.closest('ol')?.children ?? [])]
    const seamAt = rows.findIndex((row) => row.contains(seam))
    expect(rows[seamAt + 1].querySelector('.chain')).not.toBeNull()
  })

  it('says nothing about a fact Crucible does not know', async () => {
    await mount({
      transcript: [
        { kind: 'cacheMiss', miss: miss({ modelChanged: 'unknown', thinkingChanged: 'unknown' }) }
      ]
    })

    const said = facts(seams(document.body)[0])
    expect(said).not.toContain('model')
    expect(said).not.toContain('thinking')
    expect(said).toContain('retention 5 min')
  })

  it('carries no action of its own', async () => {
    await mount({ transcript: [{ kind: 'cacheMiss', miss: miss() }] })

    // The badge already jumps here and the strip already opens the view.
    expect(seams(document.body)[0].querySelector('button')).toBeNull()
    expect(seams(document.body)[0].querySelector('a')).toBeNull()
  })
})

describe('the run chip', () => {
  it('carries no mark for a run that has paid for nothing', async () => {
    const { container } = await mount({ runs: [runOf()] })

    expect(container.querySelector('.runchip')).not.toBeNull()
    expect(container.querySelector('.runchip .miss')).toBeNull()
  })

  it('sums the run\u2019s nodes into one amber mark', async () => {
    const { container } = await mount({
      runs: [
        runOf({
          nodes: [
            {
              id: 'planner',
              status: 'complete',
              parents: [],
              reads: [],
              artifacts: [],
              cacheMisses: 1
            },
            {
              id: 'builder',
              status: 'running',
              parents: [],
              reads: [],
              artifacts: [],
              cacheMisses: 1
            }
          ]
        })
      ]
    })

    const mark = container.querySelector('.runchip .miss')
    // Part of the chip, not a second thing to click.
    expect(mark?.textContent).toContain('2')
    expect(mark?.getAttribute('title')).toBe('2 cache misses in this run')
    expect(mark?.closest('button')?.className).toContain('runchip')
  })
})
