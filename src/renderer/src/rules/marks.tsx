import { createContext, useContext } from 'react'
import { formatTook, type FiringView } from '../../../shared/rules/board'
import { didTone, markText } from './format'
import '../components/rules.css'

// What a transcript shows of the rules: a mark on each tool call a rule
// judged, the note read inline under it, and a note steered in afterwards as
// its own message after the chain it was about. All of it comes from the
// ledger by tool call id, so a transcript read back later shows what a live
// one did.

export interface RuleMarks {
  /** Every firing on each tool call, oldest first. */
  readonly byCall: ReadonlyMap<string, readonly FiringView[]>
  /** A mark was clicked: the board opens on that firing. */
  readonly onOpen: (firingId: string) => void
  // The call "Open in the conversation" asked for: its chain opens and it
  // scrolls into view. `asked` makes a second ask of the same call move too.
  readonly focus?: { readonly callId: string; readonly asked: number }
}

export const RuleMarksContext = createContext<RuleMarks | undefined>(undefined)

export function useRuleMarks(): RuleMarks | undefined {
  return useContext(RuleMarksContext)
}

/** Newest-first firings, filed by the tool call each judged. */
export function marksByCall(firings: readonly FiringView[]): Map<string, FiringView[]> {
  const byCall = new Map<string, FiringView[]>()
  for (const view of [...firings].reverse()) {
    const callId = view.firing.toolCallId
    if (callId === undefined) continue
    byCall.set(callId, [...(byCall.get(callId) ?? []), view])
  }
  return byCall
}

export function RuleMark({
  view,
  onOpen
}: {
  readonly view: FiringView
  readonly onOpen: (firingId: string) => void
}): React.JSX.Element {
  const { firing } = view
  return (
    <button
      type="button"
      className={`rulemark ${didTone(firing)}`}
      title={firing.mode === 'shadow' ? 'Shadow: judged, nothing delivered' : 'Open this firing on the rules board'}
      onClick={() => onOpen(firing.id)}
    >
      {markText(firing)}
    </button>
  )
}

/** A note appended to the tool result, as the agent read it there. */
export function InlineNote({ view }: { readonly view: FiringView }): React.JSX.Element {
  return (
    <span className="rulenote">
      <b>§ {view.firing.rule}</b> {view.firing.feedback}
    </span>
  )
}

/** A note that missed its tool result and reached the agent at the next boundary. */
export function SteeredNote({
  view,
  onOpen
}: {
  readonly view: FiringView
  readonly onOpen: (firingId: string) => void
}): React.JSX.Element {
  const { firing } = view
  return (
    <div className="steer" aria-label={`Rule note from ${firing.rule}`}>
      <button type="button" className="box" onClick={() => onOpen(firing.id)}>
        <span className="who">
          <span>
            § {firing.rule} · steered · {formatTook(firing.tookMs)}
          </span>
          <span className="r">rule note, delivered at the next tool boundary</span>
        </span>
        {firing.feedback}
      </button>
    </div>
  )
}
