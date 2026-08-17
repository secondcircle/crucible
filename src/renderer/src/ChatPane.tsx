import { useEffect, useState } from 'react'
import type { AgentPort, PortEvent, TurnId } from '../../shared/agent/port'

/**
 * The chat pane: the walking skeleton of Crucible's surface — a transcript, an
 * input and a send button, unstyled on purpose (styling gets its own align).
 *
 * Its only agent-side dependency is the agent port, handed to it as a prop
 * (D4): not `window.crucible`, not Electron, not the π SDK. That is what lets
 * the same component run in the app over IPC and in jsdom against the fake
 * adapter, with nothing swapped inside it.
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

/** The turn an event belongs to, or -1 if this pane has no such turn. */
function turnIndex(entries: readonly Entry[], turnId: TurnId): number {
  return entries.findIndex((entry) => entry.from === 'agent' && entry.turnId === turnId)
}

/**
 * The whole of what the port's events do to the transcript. Written as a
 * function of the entries so the pane keeps one piece of state and the guard is
 * derived from it: a turn that is not `done` is a live turn.
 *
 * Two rules of D3 and D6 are enforced here rather than trusted from upstream: a
 * turn that has already closed ignores everything after its terminal event, and
 * an event for a turn this pane never saw start is dropped.
 */
function apply(entries: readonly Entry[], event: PortEvent): readonly Entry[] {
  const index = turnIndex(entries, event.turnId)

  if (event.type === 'turn_started') {
    if (index !== -1) return entries
    return [...entries, { from: 'agent', turnId: event.turnId, text: '', done: false }]
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

export function ChatPane({ port }: { port: AgentPort }): React.JSX.Element {
  const [entries, setEntries] = useState<readonly Entry[]>([])
  const [pending, setPending] = useState(false)
  const [refusal, setRefusal] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState('')

  // Subscribe before anything is prompted: events may arrive before the prompt
  // promise resolves, and subscription is live-only — there is no backlog to
  // catch up on.
  useEffect(() => port.onEvent((event) => setEntries((current) => apply(current, event))), [port])

  // A turn is live from the moment a prompt is sent — a prompt not yet accepted
  // has no turn id and so no entry of its own — until its terminal event.
  const live = pending || entries.some((entry) => entry.from === 'agent' && !entry.done)
  const text = draft.trim()

  function send(): void {
    if (live || text === '') return
    setEntries((current) => [...current, { from: 'you', text }])
    setDraft('')
    setRefusal(undefined)
    setPending(true)
    void accept(port.prompt(text))
  }

  /**
   * A prompt is answered with a turn id, and a failed turn is reported as that
   * turn's terminal error — so a rejected `prompt` is the port failing to accept
   * at all. It belongs to no turn, which is why it is shown beneath the
   * transcript rather than in it, and why it releases the guard.
   */
  async function accept(prompted: Promise<TurnId>): Promise<void> {
    try {
      await prompted
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <main>
      <h1>Crucible</h1>
      <ol aria-label="Transcript">
        {entries.map((entry, position) => (
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
      {refusal === undefined ? null : <p role="alert">{refusal}</p>}
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
