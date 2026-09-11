import { useEffect, useRef, useState } from 'react'
import type { QuestionId, QuestionLine, QuestionReply } from '../../../shared/agent/port'
import { keyLabel } from '../keys'
import { briefAge } from '../labels'
import './questions-dock.css'

// The questions dock: pinned between the transcript and the composer, exactly
// as wide as the composer's box, showing one question at a time and whole. It
// is a view over the line and nothing more — which questions are open, and
// what becomes of the user's word on one, are the port's.

/** What the empty Send says, because a click that does nothing must say so. */
const NOTHING_TO_SEND = 'Nothing to send yet — write an answer, or take the recommendation.'

/** What the header says while answers wait for the rest of the line. */
function heldSaid(held: number): string {
  return `${held} ${held === 1 ? 'answer' : 'answers'} held · sent together when the line is empty`
}

export function QuestionsDock({
  line,
  now,
  boxRef,
  onReply
}: {
  /** Never empty: an absent line renders no dock at all. */
  readonly line: QuestionLine
  readonly now: number
  // The answer box, held by the shell so the chord that focuses it can be
  // guarded beside every other chord.
  readonly boxRef: React.RefObject<HTMLTextAreaElement | null>
  readonly onReply: (questionId: QuestionId, reply: QuestionReply) => void
}): React.JSX.Element {
  // Keyed by question, so a session switch and an answer to the question
  // ahead of this one both leave the words where they were typed.
  const [drafts, setDrafts] = useState<Readonly<Record<QuestionId, string>>>({})
  const [emptyFor, setEmptyFor] = useState<QuestionId | undefined>(undefined)
  const showing = useRef<QuestionId | undefined>(undefined)

  const question = line.open[0]
  const next = line.open[1]
  const behind = Math.max(0, line.open.length - 2)
  const draft = drafts[question.id] ?? ''

  // The next question arrives with its box focused. Only the next one: the
  // first must not take the caret out of the composer mid-sentence, and ⌘⇧A
  // is how the user asks for it.
  useEffect(() => {
    const before = showing.current
    showing.current = question.id
    if (before === undefined || before === question.id) return
    boxRef.current?.focus()
  }, [question.id, boxRef])

  function reply(questionId: QuestionId, said: QuestionReply): void {
    setDrafts((held) => {
      const rest = { ...held }
      delete rest[questionId]
      return rest
    })
    setEmptyFor(undefined)
    onReply(questionId, said)
  }

  function send(): void {
    const text = draft.trim()
    if (text === '') {
      setEmptyFor(question.id)
      return
    }
    reply(question.id, { kind: 'answered', text })
  }

  return (
    <div className="dockband">
      <div className="dock" aria-label="Question for you">
        <div className="dockhead">
          Question for you
          <span className="cnt">
            {line.held + 1} of {line.held + line.open.length}
          </span>
          {/* What the rest of the line is waiting on, or how to reach the box
              when the caret is in the composer. */}
          <span className={`hint${line.held > 0 ? ' holding' : ''}`}>
            {line.held > 0 ? heldSaid(line.held) : `${keyLabel('⌘⇧A')} focus the answer`}
          </span>
        </div>

        <div className="qcard">
          <div className="qhead">
            <div className="question">{question.question}</div>
            <span className="qage">{briefAge(question.askedAt, now)}</span>
            <button
              className="qx"
              title="Dismiss without answering"
              aria-label="Dismiss without answering"
              onClick={() => reply(question.id, { kind: 'dismissed' })}
            >
              ✕
            </button>
          </div>
          <div className="qctx">{question.context}</div>
          <div className="qrec">
            <span className="lbl">Recommend</span>
            {question.recommendation}
          </div>
          <div className="qanswer">
            <textarea
              ref={boxRef}
              aria-label="Your answer"
              placeholder="Your answer… (Enter sends, Shift-Enter for a new line)"
              value={draft}
              onChange={(typed) => {
                setEmptyFor(undefined)
                setDrafts((held) => ({ ...held, [question.id]: typed.target.value }))
              }}
              onKeyDown={(pressed) => {
                if (pressed.key !== 'Enter' || pressed.shiftKey) return
                pressed.preventDefault()
                send()
              }}
            />
            <span className="qbtns">
              <button
                className="qsend ghost"
                onClick={() => reply(question.id, { kind: 'recommendation' })}
              >
                Take recommendation
              </button>
              <button className="qsend" onClick={send}>
                Send
              </button>
            </span>
          </div>
          {emptyFor === question.id ? (
            <p className="qsay" role="status">
              {NOTHING_TO_SEND}
            </p>
          ) : null}
        </div>

        {next === undefined ? null : (
          <div className="upnext">
            <span className="lbl">Up next</span>
            <span className="t">
              {next.question}
              {behind === 0 ? '' : ` · then ${behind} more`}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
