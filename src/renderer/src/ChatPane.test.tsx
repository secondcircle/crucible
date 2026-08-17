// The chat pane is mounted the way the app mounts it — with an agent port
// handed in as a prop (D4) — and asserted on through what it renders. Nothing
// here touches `window.crucible`, Electron or the π SDK.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FAKE_DELTA_PAUSE_MS,
  FAKE_REPLY,
  FAKE_REPLY_DELTAS,
  createFakeAdapter
} from '../../shared/agent/fake-adapter'
import type { AgentPort, PortEvent, PortEventListener, TurnId } from '../../shared/agent/port'
import { ChatPane } from './ChatPane'

// Vitest runs without globals, so Testing Library's own auto-cleanup never
// registers: each test unmounts what it rendered here instead.
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function messageBox(): HTMLElement {
  return screen.getByRole('textbox', { name: 'Message' })
}

function sendButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Send' })
}

function type(text: string): void {
  fireEvent.change(messageBox(), { target: { value: text } })
}

function reply(): HTMLElement {
  return within(screen.getByRole('list', { name: 'Transcript' })).getAllByLabelText('Agent')[0]
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
 */
function scriptedPort(): {
  port: AgentPort
  prompts: readonly string[]
  accept: (turnId: TurnId) => Promise<void>
  refuse: (cause: Error) => Promise<void>
  emit: (event: PortEvent) => void
} {
  const listeners = new Set<PortEventListener>()
  const prompts: string[] = []
  let settlePrompt: { accept: (turnId: TurnId) => void; refuse: (cause: Error) => void } = {
    accept: () => {},
    refuse: () => {}
  }

  return {
    prompts,
    port: {
      prompt(text) {
        prompts.push(text)
        return new Promise<TurnId>((resolve, reject) => {
          settlePrompt = { accept: resolve, refuse: reject }
        })
      },
      onEvent(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
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
    // The fake's own cadence, driven by the clock, so every beat of its script
    // is observed as it is rendered — a fake that collapsed its reply into one
    // delta would fail here.
    vi.useFakeTimers()
    render(<ChatPane port={createFakeAdapter()} />)

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

    // text_delta*: one per beat, and never more than what has arrived.
    let sofar = ''
    for (const delta of FAKE_REPLY_DELTAS) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FAKE_DELTA_PAUSE_MS)
      })
      sofar += delta
      expect(reply().textContent).toBe(sofar)
      expect(sendButton()).toBeDisabled()
    }
    expect(sofar).toBe(FAKE_REPLY)

    // turn_ended: the reply stands and send is offered again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FAKE_DELTA_PAUSE_MS)
    })
    expect(reply().textContent).toBe(FAKE_REPLY)
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

    const replies = within(screen.getByRole('list', { name: 'Transcript' })).getAllByLabelText(
      'Agent'
    )
    expect(replies.map((line) => line.textContent)).toEqual([FAKE_REPLY, FAKE_REPLY])
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
    expect(screen.getByRole('alert')).toHaveTextContent('the model gave up')

    type('again')
    expect(sendButton()).toBeEnabled()
  })

  it('shows a prompt the port never accepted, and releases the guard', async () => {
    const agent = scriptedPort()
    render(<ChatPane port={agent.port} />)

    type('Hello agent')
    fireEvent.click(sendButton())
    await agent.refuse(new Error('the channel is gone'))

    expect(screen.getByRole('alert')).toHaveTextContent('the channel is gone')
    // Nothing was minted, so nothing joins the transcript but what was sent.
    expect(screen.queryByLabelText('Agent')).toBeNull()
    type('again')
    expect(sendButton()).toBeEnabled()
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

    // An event for an unknown turn renders nothing at all.
    agent.emit({ type: 'text_delta', turnId: 'stale', delta: 'from another life' })
    expect(screen.queryByLabelText('Agent')).toBeNull()

    type('Hello agent')
    fireEvent.click(sendButton())
    agent.emit({ type: 'turn_started', turnId: 't-1' })
    agent.emit({ type: 'turn_started', turnId: 't-1' }) // a repeat opens nothing new
    await agent.accept('t-1')
    agent.emit({ type: 'text_delta', turnId: 't-1', delta: 'done' })
    agent.emit({ type: 'turn_ended', turnId: 't-1' })

    // The first terminal event closed the turn; later ones are stale.
    agent.emit({ type: 'text_delta', turnId: 't-1', delta: ' and more' })
    agent.emit({ type: 'error', turnId: 't-1', code: 'adapter', message: 'too late' })

    expect(
      within(screen.getByRole('list', { name: 'Transcript' })).getAllByLabelText('Agent')
    ).toHaveLength(1)
    expect(reply().textContent).toBe('done')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('stops listening when it unmounts', () => {
    const agent = scriptedPort()
    const pane = render(<ChatPane port={agent.port} />)

    pane.unmount()
    // No listener is left to update a component that is gone: emitting is safe.
    agent.emit({ type: 'turn_started', turnId: 't-1' })
    expect(screen.queryByRole('list', { name: 'Transcript' })).toBeNull()
  })
})
