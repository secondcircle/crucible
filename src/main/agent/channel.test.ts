// @vitest-environment node
//
// Main's half of the agent channel is tested where its callers meet it: the
// `agent:prompt` handler Electron invokes, and the stream of port events that
// comes back out at the window. Electron itself is a stand-in — an `ipcMain`
// that remembers what was registered, and a window that remembers what was sent
// — and the port behind the channel is the fake adapter, the same module the
// app launches with, so nothing here is scripted twice.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { EVENT_CHANNEL, PROMPT_CHANNEL } from '../../shared/agent/channels'
import { createFakeAdapter } from '../../shared/agent/fake-adapter'
import type { AgentAdapter, PortEvent, TurnId } from '../../shared/agent/port'
import { serveAgentChannel } from './channel'

/** The reply the fake is scripted with today, written out independently. */
const CANNED_REPLY =
  'Hello from the fake adapter.' +
  ' Nothing was sent anywhere and nothing was paid for this reply.'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (invocation: unknown, ...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle(channel: string, handler: (invocation: unknown, ...args: unknown[]) => unknown) {
      // Electron refuses a second handler for one channel; so does this.
      if (electron.handlers.has(channel)) throw new Error(`second handler for ${channel}`)
      electron.handlers.set(channel, handler)
    },
    removeHandler(channel: string) {
      electron.handlers.delete(channel)
    }
  }
}))

/** The window, as much of it as the channel touches. */
interface StubWindow {
  readonly window: BrowserWindow
  /** Every port event the channel pushed at this window, in order. */
  readonly sent: readonly PortEvent[]
  /** The window loads a new document — a reload, or any cross-document nav. */
  reload(): void
  /** A same-document navigation: a fragment, a `pushState`. */
  navigateInPlace(): void
  /** The window is gone. */
  close(): void
}

function stubWindow(): StubWindow {
  const sent: PortEvent[] = []
  const navigations: Array<(details: { isMainFrame: boolean; isSameDocument: boolean }) => void> = []
  const closes: Array<() => void> = []
  let destroyed = false

  const window = {
    webContents: {
      isDestroyed: () => destroyed,
      send: (channel: string, event: PortEvent) => {
        expect(channel).toBe(EVENT_CHANNEL)
        sent.push(event)
      },
      on: (
        event: string,
        listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void
      ) => {
        expect(event).toBe('did-start-navigation')
        navigations.push(listener)
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
    reload() {
      for (const listener of navigations) listener({ isMainFrame: true, isSameDocument: false })
    },
    navigateInPlace() {
      for (const listener of navigations) listener({ isMainFrame: true, isSameDocument: true })
    },
    close() {
      destroyed = true
      for (const listener of closes) listener()
    }
  }
}

/** Invoke `agent:prompt` the way Electron does, payload and all. */
async function prompt(text: unknown): Promise<TurnId> {
  const handler = electron.handlers.get(PROMPT_CHANNEL)
  if (handler === undefined) throw new Error('nothing is handling agent:prompt')
  return (await handler({}, text)) as TurnId
}

/** The events of one renderer turn, in order. */
function turn(sent: readonly PortEvent[], turnId: TurnId): PortEvent[] {
  return sent.filter((event) => event.turnId === turnId)
}

/** What a turn's deltas add up to on screen. */
function text(sent: readonly PortEvent[], turnId: TurnId): string {
  return turn(sent, turnId)
    .filter((event) => event.type === 'text_delta')
    .map((event) => event.delta)
    .join('')
}

/**
 * The fake adapter, with everything it says of its own recorded beside it and
 * every disposal counted. Disposal is only observable from this side: what the
 * channel stops sending is suppression, what the adapter stops saying — and
 * that it was told to let go at all — is the work stopping (D6).
 */
function recordedFake(deltaPauseMs: number): {
  adapter: AgentAdapter
  said: readonly PortEvent[]
  disposals: () => number
} {
  const fake = createFakeAdapter({ deltaPauseMs })
  const said: PortEvent[] = []
  let disposals = 0
  fake.onEvent((event) => said.push(event))

  return {
    adapter: {
      prompt: (text) => fake.prompt(text),
      onEvent: (listener) => fake.onEvent(listener),
      dispose: () => {
        disposals += 1
        fake.dispose()
      }
    },
    said,
    disposals: () => disposals
  }
}

/** Let every pending timer and microtask run until nothing is left to do. */
async function runToQuiet(): Promise<void> {
  await vi.advanceTimersByTimeAsync(10_000)
}

beforeEach(() => {
  electron.handlers.clear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the agent:prompt handler', () => {
  it('answers with a turn id and streams the adapter’s turn under it', async () => {
    const view = stubWindow()
    serveAgentChannel(createFakeAdapter({ deltaPauseMs: 1 }), view.window)

    const id = await prompt('Hello agent')

    expect(id).toBe('t-1')
    expect(view.sent).toEqual([{ type: 'turn_started', turnId: 't-1' }])

    await runToQuiet()

    expect(view.sent.every((event) => event.turnId === 't-1')).toBe(true)
    expect(text(view.sent, 't-1')).toBe(CANNED_REPLY)
    expect(view.sent.at(-1)).toEqual({ type: 'turn_ended', turnId: 't-1' })
    // Exactly one start and one terminal event, whatever the script does between.
    expect(view.sent.filter((event) => event.type === 'turn_started')).toHaveLength(1)
    expect(
      view.sent.filter((event) => event.type === 'turn_ended' || event.type === 'error')
    ).toHaveLength(1)
  })

  it('refuses a prompt that arrives mid-turn, and the live turn runs on', async () => {
    const view = stubWindow()
    serveAgentChannel(createFakeAdapter({ deltaPauseMs: 1 }), view.window)

    const live = await prompt('Hello agent')
    const refused = await prompt('and another thing')

    // The refusal is the second turn's own terminal error, and it is complete
    // before the first turn has said another word.
    expect(refused).toBe('t-2')
    expect(refused).not.toBe(live)
    expect(turn(view.sent, refused)).toEqual([
      { type: 'turn_started', turnId: 't-2' },
      { type: 'error', turnId: 't-2', code: 'busy', message: expect.any(String) }
    ])
    expect(turn(view.sent, live)).toEqual([{ type: 'turn_started', turnId: 't-1' }])

    await runToQuiet()

    // The live turn was untouched by the refusal: it kept the guard, kept
    // streaming, and ended on its own.
    expect(text(view.sent, live)).toBe(CANNED_REPLY)
    expect(turn(view.sent, live).at(-1)).toEqual({ type: 'turn_ended', turnId: 't-1' })
    expect(turn(view.sent, refused)).toHaveLength(2)
  })

  it('releases the guard when the live turn ends, so the next prompt is served', async () => {
    const view = stubWindow()
    serveAgentChannel(createFakeAdapter({ deltaPauseMs: 1 }), view.window)

    await prompt('Hello agent')
    await runToQuiet()
    await prompt('again')
    await runToQuiet()

    expect(text(view.sent, 't-2')).toBe(CANNED_REPLY)
    expect(view.sent.filter((event) => event.type === 'error')).toEqual([])
  })

  it('answers a payload that is not text with a terminal error, and keeps serving', async () => {
    const view = stubWindow()
    serveAgentChannel(createFakeAdapter({ deltaPauseMs: 1 }), view.window)

    const id = await prompt(42)

    expect(id).toBe('t-1')
    expect(turn(view.sent, id)).toEqual([
      { type: 'turn_started', turnId: 't-1' },
      { type: 'error', turnId: 't-1', code: 'adapter', message: expect.any(String) }
    ])

    // Nothing was started, so nothing took the guard.
    await prompt('Hello agent')
    await runToQuiet()
    expect(text(view.sent, 't-2')).toBe(CANNED_REPLY)
  })

  it('reports a port that cannot accept as that turn’s terminal error', async () => {
    const view = stubWindow()
    const refusing: AgentAdapter = {
      prompt: () => Promise.reject(new Error('no session')),
      onEvent: () => () => {},
      dispose: () => {}
    }
    serveAgentChannel(refusing, view.window)

    const id = await prompt('Hello agent')

    expect(turn(view.sent, id)).toEqual([
      { type: 'turn_started', turnId: 't-1' },
      { type: 'error', turnId: 't-1', code: 'adapter', message: 'no session' }
    ])
  })

  it('disposes the turn on reload: the adapter stops, the guard falls, no stale text follows', async () => {
    const view = stubWindow()
    const fake = recordedFake(1)
    serveAgentChannel(fake.adapter, view.window)

    await prompt('Hello agent')
    await vi.advanceTimersByTimeAsync(3)
    expect(text(view.sent, 't-1')).not.toBe('')

    view.reload()
    const before = [...view.sent]
    const saidAtReload = [...fake.said]
    await runToQuiet()
    expect(view.sent).toEqual(before)
    // Disposed, not merely unheard: the adapter's own turn stopped where it
    // stood instead of running its script out with nobody watching, so it never
    // even reached the end of its script.
    expect(fake.said).toEqual(saidAtReload)
    expect(fake.said.at(-1)?.type).toBe('text_delta')

    // The document that came back prompts immediately — no refusal — and hears
    // its own turn in full, on an adapter the disposal left usable.
    const fresh = await prompt('Hello agent')
    await runToQuiet()

    expect(turn(view.sent, fresh)[0]).toEqual({ type: 'turn_started', turnId: 't-2' })
    expect(text(view.sent, fresh)).toBe(CANNED_REPLY)
    expect(turn(view.sent, fresh).at(-1)).toEqual({ type: 'turn_ended', turnId: 't-2' })
    expect(view.sent.filter((event) => event.type === 'error')).toEqual([])
    // The abandoned turn never said another word, not even under a new turn's id.
    expect(turn(view.sent, 't-1')).toEqual(turn(before, 't-1'))
  })

  it('keeps serving across a same-document navigation', async () => {
    const view = stubWindow()
    serveAgentChannel(createFakeAdapter({ deltaPauseMs: 1 }), view.window)

    await prompt('Hello agent')
    view.navigateInPlace()
    await runToQuiet()

    expect(text(view.sent, 't-1')).toBe(CANNED_REPLY)
  })

  it('stops serving when the window closes, and says so by unregistering', async () => {
    const view = stubWindow()
    const fake = recordedFake(1)
    const channel = serveAgentChannel(fake.adapter, view.window)

    await prompt('Hello agent')
    await vi.advanceTimersByTimeAsync(3)
    view.close()
    const before = [...view.sent]
    const saidAtClose = [...fake.said]
    await runToQuiet()

    expect(view.sent).toEqual(before)
    // The same disposal path as reload: a window that goes away mid-turn takes
    // the adapter's work with it rather than leaving it running (D6).
    expect(fake.said).toEqual(saidAtClose)
    expect(fake.disposals()).toBe(1)
    expect(electron.handlers.has(PROMPT_CHANNEL)).toBe(false)
    // Disposing again is allowed and does nothing — the app quits this way.
    expect(() => channel.dispose()).not.toThrow()
    expect(fake.disposals()).toBe(1)
  })

  it('disposes the adapter when the window goes away with no turn running', async () => {
    const view = stubWindow()
    const fake = recordedFake(1)
    serveAgentChannel(fake.adapter, view.window)

    // A turn that ran to its own end released the guard, but the session it was
    // served from is the adapter's and outlives it: closing has to let that go
    // too, or a launch leaves work behind every time it is quit (D6).
    await prompt('Hello agent')
    await runToQuiet()
    expect(text(view.sent, 't-1')).toBe(CANNED_REPLY)
    expect(fake.disposals()).toBe(0)

    view.close()

    expect(fake.disposals()).toBe(1)
  })

  it('disposes the adapter on a reload that interrupts nothing', async () => {
    const view = stubWindow()
    const fake = recordedFake(1)
    serveAgentChannel(fake.adapter, view.window)

    // Nothing was ever asked, so there is no turn to abandon — the document
    // still went away, and the adapter still answers to the next one alone.
    view.reload()

    expect(fake.disposals()).toBe(1)

    // And it is still an adapter: the document that came back is served in full.
    await prompt('Hello agent')
    await runToQuiet()
    expect(text(view.sent, 't-1')).toBe(CANNED_REPLY)
  })
})
