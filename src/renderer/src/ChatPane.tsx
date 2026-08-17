import { useEffect, useReducer, useState } from 'react'
import type { AgentPort, PortEvent, TurnId } from '../../shared/agent/port'

/**
 * The chat pane: the walking skeleton of Crucible's surface — a transcript, an
 * input and a send button, unstyled on purpose (styling gets its own align).
 *
 * Its only agent-side dependency is the agent port, handed to it as a prop
 * (D4): not `window.crucible`, not Electron, not the π SDK. That is what lets
 * the same component run in the app over IPC and in jsdom against the fake
 * adapter, with nothing swapped inside it. One prop is the whole of what a
 * caller must supply, and what it renders is the whole of what a caller — or a
 * test — may read back.
 *
 * What it promises: deltas appear as they arrive; a turn's terminal event
 * finishes the message or writes an error line under whatever text had already
 * arrived; and send is disabled while a turn is live (D6) — the pane is not the
 * ordering authority, but it is what stops a person from racing it.
 *
 * Empty and whitespace-only prompts are refused here, by keeping send disabled.
 * No Decision admits or refuses them, so this is the one place that rule lives.
 */

/**
 * One line of the transcript.
 *
 * A turn id is a port's to mint and any unique string is a valid one, so it
 * names exactly one kind of entry here and nothing else the pane keeps: what a
 * person sent has no id at all, and a prompt the port never accepted is not an
 * entry. That is the whole of the pane's correlation rule — an entry answers to
 * an event only if it is a turn, and only if that turn's id matches — and it is
 * why no string a port mints can shadow the pane's own bookkeeping.
 */
type Entry =
  | { readonly from: 'you'; readonly text: string }
  | {
      readonly from: 'agent'
      readonly turnId: TurnId
      readonly text: string
      /** Present once a turn ended in an error; the text above it still stands. */
      readonly error?: string
      /** A live turn is the only entry that is not done (D6). */
      readonly done: boolean
    }

/**
 * Everything a turn does to this pane, in one value: what stands in the
 * transcript, whether a prompt is waiting to be answered, and a refusal that
 * belongs to no turn. Keeping them together is what makes the guard a property
 * of one thing — a prompt not yet answered, or a turn not yet done — rather
 * than an agreement between separate pieces of state.
 */
interface Conversation {
  readonly entries: readonly Entry[]
  /** A prompt sent that the port has neither accepted nor refused yet. */
  readonly pending: boolean
  /** The port's last outright refusal, until the next send clears it. */
  readonly refusal?: string
}

const NOTHING_SAID: Conversation = { entries: [], pending: false }

/**
 * Everything that can move a conversation, and all that can. A refusal arrives
 * here as the text to show and never as the thing that was thrown: converting a
 * caller's value is the caller's code running, and nothing a reducer does may
 * be observable — React replays reducers under `StrictMode`, which is how the
 * app mounts this pane.
 */
type Change =
  | { readonly type: 'sent'; readonly text: string }
  | { readonly type: 'heard'; readonly event: PortEvent }
  | { readonly type: 'refused'; readonly refusal: string }
  | { readonly type: 'answered' }

/**
 * The whole of what the port's events do to the transcript.
 *
 * Two rules of D3 and D6 are enforced here rather than trusted from upstream: a
 * turn that has already closed ignores everything after its terminal event, and
 * an event for a turn this pane never saw start is dropped. Both are answered
 * by returning the entries unchanged, which is also how the pane avoids a
 * render for an event that changed nothing.
 */
function heard(entries: readonly Entry[], event: PortEvent): readonly Entry[] {
  const { turnId } = event
  const index = entries.findIndex((entry) => entry.from === 'agent' && entry.turnId === turnId)

  if (event.type === 'turn_started') {
    if (index !== -1) return entries
    return [...entries, { from: 'agent', turnId, text: '', done: false }]
  }
  if (index === -1) return entries

  const turn = entries[index]
  if (turn.from !== 'agent' || turn.done) return entries

  if (event.type === 'text_delta') {
    return entries.with(index, { ...turn, text: turn.text + event.delta })
  }
  if (event.type === 'turn_ended') {
    return entries.with(index, { ...turn, done: true })
  }
  return entries.with(index, { ...turn, done: true, error: event.message })
}

/**
 * The pane's turn rules, in one pure function: what a send, an answer to it and
 * an event from the port each make of the conversation so far. Private to this
 * module — the pane's interface is what it renders, and every one of these
 * rules is observable there.
 *
 * Pure means running it twice must be worth nothing, because `StrictMode`
 * replays it: every value it is handed is already computed, and it moves values
 * about rather than converting or formatting anything a port supplied.
 *
 * A prompt is answered with a turn id, and a failed turn is reported as that
 * turn's terminal error — so a rejected `prompt` is the port failing to accept
 * at all. It belongs to no turn, which is why it is kept apart from the entries
 * and shown beneath them, and why it leaves nothing live behind.
 */
function next(conversation: Conversation, change: Change): Conversation {
  switch (change.type) {
    case 'sent':
      // A new send drops the last refusal and puts what was sent in the
      // transcript at once; the turn it starts has no id to render under yet.
      return {
        entries: [...conversation.entries, { from: 'you', text: change.text }],
        pending: true
      }
    case 'refused':
      return { ...conversation, refusal: change.refusal }
    // Accepted, refused, or refused with something that could not even be
    // converted: either way the prompt has been answered and the guard falls.
    case 'answered':
      return conversation.pending ? { ...conversation, pending: false } : conversation
    case 'heard': {
      const entries = heard(conversation.entries, change.event)
      return entries === conversation.entries ? conversation : { ...conversation, entries }
    }
  }
}

export function ChatPane({ port }: { port: AgentPort }): React.JSX.Element {
  const [conversation, change] = useReducer(next, NOTHING_SAID)
  const [draft, setDraft] = useState('')

  // Subscribe before anything is prompted: events may arrive before the prompt
  // promise resolves, and subscription is live-only — there is no backlog to
  // catch up on.
  useEffect(() => port.onEvent((event) => change({ type: 'heard', event })), [port])

  // A turn is live from the moment a prompt is sent — a prompt not yet accepted
  // has no turn id and so no entry of its own — until its terminal event.
  const live =
    conversation.pending ||
    conversation.entries.some((entry) => entry.from === 'agent' && !entry.done)
  const text = draft.trim()

  function send(): void {
    if (live || text === '') return
    change({ type: 'sent', text })
    setDraft('')
    void answer(port.prompt(text))
  }

  async function answer(prompted: Promise<TurnId>): Promise<void> {
    try {
      await prompted
    } catch (cause) {
      // Converted here, once, before the conversation hears of it: a refusal
      // that is not an `Error` is shown as whatever it converts to, and that
      // conversion is the port's code, which may run only when it is caught.
      change({
        type: 'refused',
        refusal: cause instanceof Error ? cause.message : String(cause)
      })
    } finally {
      // Unconditionally: a port whose refusal cannot even be converted to a
      // string still answered the prompt, and must not leave send disabled for
      // good.
      change({ type: 'answered' })
    }
  }

  return (
    <main>
      <h1>Crucible</h1>
      <ol aria-label="Transcript">
        {conversation.entries.map((entry, position) => (
          // The transcript is append-only and never reordered, so an entry's
          // position is a stable key — and unlike an id, it cannot be minted by
          // a port.
          <li key={position} aria-label={entry.from === 'you' ? 'You' : 'Agent'}>
            <span>{entry.text}</span>
            {entry.from === 'agent' && entry.error !== undefined ? (
              <strong role="alert">{entry.error}</strong>
            ) : null}
          </li>
        ))}
      </ol>
      {conversation.refusal === undefined ? null : <p role="alert">{conversation.refusal}</p>}
      <form
        onSubmit={(submitted) => {
          submitted.preventDefault()
          send()
        }}
      >
        <label htmlFor="message">Message</label>
        <input
          id="message"
          name="message"
          autoComplete="off"
          value={draft}
          onChange={(changed) => setDraft(changed.target.value)}
        />
        <button type="submit" disabled={live || text === ''}>
          Send
        </button>
      </form>
    </main>
  )
}
