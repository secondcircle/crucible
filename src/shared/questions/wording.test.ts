import { describe, expect, it } from 'vitest'
import type { Question } from '../agent/port'
import { askAnswer, composeAnswerBatch, isAnswerBatch } from './wording'

function questionOf(overrides: Partial<Question> = {}): Question {
  return {
    id: 'q-1',
    question: 'Where should the OpenAI API key come from?',
    context: 'OpenAI has no OAuth sign-in, and Crucible stores no provider secret today.',
    recommendation: 'Read OPENAI_ADMIN_KEY from the environment for now.',
    askedAt: '2026-09-10T10:00:00.000Z',
    ...overrides
  }
}

const ASKED = {
  question: questionOf().question,
  context: questionOf().context,
  recommendation: questionOf().recommendation
}

describe('what the ask tool answers with', () => {
  it('says the question is posted and that no answer comes back here', () => {
    const said = askAnswer(ASKED, 1)
    expect(said).toContain(ASKED.question)
    expect(said).toContain('questions dock')
    expect(said).toMatch(/No answer comes back through this tool/)
  })

  it('tells the agent to carry on or stop, and never to poll', () => {
    const said = askAnswer(ASKED, 1)
    expect(said).toMatch(/Carry on with work that does not depend on it, or end your turn/)
    expect(said).toMatch(/Do not poll/)
  })

  it('says how many are open and that the answers come together', () => {
    expect(askAnswer(ASKED, 3)).toMatch(/3 of your questions are open/)
    expect(askAnswer(ASKED, 3)).toMatch(/arrive together, in one message/)
  })
})

describe('the answer batch', () => {
  it('is one message carrying every question with what the user said', () => {
    const batch = composeAnswerBatch([
      { question: questionOf({ id: 'q-1' }), reply: { kind: 'recommendation' } },
      {
        question: questionOf({ id: 'q-2', question: 'Block on a missing changelog entry?' }),
        reply: { kind: 'answered', text: 'Block, but only on the main branch.' }
      },
      {
        question: questionOf({ id: 'q-3', question: 'Drop the --legacy flag?' }),
        reply: { kind: 'dismissed' }
      }
    ])

    expect(batch.text).toContain('1. Where should the OpenAI API key come from?')
    expect(batch.text).toContain('Read OPENAI_ADMIN_KEY from the environment for now.')
    expect(batch.text).toContain('2. Block on a missing changelog entry?')
    expect(batch.text).toContain('Block, but only on the main branch.')
    expect(batch.text).toContain('3. Drop the --legacy flag?')
  })

  it('says a taken recommendation was the agent\u2019s own', () => {
    const batch = composeAnswerBatch([
      { question: questionOf(), reply: { kind: 'recommendation' } }
    ])
    expect(batch.text).toMatch(/your own recommendation, taken as it stood/)
  })

  it('says a dismissed question is the agent\u2019s to decide', () => {
    const batch = composeAnswerBatch([{ question: questionOf(), reply: { kind: 'dismissed' } }])
    expect(batch.text).toMatch(/Dismissed with no answer/)
    expect(batch.text).toMatch(/Decide this one on your own judgment/)
  })

  it('says nothing further is coming, so the agent does not wait for more', () => {
    const batch = composeAnswerBatch([
      { question: questionOf(), reply: { kind: 'answered', text: 'the env var' } }
    ])
    expect(batch.text).toMatch(/nothing further is coming/)
  })

  it('is recognizable as a batch by its own wording', () => {
    const batch = composeAnswerBatch([{ question: questionOf(), reply: { kind: 'dismissed' } }])
    expect(isAnswerBatch(batch.text)).toBe(true)
    expect(isAnswerBatch('the user answered something')).toBe(false)
  })
})

describe('the row the transcript shows for it', () => {
  it('is one amber card, whatever it carries', () => {
    const card = composeAnswerBatch([
      { question: questionOf(), reply: { kind: 'answered', text: 'the env var' } }
    ]).card
    expect(card?.badge).toBe('answers')
    expect(card?.tone).toBe('warn')
  })

  it('names the question and its answer when there was one question', () => {
    const card = composeAnswerBatch([
      { question: questionOf(), reply: { kind: 'answered', text: 'The env var is fine.' } }
    ]).card
    expect(card?.title).toBe(questionOf().question)
    expect(card?.meta).toBe('answered')
    expect(card?.body).toBe('The env var is fine.')
  })

  it('marks a taken recommendation and a dismissal for what they are', () => {
    const taken = composeAnswerBatch([
      { question: questionOf(), reply: { kind: 'recommendation' } }
    ]).card
    expect(taken?.meta).toBe('took the recommendation')
    expect(taken?.body).toContain(questionOf().recommendation)

    const dismissed = composeAnswerBatch([
      { question: questionOf(), reply: { kind: 'dismissed' } }
    ]).card
    expect(dismissed?.meta).toBe('dismissed')
    expect(dismissed?.body).toBeUndefined()
  })

  it('counts them and lists every question with its answer when there were several', () => {
    const card = composeAnswerBatch([
      { question: questionOf({ id: 'q-1' }), reply: { kind: 'recommendation' } },
      {
        question: questionOf({ id: 'q-2', question: 'Drop the --legacy flag?' }),
        reply: { kind: 'dismissed' }
      }
    ]).card

    expect(card?.title).toBe('2 answers')
    expect(card?.meta).toBe('1 dismissed')
    expect(card?.body).toContain('Where should the OpenAI API key come from? —')
    expect(card?.body).toContain('Drop the --legacy flag? — dismissed')
  })
})
