// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { AskRequest } from '../../shared/agent/ask-tool'
import type { QuestionChange } from './model'
import { createQuestionsModel, type QuestionsModel } from './model'

const FIRST: AskRequest = {
  question: 'Where should the OpenAI API key come from?',
  context: 'OpenAI has no OAuth sign-in, and Crucible stores no provider secret today.',
  recommendation: 'Read OPENAI_ADMIN_KEY from the environment for now.'
}

const SECOND: AskRequest = {
  question: 'Should the merge gate block on a missing changelog entry?',
  context: 'CONTRIBUTING asks for a changelog line; nothing enforces it.',
  recommendation: 'Block. A gate that reports but never blocks teaches nobody.'
}

function model(): { questions: QuestionsModel; changes: QuestionChange[] } {
  const questions = createQuestionsModel({ now: () => new Date('2026-09-10T10:00:00.000Z') })
  const changes: QuestionChange[] = []
  questions.onChange((change) => changes.push(change))
  return { questions, changes }
}

const ids = (questions: QuestionsModel, sessionId = 's1'): string[] =>
  (questions.line(sessionId)?.open ?? []).map((question) => question.id)

describe('asking', () => {
  it('opens the question at once and says so, without an answer', () => {
    const { questions } = model()
    const said = questions.ask('s1', FIRST)

    expect(said).toContain(FIRST.question)
    expect(questions.line('s1')?.open).toHaveLength(1)
    expect(questions.line('s1')?.open[0]).toMatchObject({
      question: FIRST.question,
      context: FIRST.context,
      recommendation: FIRST.recommendation,
      askedAt: '2026-09-10T10:00:00.000Z'
    })
  })

  it('refuses a question missing a part, and opens nothing', () => {
    const { questions } = model()
    expect(() => questions.ask('s1', { ...FIRST, context: ' ' })).toThrow(/context/)
    expect(questions.line('s1')).toBeUndefined()
  })

  it('queues several in the order they were asked, each with its own id', () => {
    const { questions } = model()
    questions.ask('s1', FIRST)
    questions.ask('s1', SECOND)

    const open = questions.line('s1')?.open ?? []
    expect(open.map((one) => one.question)).toEqual([FIRST.question, SECOND.question])
    expect(new Set(open.map((one) => one.id)).size).toBe(2)
  })

  it('is a line per session: one session\u2019s questions are never another\u2019s', () => {
    const { questions } = model()
    questions.ask('s1', FIRST)
    questions.ask('s2', SECOND)

    expect(questions.line('s1')?.open).toHaveLength(1)
    expect(questions.line('s2')?.open[0].question).toBe(SECOND.question)
  })

  it('announces the question it opened, by id', () => {
    const { questions, changes } = model()
    questions.ask('s1', FIRST)
    expect(changes).toEqual([{ sessionId: 's1', askedId: ids(questions)[0] }])
  })

  it('has no line at all for a session that was never asked anything', () => {
    const { questions } = model()
    expect(questions.line('s1')).toBeUndefined()
  })
})

describe('what reaches the agent, and when', () => {
  it('holds an answer while another question is open, and sends nothing', () => {
    const { questions } = model()
    questions.ask('s1', FIRST)
    questions.ask('s1', SECOND)
    const [first] = ids(questions)

    expect(questions.reply('s1', first, { kind: 'answered', text: 'the env var' })).toBeUndefined()
    expect(questions.line('s1')).toMatchObject({ held: 1 })
    expect(questions.line('s1')?.open).toHaveLength(1)
  })

  it('sends one batch with every question when the last one is answered', () => {
    const { questions } = model()
    questions.ask('s1', FIRST)
    questions.ask('s1', SECOND)
    const [first, second] = ids(questions)

    questions.reply('s1', first, { kind: 'recommendation' })
    const batch = questions.reply('s1', second, { kind: 'answered', text: 'Block it.' })

    expect(batch?.text).toContain(FIRST.question)
    expect(batch?.text).toContain(FIRST.recommendation)
    expect(batch?.text).toContain(SECOND.question)
    expect(batch?.text).toContain('Block it.')
    expect(batch?.card?.title).toBe('2 answers')
  })

  it('counts a dismissal as settled, and tells the agent it was dismissed', () => {
    const { questions } = model()
    questions.ask('s1', FIRST)
    const batch = questions.reply('s1', ids(questions)[0], { kind: 'dismissed' })

    expect(batch?.text).toMatch(/Dismissed with no answer/)
    expect(questions.line('s1')).toBeUndefined()
  })

  it('waits for a question the agent added while the line was still open', () => {
    const { questions } = model()
    questions.ask('s1', FIRST)
    questions.ask('s1', SECOND)
    questions.reply('s1', ids(questions)[0], { kind: 'answered', text: 'the env var' })

    const third = { ...FIRST, question: 'Drop the --legacy flag?' }
    questions.ask('s1', third)
    expect(questions.line('s1')).toMatchObject({ held: 1 })

    const [second, added] = ids(questions)
    expect(questions.reply('s1', second, { kind: 'recommendation' })).toBeUndefined()
    const batch = questions.reply('s1', added, { kind: 'dismissed' })
    expect(batch?.text).toContain(FIRST.question)
    expect(batch?.text).toContain(SECOND.question)
    expect(batch?.text).toContain(third.question)
  })

  it('starts a fresh line after a batch: the answered questions are spent', () => {
    const { questions } = model()
    questions.ask('s1', FIRST)
    questions.reply('s1', ids(questions)[0], { kind: 'answered', text: 'the env var' })

    questions.ask('s1', SECOND)
    const batch = questions.reply('s1', ids(questions)[0], { kind: 'dismissed' })
    expect(batch?.text).not.toContain(FIRST.question)
    expect(batch?.card?.title).toBe(SECOND.question)
  })

  it('announces the line changing, with no question named', () => {
    const { questions, changes } = model()
    questions.ask('s1', FIRST)
    changes.length = 0
    questions.reply('s1', ids(questions)[0], { kind: 'dismissed' })
    expect(changes).toEqual([{ sessionId: 's1' }])
  })

  it('does nothing at all for an id that names no open question', () => {
    const { questions, changes } = model()
    questions.ask('s1', FIRST)
    changes.length = 0

    expect(questions.reply('s1', 'q-nope', { kind: 'dismissed' })).toBeUndefined()
    expect(questions.reply('s2', ids(questions)[0], { kind: 'dismissed' })).toBeUndefined()
    expect(questions.line('s1')?.open).toHaveLength(1)
    expect(changes).toEqual([])
  })
})

describe('a session that goes away', () => {
  it('takes its open questions with it, and composes no batch', () => {
    const { questions, changes } = model()
    questions.ask('s1', FIRST)
    changes.length = 0

    questions.forget('s1')
    expect(questions.line('s1')).toBeUndefined()
    expect(changes).toEqual([{ sessionId: 's1' }])
    expect(questions.reply('s1', 'q-1', { kind: 'dismissed' })).toBeUndefined()
  })

  it('takes the answers already held with it too', () => {
    const { questions } = model()
    questions.ask('s1', FIRST)
    questions.ask('s1', SECOND)
    questions.reply('s1', ids(questions)[0], { kind: 'recommendation' })

    questions.forget('s1')
    questions.ask('s1', SECOND)
    const batch = questions.reply('s1', ids(questions)[0], { kind: 'dismissed' })
    expect(batch?.text).not.toContain(FIRST.question)
  })

  it('says nothing about a session that had no line', () => {
    const { questions, changes } = model()
    questions.forget('s1')
    expect(changes).toEqual([])
  })
})
