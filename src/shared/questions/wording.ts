import type { Question, QuestionReply, SystemCard, SystemMessage } from '../agent/port.ts'
// Spelled with its extension so plain Node can load this module for
// `prove:sdk`: its ESM resolver does no extension guessing.
import { ASK_TOOL, type AskRequest } from '../agent/ask-tool.ts'

// Everything a question says to the agent, in one place: the answer the ask
// tool gives back at once, and the answer batch the line hands over when it
// empties. The fake adapter recognizes a batch by the same prefix main writes,
// so no flavor has to guess at what one looks like.

export const ANSWER_BATCH_PREFIX = '❓ Crucible — answers from the user'

export function isAnswerBatch(text: string): boolean {
  return text.startsWith(ANSWER_BATCH_PREFIX)
}

/** What the ask tool answers with, the instant the question is posted. */
export function askAnswer(request: AskRequest, open: number): string {
  return [
    `Asked: ${request.question}`,
    'It is in the user’s questions dock now. No answer comes back through this tool.',
    open === 1
      ? 'Their answer will reach you as a message of its own.'
      : `${open} of your questions are open; the answers arrive together, in one message, ` +
        'once the user has answered or dismissed every one of them.',
    'Carry on with work that does not depend on it, or end your turn and wait. Do not poll ' +
      `and do not ask again — another ${ASK_TOOL} call is another question in their line.`
  ].join('\n')
}

/** One question with the user's word on it, which is what a batch is made of. */
export interface AnsweredQuestion {
  readonly question: Question
  readonly reply: QuestionReply
}

// The whole line in one message: the ruling is that nothing reaches the agent
// until every question is settled, so this is the only shape an answer ever
// arrives in.
export function composeAnswerBatch(answered: readonly AnsweredQuestion[]): SystemMessage {
  const lines = answered.flatMap(({ question, reply }, index) => [
    `${index + 1}. ${question.question}`,
    ...replyLines(question, reply),
    ''
  ])

  return {
    text: [
      `${ANSWER_BATCH_PREFIX}. Every question you had open, answered or dismissed; nothing ` +
        'further is coming for these.',
      '',
      ...lines,
      'Act on them now, and say what you are doing differently because of them.'
    ].join('\n'),
    card: cardFor(answered)
  }
}

function replyLines(question: Question, reply: QuestionReply): readonly string[] {
  if (reply.kind === 'dismissed') {
    return [
      '   Dismissed with no answer. Decide this one on your own judgment and say what you ' +
        'decided.'
    ]
  }
  if (reply.kind === 'recommendation') {
    return [`   Answer (your own recommendation, taken as it stood): ${question.recommendation}`]
  }
  return [`   Answer: ${reply.text}`]
}

// Amber, like the dock the answers came from, and one row however many
// questions it carries: what the user sees at the point in the turn the agent
// received them.
function cardFor(answered: readonly AnsweredQuestion[]): SystemCard {
  const dismissed = answered.filter((one) => one.reply.kind === 'dismissed').length
  const only = answered.length === 1 ? answered[0] : undefined

  if (only !== undefined) {
    return {
      badge: 'answers',
      tone: 'warn',
      title: only.question.question,
      meta: metaFor(only.reply),
      ...(only.reply.kind === 'dismissed' ? {} : { body: answerText(only) })
    }
  }

  return {
    badge: 'answers',
    tone: 'warn',
    title: `${answered.length} answers`,
    meta: dismissed === 0 ? 'sent together' : `${dismissed} dismissed`,
    body: answered
      .map((one) =>
        one.reply.kind === 'dismissed'
          ? `${one.question.question} — dismissed`
          : `${one.question.question} — ${answerText(one)}`
      )
      .join('\n')
  }
}

function metaFor(reply: QuestionReply): string {
  if (reply.kind === 'dismissed') return 'dismissed'
  return reply.kind === 'recommendation' ? 'took the recommendation' : 'answered'
}

function answerText({ question, reply }: AnsweredQuestion): string {
  if (reply.kind === 'dismissed') return ''
  const text = reply.kind === 'recommendation' ? question.recommendation : reply.text
  return reply.kind === 'recommendation' ? `${text} (took the recommendation)` : text
}
