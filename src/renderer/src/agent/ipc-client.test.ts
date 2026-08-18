// The IPC client is tested through the agent port — the only thing the pane
// ever sees of it — with the preload surface it sits on stood in for by an
// object this test controls. That stand-in is installed with
// `Object.defineProperty`, not by assigning `window.crucible`: naming that
// property is the one thing the import fence forbids the renderer, and a test
// is not an exception to a fence, it is a caller of the preload's own seam.
import { afterEach, describe, expect, it } from 'vitest'
import type { PortEvent, TurnId } from '../../../shared/agent/port'
import { createIpcClient } from './ipc-client'

/** The preload surface, as this test drives it. */
interface Surface {
  /** Every prompt the surface was asked, in order. */
  readonly prompts: string[]
  /** Push one event at the renderer, as main's `webContents.send` would. */
  emit(event: PortEvent): void
  /** How many times anything subscribed to the surface itself. */
  subscriptions(): number
}

function installPreloadSurface(answer: (text: string) => Promise<TurnId> = () => Promise.resolve('t-1')): Surface {
  const prompts: string[] = []
  const listeners = new Set<(event: PortEvent) => void>()
  let subscriptions = 0

  const agent = {
    prompt(text: string): Promise<TurnId> {
      prompts.push(text)
      return answer(text)
    },
    onEvent(listener: (event: PortEvent) => void): () => void {
      subscriptions += 1
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }

  Object.defineProperty(window, 'crucible', { value: { agent }, configurable: true })

  return {
    prompts,
    emit(event) {
      for (const listener of [...listeners]) listener(event)
    },
    subscriptions: () => subscriptions
  }
}

afterEach(() => {
  Reflect.deleteProperty(window, 'crucible')
})

/** One accepted turn's worth of events, as main sends them. */
const started: PortEvent = { type: 'turn_started', turnId: 't-1' }
const delta: PortEvent = { type: 'text_delta', turnId: 't-1', delta: 'Hello' }
const ended: PortEvent = { type: 'turn_ended', turnId: 't-1' }

describe('the renderer’s IPC client', () => {
  it('sends a prompt across and answers with the turn id main minted', async () => {
    const surface = installPreloadSurface(() => Promise.resolve('t-7'))
    const port = createIpcClient()

    await expect(port.prompt('Hello agent')).resolves.toBe('t-7')
    expect(surface.prompts).toEqual(['Hello agent'])
  })

  it('delivers a turn’s events, in order, to every listener', async () => {
    const surface = installPreloadSurface()
    const port = createIpcClient()
    const heard: PortEvent[] = []
    const alsoHeard: PortEvent[] = []
    port.onEvent((event) => heard.push(event))
    port.onEvent((event) => alsoHeard.push(event))

    await port.prompt('Hello agent')
    surface.emit(started)
    surface.emit(delta)
    surface.emit(ended)

    expect(heard).toEqual([started, delta, ended])
    expect(alsoHeard).toEqual(heard)
  })

  it('hears its own turn when the events land before the prompt resolves', async () => {
    // The ordering the port's contract warns about: main sends the turn's first
    // events from inside the handler, before the invoke it is answering has
    // resolved, so a turn is this document's from the moment it asked.
    const surface = installPreloadSurface()
    const port = createIpcClient()
    const heard: PortEvent[] = []
    port.onEvent((event) => heard.push(event))

    const pending = port.prompt('Hello agent')
    surface.emit(started)
    surface.emit(delta)
    await expect(pending).resolves.toBe('t-1')
    surface.emit(ended)

    expect(heard).toEqual([started, delta, ended])
  })

  it('unsubscribes one listener without disturbing the others, however often', async () => {
    const surface = installPreloadSurface()
    const port = createIpcClient()
    const heard: PortEvent[] = []
    const stop = port.onEvent(() => {
      throw new Error('this listener was unsubscribed')
    })
    port.onEvent((event) => heard.push(event))

    stop()
    stop()
    await port.prompt('Hello agent')
    surface.emit(started)

    expect(heard).toEqual([started])
  })

  it('drops a turn this document never asked for — a reload cannot be caught up', async () => {
    const surface = installPreloadSurface()
    const port = createIpcClient()
    const heard: PortEvent[] = []
    port.onEvent((event) => heard.push(event))

    // Main outlives the document, so a turn of the document before the reload
    // can still be streaming: its start included, since main mints ids without
    // starting the count again.
    surface.emit({ type: 'turn_started', turnId: 't-99' })
    surface.emit({ type: 'text_delta', turnId: 't-99', delta: 'from before the reload' })
    surface.emit({ type: 'turn_ended', turnId: 't-99' })
    surface.emit({ type: 'error', turnId: 't-99', code: 'adapter', message: 'from before' })

    expect(heard).toEqual([])

    // The fresh document's own turn is heard in full.
    await port.prompt('Hello agent')
    surface.emit(started)
    surface.emit(delta)
    surface.emit(ended)
    expect(heard).toEqual([started, delta, ended])
  })

  it('drops a stale turn that starts while one of its own is outstanding', async () => {
    // A prompt is in flight, so this document is owed exactly one turn — one,
    // not every start that happens to arrive while it waits.
    const surface = installPreloadSurface()
    const port = createIpcClient()
    const heard: PortEvent[] = []
    port.onEvent((event) => heard.push(event))

    const pending = port.prompt('Hello agent')
    surface.emit(started)
    surface.emit({ type: 'turn_started', turnId: 't-99' })
    surface.emit({ type: 'text_delta', turnId: 't-99', delta: 'from before the reload' })
    await pending

    expect(heard).toEqual([started])
  })

  it('drops a stale turn that starts before its own prompt’s id comes back', async () => {
    // The same ordering as above with the two starts the other way round: the
    // remounted pane prompts at once, and an event the old document queued
    // arrives first. Nothing about arrival order says whose a turn is — only
    // the id the prompt comes back with does — so the stale turn is dropped
    // however early it speaks, and this document's own turn is still heard in
    // full when it follows.
    const surface = installPreloadSurface()
    const port = createIpcClient()
    const heard: PortEvent[] = []
    port.onEvent((event) => heard.push(event))

    const pending = port.prompt('Hello agent')
    surface.emit({ type: 'turn_started', turnId: 't-99' })
    surface.emit({ type: 'text_delta', turnId: 't-99', delta: 'from before the reload' })
    await expect(pending).resolves.toBe('t-1')
    surface.emit(started)
    surface.emit(delta)
    surface.emit(ended)

    expect(heard).toEqual([started, delta, ended])
  })

  it('drops everything after a turn’s terminal event, its own repeats included', async () => {
    const surface = installPreloadSurface()
    const port = createIpcClient()
    const heard: PortEvent[] = []
    port.onEvent((event) => heard.push(event))

    await port.prompt('Hello agent')
    surface.emit(started)
    surface.emit(started)
    surface.emit(ended)
    surface.emit(delta)
    surface.emit(ended)
    surface.emit({ type: 'error', turnId: 't-1', code: 'adapter', message: 'too late' })

    expect(heard).toEqual([started, ended])
  })

  it('serves turn after turn, each one heard in full', async () => {
    let minted = 0
    const surface = installPreloadSurface(() => Promise.resolve(`t-${(minted += 1)}`))
    const port = createIpcClient()
    const heard: PortEvent[] = []
    port.onEvent((event) => heard.push(event))

    await port.prompt('Hello agent')
    surface.emit(started)
    surface.emit(ended)
    await port.prompt('and again')
    surface.emit({ type: 'turn_started', turnId: 't-2' })
    surface.emit({ type: 'text_delta', turnId: 't-2', delta: 'Hello' })
    surface.emit({ type: 'turn_ended', turnId: 't-2' })

    expect(heard).toEqual([
      started,
      ended,
      { type: 'turn_started', turnId: 't-2' },
      { type: 'text_delta', turnId: 't-2', delta: 'Hello' },
      { type: 'turn_ended', turnId: 't-2' }
    ])
  })

  it('subscribes to the preload surface once, whatever mounts and unmounts', () => {
    const surface = installPreloadSurface()
    const port = createIpcClient()

    const stop = port.onEvent(() => {})
    stop()
    port.onEvent(() => {})

    expect(surface.subscriptions()).toBe(1)
  })

  it('refuses to be built at all when the preload did not load', () => {
    expect(() => createIpcClient()).toThrow('window.crucible is missing')
  })

  it('lets a prompt the port refused reach the caller, and is owed no turn for it', async () => {
    const surface = installPreloadSurface(() => Promise.reject(new Error('No handler registered')))
    const port = createIpcClient()
    const heard: PortEvent[] = []
    port.onEvent((event) => heard.push(event))

    await expect(port.prompt('Hello agent')).rejects.toThrow('No handler registered')

    // Nothing was accepted, so the next turn to come past is somebody else's.
    surface.emit(started)
    expect(heard).toEqual([])
  })
})
