import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  ASK_TOOL_DEFINITION,
  type AskRequest,
  type BoundAskTool
} from '../../shared/agent/ask-tool'
import { askPiTool } from './ask-pi-tool'
import { parametersSchema } from './pi-tools'

function boundSpy(): BoundAskTool & { readonly calls: AskRequest[] } {
  const calls: AskRequest[] = []
  return {
    calls,
    ask(request: AskRequest) {
      calls.push(request)
      return 'asked'
    }
  }
}

// π hands a tool five arguments; Crucible's read the first two and nothing
// else, which is the whole of what this definition promises.
const call = (tool: ToolDefinition, params: unknown): Promise<unknown> =>
  tool.execute('c1', params as never, undefined, undefined, undefined as never)

const textOf = (result: unknown): string =>
  (result as { content: { text: string }[] }).content[0].text

describe('the ask tool as \u03c0 sees it', () => {
  it('is the shared definition, teaching and all', () => {
    const tool = askPiTool(boundSpy())
    expect(tool.name).toBe('crucible_ask')
    expect(tool.description).toBe(ASK_TOOL_DEFINITION.description)
  })

  it('declares three required strings', () => {
    expect(parametersSchema(ASK_TOOL_DEFINITION.parameters)).toMatchObject({
      type: 'object',
      required: ['question', 'context', 'recommendation'],
      properties: {
        question: { type: 'string' },
        context: { type: 'string' },
        recommendation: { type: 'string' }
      }
    })
  })

  it('asks through the bound behavior and answers with its text', async () => {
    const bound = boundSpy()
    const asked = {
      question: 'Where should the OpenAI API key come from?',
      context: 'OpenAI has no OAuth sign-in.',
      recommendation: 'Read OPENAI_ADMIN_KEY from the environment.'
    }
    expect(textOf(await call(askPiTool(bound), asked))).toBe('asked')
    expect(bound.calls).toEqual([asked])
  })

  it('fails the call in the model\u2019s face when a part is missing, asking nothing', async () => {
    const bound = boundSpy()
    await expect(call(askPiTool(bound), { question: 'why?' })).rejects.toThrow(
      /context, recommendation/
    )
    expect(bound.calls).toEqual([])
  })

  // A run's only voice is a message to its orchestrator, so nothing a node
  // does may reach a person's dock. Read at the source, because a node's
  // tools are fixed where its session is built and there is nothing at
  // runtime to ask.
  it('is mounted nowhere a workflow node could reach it', () => {
    const node = readFileSync(
      join(import.meta.dirname, '..', 'workflows', 'sdk-node-session.ts'),
      'utf8'
    )
    expect(node).not.toContain('ask-pi-tool')
    expect(node).not.toContain('crucible_ask')
  })
})
