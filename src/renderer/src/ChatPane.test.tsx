// The chat pane is mounted the way the app mounts it — with an agent port
// handed in as a prop (D4) — and asserted on through what it renders. Nothing
// here touches `window.crucible`, Electron or the π SDK.
//
// What the fake adapter answers with is stated here rather than imported from
// it: a test that took its expected output from the implementation it is
// checking has no oracle of its own.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeAdapter } from '../../shared/agent/fake-adapter'
import type { AgentPort, PortEvent, PortEventListener, TurnId } from '../../shared/agent/port'
import { ChatPane } from './ChatPane'

/** The reply the fake is scripted with today, written out independently. */
const CANNED_REPLY =
  'Hello from the fake adapter.' +
  ' Nothing was sent anywhere and nothing was paid for this reply.'

// Vitest runs without globals, so Testing Library's own auto-cleanup never
// registers: each test unmounts what it rendered here instead.
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function messageBox(): HTMLInputElement {
  return screen.getByRole('textbox', { name: 'Message' })
}

function sendButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Send' })
}

function type(text: string): void {
  fireEvent.change(messageBox(), { target: { value: text } })
}

function transcript(): HTMLElement {
  return screen.getByRole('list', { name: 'Transcript' })
}

function lines(label: 'You' | 'Agent'): HTMLElement[] {
  return within(transcript()).queryAllByLabelText(label)
}

function reply(): HTMLElement {
  return within(transcript()).getAllByLabelText('Agent')[0]
}

/** Lets everything a click set in motion — the prompt promise — settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

/**
 * A port a test drives by hand: it accepts a prompt only when the test says so,
 * and emits exactly the events the test emits. That is what makes the window
 * between sending a prompt and its acceptance observable, and what lets a test
 * mint a turn id the pane has no business treating specially.
 *
 * It also counts subscriptions, because whether the pane lets go of a port it
 * no longer uses is only observable from the port's side.
 */
function scriptedPort(): {
  port: AgentPort
  prompts: readonly string[]
  subscriptions: { readonly opened: number; readonly closed: number }
  accept: (turnId: TurnId) => Promise<void>
  refuse: (cause: unknown) => Promise<void>
  emit: (event: PortEvent) => void
} {
  const listeners = new Set<PortEventListener>()
  const prompts: string[] = []
  const subscriptions = { opened: 0, closed: 0 }
  let settlePrompt: { accept: (turnId: TurnId) => void; refuse: (cause: unknown) => void } = {
    accept: () => {},
    refuse: () => {}
  }

  return {
    prompts,
    subscriptions,
    port: {
      prompt(text) {
        prompts.push(text)
        return new Promise<TurnId>((resolve, reject) => {
          settlePrompt = { accept: resolve, refuse: reject }
        })
      },
      onEvent(listener) {
        listeners.add(listener)
        subscriptions.opened += 1
        return () => {
          listeners.delete(listener)
          subscriptions.closed += 1
        }
      }
    },
    async accept(turnId) {
      settlePrompt.accept(turnId)
      await settle()
    },
    async refuse(cause) {
      settlePrompt.refuse(cause)
      await settle()
    },
    emit(event) {
      act(() => {
        for (const listener of [...listeners]) listener(event)
      })
    }
  }
}

describe('the chat pane, against the fake adapter', () => {
  it('renders turn_started → every text_delta → turn_ended, send disabled until the end', async () => {
    // The fake's own default cadence, driven one beat at a time by the clock,
    // so every piece of its reply is observed as it is rendered — a fake that
    // collapsed its reply into one delta would fail here.
    vi.useFakeTimers()
    render(<ChatPane port={createFakeAdapter()} />)

    expect(screen.getByRole('heading', { name: 'Crucible' })).toBeInTheDocument()

    type('Hello agent')
    fireEvent.click(sendButton())
    await settle()

    // turn_started: what was sent stands in the transcript, and an empty reply
    // line is open under it.
    expect(screen.getByLabelText('You')).toHaveTextContent('Hello agent')
    expect(reply().textContent).toBe('')
    // A new draft is no way past the guard while the turn is live.
    type('and again')
    expect(sendButton()).toBeDisabled()

    // text_delta*: the reply grows, one piece at a time, and never shows more
    // than what has arrived.
    const growth: string[] = []
    while (reply().textContent !== CANNED_REPLY) {
      expect(growth.length).toBeLessThan(1000)
      const sofar = reply().textContent ?? ''
      await act(async () => {
        await vi.advanceTimersToNextTimerAsync()
      })
      const now = reply().textContent ?? ''
      expect(CANNED_REPLY.startsWith(now)).toBe(true)
      expect(now.length).toBeGreaterThan(sofar.length)
      expect(sendButton()).toBeDisabled()
      growth.push(now)
    }
    // Streamed, not dumped: the person watching saw it arrive in pieces.
    expect(growth.length).toBeGreaterThan(1)

    // turn_ended: the reply stands and send is offered again.
    await act(async () => {
      await vi.advanceTimersToNextTimerAsync()
    })
    expect(reply().textContent).toBe(CANNED_REPLY)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(sendButton()).toBeEnabled()
  })

  it('serves a second turn on the same pane', async () => {
    // Zero pause: the whole script runs on microtasks, so no clock is involved.
    render(<ChatPane port={createFakeAdapter({ deltaPauseMs: 0 })} />)

    for (const prompt of ['Hello agent', 'and again']) {
      type(prompt)
      fireEvent.click(sendButton())
      await settle()
    }

    expect(lines('You').map((line) => line.textContent)).toEqual(['Hello agent', 'and again'])
    expect(lines('Agent').map((line) => line.textContent)).toEqual([CANNED_REPLY, CANNED_REPLY])
    type('once more')
    expect(sendButton()).toBeEnabled()
  })
})

describe('the chat pane, against a port a test drives', () => {
  it('holds the guard from the click until the turn it started ends', async () => {
    const agent = scriptedPort()
    render(<ChatPane port={agent.port} />)

    type('Hello agent')
    fireEvent.click(sendButton())
    expect(agent.prompts).toEqual(['Hello agent'])

    // Sent but not yet accepted: there is no turn id yet, and send is still
    // disabled once there is a new draft to send.
    type('and again')
    expect(sendButton()).toBeDisabled()

    // turn_started may arrive before the prompt promise resolves — the port's
    // own order — and the guard survives both.
    agent.emit({ type: 'turn_started', turnId: 't-1' })
    expect(sendButton()).toBeDisabled()
    await agent.accept('t-1')
    expect(sendButton()).toBeDisabled()

    agent.emit({ type: 'turn_ended', turnId: 't-1' })
    expect(sendButton()).toBeEnabled()
  })

  it('sends the trimmed draft and clears the box the moment it is sent', async () => {
    const agent = scriptedPort()
    render(<ChatPane port={agent.port} />)

    type('   hello   ')
    fireEvent.click(sendButton())

    // Trimmed on the way out and on the way into the transcript, and the box is
    // empty before the port has accepted anything.
    expect(agent.prompts).toEqual(['hello'])
    expect(screen.getByLabelText('You').textContent).toBe('hello')
    expect(messageBox().value).toBe('')

    await agent.accept('t-1')
  })

  it('opens the guard between a prompt accepted and the turn_started that follows it', async () => {
    // Characterization, not endorsement: acceptance is signalled twice — by the
    // prompt promise and by `turn_started` — and between the two the pane holds
    // no live turn at all, so send is offered again for that window.
    const agent = scriptedPort()
    render(<ChatPane port={agent.port} />)

    type('Hello agent')
    fireEvent.click(sendButton())
    await agent.accept('t-1')

    type('and again')
    expect(sendButton()).toBeEnabled()

    agent.emit({ type: 'turn_started', turnId: 't-1' })
    expect(sendButton()).toBeDisabled()
    agent.emit({ type: 'turn_ended', turnId: 't-1' })
    expect(sendButton()).toBeEnabled()
  })

  it('keeps the guard on a turn that ended before the prompt promise settled', async () => {
    // The other side of the same double signal: the turn is over, but the pane
    // is still waiting to hear that it was accepted.
    const agent = scriptedPort()
    render(<ChatPane port={agent.port} />)

    type('Hello agent')
    fireEvent.click(sendButton())
    agent.emit({ type: 'turn_started', turnId: 't-1' })
    agent.emit({ type: 'text_delta', turnId: 't-1', delta: 'all of it' })
    agent.emit({ type: 'turn_ended', turnId: 't-1' })

    type('and again')
    expect(reply().textContent).toBe('all of it')
    expect(sendButton()).toBeDisabled()

    await agent.accept('t-1')
    expect(sendButton()).toBeEnabled()
  })

  it('treats every unique string as a turn id, including its own line labels', async () => {
    // A turn id is the port's to mint and the port reserves none: whatever the
    // pane calls things internally is not part of the interface, so ids that
    // read like bookkeeping must render and hold the guard like any other.
    for (const turnId of ['you-1', 'refused-1', '0', 'Transcript', '', 'Agent']) {
      const agent = scriptedPort()
      render(<ChatPane port={agent.port} />)

      type('Hello agent')
      fireEvent.click(sendButton())
      agent.emit({ type: 'turn_started', turnId })
      await agent.accept(turnId)

      type('and again')
      expect(sendButton()).toBeDisabled()
      agent.emit({ type: 'text_delta', turnId, delta: 'a reply' })
      expect(reply().textContent).toBe('a reply')
      expect(sendButton()).toBeDisabled()

      agent.emit({ type: 'turn_ended', turnId })
      expect(sendButton()).toBeEnabled()
      cleanup()
    }
  })

  it('keeps the deltas a failed turn already produced and writes the error under them', async () => {
    const agent = scriptedPort()
    render(<ChatPane port={agent.port} />)

    type('Hello agent')
    fireEvent.click(sendButton())
    agent.emit({ type: 'turn_started', turnId: 't-1' })
    await agent.accept('t-1')
    agent.emit({ type: 'text_delta', turnId: 't-1', delta: 'half a th' })
    agent.emit({ type: 'error', turnId: 't-1', code: 'adapter', message: 'the model gave up' })

    expect(reply()).toHaveTextContent('half a th')
    // The alert belongs to the turn that failed: it is inside that line, not
    // loose in the pane.
    expect(within(reply()).getByRole('alert').textContent).toBe('the model gave up')
    expect(screen.getAllByRole('alert')).toHaveLength(1)

    type('again')
    expect(sendButton()).toBeEnabled()
  })

  it('shows a busy refusal the same way it shows an adapter failure', async () => {
    // The two codes are the only ones a caller can act on, and the pane acts on
    // neither: the message is what it displays, wherever it came from.
    const agent = scriptedPort()
    render(<ChatPane port={agent.port} />)

    type('Hello agent')
    fireEvent.click(sendButton())
    agent.emit({ type: 'turn_started', turnId: 't-1' })
    await agent.accept('t-1')
    agent.emit({ type: 'error', turnId: 't-1', code: 'busy', message: 'a turn is already live' })

    expect(within(reply()).getByRole('alert').textContent).toBe('a turn is already live')
    expect(reply().textContent).toBe('a turn is already live')
    type('again')
    expect(sendButton()).toBeEnabled()
  })

  it('finishes a turn that carried no text at all, and one that only failed', async () => {
    const agent = scriptedPort()
    render(<ChatPane port={agent.port} />)

    // A turn is allowed to stream nothing: what is left is an empty, finished
    // agent line.
    type('Hello agent')
    fireEvent.click(sendButton())
    agent.emit({ type: 'turn_started', turnId: 't-1' })
    await agent.accept('t-1')
    agent.emit({ type: 'turn_ended', turnId: 't-1' })

    expect(lines('Agent')).toHaveLength(1)
    expect(reply().textContent).toBe('')
    expect(screen.queryByRole('alert')).toBeNull()
    type('and again')
    expect(sendButton()).toBeEnabled()

    // And a turn is allowed to fail before its first delta: the line holds
    // nothing but the alert.
    fireEvent.click(sendButton())
    agent.emit({ type: 'turn_started', turnId: 't-2' })
    await agent.accept('t-2')
    agent.emit({ type: 'error', turnId: 't-2', code: 'adapter', message: 'nothing came back' })

    const failed = lines('Agent')[1]
    expect(failed.textContent).toBe('nothing came back')
    expect(within(failed).getByRole('alert')).toBeInTheDocument()
    type('once more')
    expect(sendButton()).toBeEnabled()
  })

  it('shows a prompt the port never accepted, and releases the guard', async () => {
    const agent = scriptedPort()
    render(<ChatPane port={agent.port} />)

    type('Hello agent')
    fireEvent.click(sendButton())
    await agent.refuse(new Error('the channel is gone'))

    expect(screen.getByRole('alert')).toHaveTextContent('the channel is gone')
    // What was sent stays in the transcript even though nobody took it.
    expect(screen.getByLabelText('You').textContent).toBe('Hello agent')
    // Nothing was minted, so nothing joins the transcript but what was sent.
    expect(lines('Agent')).toEqual([])
    type('again')
    expect(sendButton()).toBeEnabled()
  })

  it('states a refusal that is not an Error as itself, and drops it on the next send', async () => {
    const agent = scriptedPort()
    render(<ChatPane port={agent.port} />)

    type('Hello agent')
    fireEvent.click(sendButton())
    await agent.refuse('the channel is gone')
    expect(screen.getByRole('alert').textContent).toBe('the channel is gone')

    // A refusal that carries no message of its own is shown as whatever it
    // converts to — the pane never guesses at one.
    type('and again')
    fireEvent.click(sendButton())
    await agent.refuse({ code: 'nope' })
    expect(screen.getByRole('alert').textContent).toBe('[object Object]')

    // The next send clears the last refusal; what was already sent stands.
    type('once more')
    fireEvent.click(sendButton())
    expect(screen.queryByRole('alert')).toBeNull()
    expect(lines('You').map((line) => line.textContent)).toEqual([
      'Hello agent',
      'and again',
      'once more'
    ])
    await agent.accept('t-1')
  })

  it('refuses an empty or whitespace-only prompt by leaving send disabled', () => {
    const agent = scriptedPort()
    render(<ChatPane port={agent.port} />)

    expect(sendButton()).toBeDisabled()
    type('   ')
    expect(sendButton()).toBeDisabled()

    fireEvent.submit(messageBox().closest('form') as HTMLFormElement)
    expect(agent.prompts).toEqual([])
  })

  it('drops events for a turn it never saw start, and after that turn closed', async () => {
    const agent = scriptedPort()
    render(<ChatPane port={agent.port} />)

    // Every event for an unknown turn renders nothing at all — terminal ones
    // included.
    agent.emit({ type: 'text_delta', turnId: 'stale', delta: 'from another life' })
    agent.emit({ type: 'turn_ended', turnId: 'stale' })
    agent.emit({ type: 'error', turnId: 'stale', code: 'adapter', message: 'from another life' })
    expect(lines('Agent')).toEqual([])
    expect(screen.queryByRole('alert')).toBeNull()

    type('Hello agent')
    fireEvent.click(sendButton())
    agent.emit({ type: 'turn_started', turnId: 't-1' })
    agent.emit({ type: 'turn_started', turnId: 't-1' }) // a repeat opens nothing new
    await agent.accept('t-1')
    agent.emit({ type: 'text_delta', turnId: 't-1', delta: 'done' })
    agent.emit({ type: 'turn_ended', turnId: 't-1' })

    // The first terminal event closed the turn; later ones are stale — a repeat
    // of its start neither reopens it nor adds a second line.
    agent.emit({ type: 'text_delta', turnId: 't-1', delta: ' and more' })
    agent.emit({ type: 'error', turnId: 't-1', code: 'adapter', message: 'too late' })
    agent.emit({ type: 'turn_started', turnId: 't-1' })
    agent.emit({ type: 'turn_ended', turnId: 't-1' })

    expect(lines('Agent')).toHaveLength(1)
    expect(reply().textContent).toBe('done')
    expect(screen.queryByRole('alert')).toBeNull()
    type('again')
    expect(sendButton()).toBeEnabled()
  })

  it('keeps two live turns apart and holds the guard until both have ended', async () => {
    // This pane will not issue overlapping prompts, but a port it is handed can
    // have turns of its own in flight: each is its own line, matched by id.
    const agent = scriptedPort()
    render(<ChatPane port={agent.port} />)

    type('Hello agent')
    fireEvent.click(sendButton())
    agent.emit({ type: 'turn_started', turnId: 'a' })
    await agent.accept('a')
    agent.emit({ type: 'turn_started', turnId: 'b' })

    agent.emit({ type: 'text_delta', turnId: 'a', delta: 'first ' })
    agent.emit({ type: 'text_delta', turnId: 'b', delta: 'second ' })
    agent.emit({ type: 'text_delta', turnId: 'a', delta: 'turn' })
    agent.emit({ type: 'text_delta', turnId: 'b', delta: 'turn' })

    expect(lines('Agent').map((line) => line.textContent)).toEqual(['first turn', 'second turn'])

    type('and again')
    agent.emit({ type: 'turn_ended', turnId: 'a' })
    expect(sendButton()).toBeDisabled() // b is still live
    agent.emit({ type: 'error', turnId: 'b', code: 'adapter', message: 'b gave up' })
    expect(sendButton()).toBeEnabled()

    expect(lines('Agent').map((line) => line.textContent)).toEqual([
      'first turn',
      'second turnb gave up'
    ])
  })

  it('changes ports when it is handed a new one, keeping the transcript it has', async () => {
    const first = scriptedPort()
    const second = scriptedPort()
    const pane = render(<ChatPane port={first.port} />)

    type('Hello agent')
    fireEvent.click(sendButton())
    first.emit({ type: 'turn_started', turnId: 't-1' })
    await first.accept('t-1')
    first.emit({ type: 'text_delta', turnId: 't-1', delta: 'from the first port' })
    first.emit({ type: 'turn_ended', turnId: 't-1' })
    type('a draft in hand')

    expect(first.subscriptions).toEqual({ opened: 1, closed: 0 })
    pane.rerender(<ChatPane port={second.port} />)
    expect(first.subscriptions).toEqual({ opened: 1, closed: 1 })
    expect(second.subscriptions).toEqual({ opened: 1, closed: 0 })

    // What the old port says now is heard by nobody.
    first.emit({ type: 'turn_started', turnId: 't-2' })
    expect(lines('Agent')).toHaveLength(1)

    // The new port is heard, and the transcript and draft the pane already had
    // are still there.
    second.emit({ type: 'turn_started', turnId: 't-9' })
    second.emit({ type: 'text_delta', turnId: 't-9', delta: 'from the second port' })
    second.emit({ type: 'turn_ended', turnId: 't-9' })

    expect(lines('Agent').map((line) => line.textContent)).toEqual([
      'from the first port',
      'from the second port'
    ])
    expect(lines('You').map((line) => line.textContent)).toEqual(['Hello agent'])
    expect(messageBox().value).toBe('a draft in hand')
  })

  it('is still released by a prompt the port it has left finally answers', async () => {
    // Characterization: swapping ports ends the subscription but not the prompt
    // already in flight, so the guard is released by an answer from a port this
    // pane no longer listens to.
    const first = scriptedPort()
    const second = scriptedPort()
    const pane = render(<ChatPane port={first.port} />)

    type('Hello agent')
    fireEvent.click(sendButton())
    pane.rerender(<ChatPane port={second.port} />)

    type('and again')
    expect(sendButton()).toBeDisabled()

    await first.accept('t-1')
    expect(sendButton()).toBeEnabled()
    expect(second.prompts).toEqual([])
  })

  it('stops listening when it unmounts', () => {
    const agent = scriptedPort()
    const pane = render(<ChatPane port={agent.port} />)
    expect(agent.subscriptions).toEqual({ opened: 1, closed: 0 })

    pane.unmount()

    // The subscription is closed from the port's side — not merely ignored.
    expect(agent.subscriptions).toEqual({ opened: 1, closed: 1 })
    // No listener is left to update a component that is gone: emitting is safe.
    agent.emit({ type: 'turn_started', turnId: 't-1' })
    expect(screen.queryByRole('list', { name: 'Transcript' })).toBeNull()
  })
})
