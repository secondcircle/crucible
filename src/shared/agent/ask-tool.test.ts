import { describe, expect, it } from 'vitest'
import {
  ASK_TOOL,
  ASK_TOOL_DEFINITION,
  askCallSummary,
  askRequestFrom,
  bindAskTool,
  type AskRequest,
  type AskTools
} from './ask-tool'

const ASKED: AskRequest = {
  question: 'Where should the OpenAI API key come from?',
  context: 'OpenAI has no OAuth sign-in, and Crucible stores no provider secret today.',
  recommendation: 'Read OPENAI_ADMIN_KEY from the environment for now.'
}

function toolsSpy(): AskTools & { readonly calls: { sessionId: string; request: AskRequest }[] } {
  const calls: { sessionId: string; request: AskRequest }[] = []
  return {
    calls,
    ask(sessionId, request) {
      calls.push({ sessionId, request })
      return 'asked'
    }
  }
}

describe('what a call to ask must carry', () => {
  it('takes the question, the context and the recommendation, trimmed', () => {
    expect(askRequestFrom({ ...ASKED, question: `  ${ASKED.question}  ` })).toEqual(ASKED)
  })

  it('fails at the boundary, naming what is missing, when a field is blank', () => {
    for (const missing of ['question', 'context', 'recommendation']) {
      const params: Record<string, string> = { question: 'q', context: 'c', recommendation: 'r' }
      params[missing] = '   '
      expect(() => askRequestFrom(params)).toThrow(new RegExp(missing))
    }
    expect(() => askRequestFrom({})).toThrow(/question, context, recommendation/)
  })

  it('says nothing was asked, so the model knows the user saw no question', () => {
    expect(() => askRequestFrom({ question: 'q' })).toThrow(/Nothing was asked/)
  })
})

describe('the teaching the tool carries', () => {
  const description = ASK_TOOL_DEFINITION.description
  const parameter = (name: string): string =>
    ASK_TOOL_DEFINITION.parameters.find((one) => one.name === name)?.description ?? ''

  it('says the call comes back at once and carries no answer', () => {
    expect(description).toMatch(/comes back\s+at once/)
    expect(description).toMatch(/never carries an answer/)
  })

  it('says what to do instead of waiting, and not to poll', () => {
    expect(description).toMatch(/end your turn and wait/)
    expect(description).toMatch(/never poll/i)
  })

  it('says the answers arrive together, once every question is settled', () => {
    expect(description).toMatch(/only once every open question/)
    expect(description).toMatch(/one message/)
  })

  it('says a dismissal is the agent\u2019s to decide', () => {
    expect(description).toMatch(/dismissed/)
    expect(description).toMatch(/decide that one yourself/)
  })

  it('says one question per call', () => {
    expect(description).toMatch(/One question per call/)
  })

  it('tells each argument what it is for and how the user sees it', () => {
    expect(parameter('question')).toMatch(/one sentence/)
    expect(parameter('question')).toMatch(/answerable cold|without watching|has not been watching/)
    expect(parameter('context')).toMatch(/knows nothing of the current work/)
    expect(parameter('context')).toMatch(/Exactly that much/)
    expect(parameter('recommendation')).toMatch(/course of action/)
    expect(parameter('recommendation')).toMatch(/verbatim/)
  })

  it('is one required string per argument', () => {
    expect(ASK_TOOL_DEFINITION.parameters.map((one) => one.name)).toEqual([
      'question',
      'context',
      'recommendation'
    ])
    expect(ASK_TOOL_DEFINITION.parameters.every((one) => one.optional === undefined)).toBe(true)
    expect(ASK_TOOL_DEFINITION.parameters.every((one) => one.kind === undefined)).toBe(true)
  })
})

describe('the tool row\u2019s summary', () => {
  it('is the question itself', () => {
    expect(askCallSummary(ASKED)).toBe(ASKED.question)
  })

  it('says a question is being asked while the arguments are still half there', () => {
    expect(askCallSummary({})).toBe('a question')
    expect(askCallSummary(undefined)).toBe('a question')
  })
})

describe('binding', () => {
  it('fixes the session, so no agent can ask in another session\u2019s dock', () => {
    const tools = toolsSpy()
    const bound = bindAskTool(tools, 's1')
    expect(bound.ask(ASKED)).toBe('asked')
    expect(tools.calls).toEqual([{ sessionId: 's1', request: ASKED }])
    expect(Object.keys(bound)).toEqual(['ask'])
  })

  it('is named in Crucible\u2019s own namespace', () => {
    expect(ASK_TOOL).toBe('crucible_ask')
    expect(ASK_TOOL_DEFINITION.name).toBe(ASK_TOOL)
  })
})
