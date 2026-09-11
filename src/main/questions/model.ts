import {
  askRequestFrom,
  type AskRequest,
  type AskTools
} from '../../shared/agent/ask-tool.ts'
import type {
  Question,
  QuestionId,
  QuestionLine,
  QuestionReply,
  SessionId,
  SystemMessage,
  Unsubscribe
} from '../../shared/agent/port.ts'
import {
  askAnswer,
  composeAnswerBatch,
  type AnsweredQuestion
} from '../../shared/questions/wording.ts'

// Both adapters delegate here, so a question raised behind the fake and one
// raised behind the SDK are the same thing. The line is the whole rule:
// questions queue in the order they were asked, replies are held beside them,
// and only a reply that empties the line produces the answer batch — which
// this model composes and its caller delivers, because the road a message
// takes to an agent is the shell's business and not this model's.

export interface QuestionChange {
  readonly sessionId: SessionId
  /** Present when the change was an ask: the question that opened. */
  readonly askedId?: QuestionId
}

export type QuestionChangeListener = (change: QuestionChange) => void

export interface QuestionsModel extends AskTools {
  /** What crosses the port. Absent when the session has nothing open. */
  line(sessionId: SessionId): QuestionLine | undefined
  // The user's answer, Take recommendation or ✕. Answers with the batch when
  // this reply emptied the line, and with nothing while questions remain —
  // which is the whole of "nothing reaches the agent before the line empties".
  // An id that names no open question of this session changes nothing.
  reply(
    sessionId: SessionId,
    questionId: QuestionId,
    reply: QuestionReply
  ): SystemMessage | undefined
  // The session's conversation is gone — removed, reset, its workspace closed.
  // The line goes with it and no batch is ever composed from it.
  forget(sessionId: SessionId): void
  onChange(listener: QuestionChangeListener): Unsubscribe
}

interface Line {
  readonly open: Question[]
  readonly answered: AnsweredQuestion[]
}

export function createQuestionsModel({
  now = () => new Date(),
  mintId
}: {
  /** The clock, so a test can pin what `askedAt` says. */
  readonly now?: () => Date
  readonly mintId?: () => QuestionId
} = {}): QuestionsModel {
  const lines = new Map<SessionId, Line>()
  const listeners = new Set<QuestionChangeListener>()
  let minted = 0

  function notify(change: QuestionChange): void {
    // A copy, so a listener that unsubscribes while being called does not
    // disturb the delivery of that same change to the others.
    for (const listener of [...listeners]) listener(change)
  }

  function lineOf(sessionId: SessionId): Line {
    const already = lines.get(sessionId)
    if (already !== undefined) return already
    const fresh: Line = { open: [], answered: [] }
    lines.set(sessionId, fresh)
    return fresh
  }

  function mint(): QuestionId {
    if (mintId !== undefined) return mintId()
    minted += 1
    return `q-${minted}`
  }

  return {
    ask(sessionId: SessionId, request: AskRequest): string {
      const asked = askRequestFrom(request)
      const line = lineOf(sessionId)
      const question: Question = {
        id: mint(),
        question: asked.question,
        context: asked.context,
        recommendation: asked.recommendation,
        askedAt: now().toISOString()
      }
      line.open.push(question)
      notify({ sessionId, askedId: question.id })
      return askAnswer(asked, line.open.length)
    },

    line(sessionId: SessionId): QuestionLine | undefined {
      const line = lines.get(sessionId)
      if (line === undefined || line.open.length === 0) return undefined
      return { open: [...line.open], held: line.answered.length }
    },

    reply(
      sessionId: SessionId,
      questionId: QuestionId,
      reply: QuestionReply
    ): SystemMessage | undefined {
      const line = lines.get(sessionId)
      if (line === undefined) return undefined
      const at = line.open.findIndex((question) => question.id === questionId)
      // The agent cannot withdraw a question and the user answers each one
      // once, so an unknown id is a click that lost a race — a reset, or a
      // second click on the card already leaving.
      if (at === -1) return undefined
      const [question] = line.open.splice(at, 1)
      line.answered.push({ question, reply })
      if (line.open.length > 0) {
        notify({ sessionId })
        return undefined
      }
      // Forgotten before anyone is told, so a listener reading the line back
      // sees the dock gone rather than an empty one with answers held in it.
      const batch = composeAnswerBatch(line.answered)
      lines.delete(sessionId)
      notify({ sessionId })
      return batch
    },

    forget(sessionId: SessionId): void {
      if (!lines.has(sessionId)) return
      lines.delete(sessionId)
      notify({ sessionId })
    },

    onChange(listener: QuestionChangeListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
