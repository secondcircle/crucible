import { describe, expect, it } from 'vitest'
import type { WorkflowReadRequest } from './catalog'
import { DEFAULT_CATALOG_READER } from './catalog-settings'
import { readerMessage, readingOf, ReadingRefused } from './reader'

// The check every reply has to pass before the catalog keeps a word of it.
// A citation that does not hold is a failed reading, never a shown one.

const WORKFLOW = [
  "import { workflow } from 'crucible:workflow'", // 1
  "const MODEL = 'anthropic/claude-opus-5-5:high'", // 2
  'const NODE_SYSTEM = `You are a node.`', // 3
  'function taskPrompt(intent: string): string {', // 4
  '  return `Do ${intent} now.`', // 5
  '}', // 6
  'export default workflow({ run: async () => {} })' // 7
].join('\n')

const REQUEST: WorkflowReadRequest = {
  reader: DEFAULT_CATALOG_READER,
  name: 'demo',
  files: [
    {
      path: '/w/.crucible/workflows/demo.ts',
      label: 'demo.ts',
      text: WORKFLOW
    }
  ],
  manifest: { description: 'a demo', inputs: { intent: 'what to do' } }
}

interface Agent {
  role: string
  nodes: string[]
  does: string
  model: unknown
  system: unknown
  prompt: unknown
}

function reply(agent: Partial<Agent> = {}, rest: Record<string, unknown> = {}): string {
  return JSON.stringify({
    summary: 'Does the thing.',
    agents: [
      {
        role: 'Worker',
        nodes: ['work'],
        does: 'Works.',
        model: {
          value: 'anthropic/claude-opus-5-5:high',
          file: 'demo.ts',
          line: 2
        },
        system: { name: 'NODE_SYSTEM', file: 'demo.ts', start: 3, end: 3 },
        prompt: { name: 'taskPrompt', file: 'demo.ts', start: 4, end: 6 },
        ...agent
      }
    ],
    steps: ['It works.'],
    stops: [],
    returns: { artifacts: [], branch: null, report: 'what it did' },
    ...rest
  })
}

const read = (text: string): ReturnType<typeof readingOf> =>
  readingOf(text, REQUEST, '2026-09-01T00:00:00.000Z')

describe('a reader’s reply', () => {
  it('is kept with the source lines it cites, interpolations marked', () => {
    const reading = read(`Here it is:\n${reply()}\nDone.`)
    const [agent] = reading.agents
    expect(agent.model).toMatchObject({
      value: 'anthropic/claude-opus-5-5:high',
      quote: { start: 2, end: 2 }
    })
    expect(agent.prompt).toMatchObject({
      name: 'taskPrompt',
      file: REQUEST.files[0].path,
      start: 4,
      end: 6
    })
    expect(agent.prompt?.lines).toHaveLength(3)
    const holes = agent.prompt?.lines.flat().filter((segment) => segment.filled)
    expect(holes?.map((segment) => segment.text)).toEqual(['${intent}'])
    expect(reading.reader).toEqual(DEFAULT_CATALOG_READER)
    expect(reading.returns.branch).toBeUndefined()
  })

  it('takes a missing model as none named, so the engine default applies', () => {
    expect(read(reply({ model: null })).agents[0].model).toBeUndefined()
  })

  it('is refused for a line past the end of the file', () => {
    expect(() =>
      read(
        reply({
          prompt: { name: 'taskPrompt', file: 'demo.ts', start: 4, end: 40 }
        })
      )
    ).toThrow(/demo\.ts has 7 lines/)
  })

  it('is refused for lines that do not hold what it says', () => {
    expect(() =>
      read(
        reply({
          prompt: { name: 'taskPrompt', file: 'demo.ts', start: 2, end: 3 }
        })
      )
    ).toThrow(/does not name it/)
    expect(() =>
      read(
        reply({
          model: {
            value: 'anthropic/claude-opus-5-5:high',
            file: 'demo.ts',
            line: 3
          }
        })
      )
    ).toThrow(/does not write it/)
  })

  it('is refused for a file it was not shown', () => {
    expect(() =>
      read(
        reply({
          system: { name: 'NODE_SYSTEM', file: 'other.ts', start: 3, end: 3 }
        })
      )
    ).toThrow(/not a file it was shown/)
  })

  it('is refused for a model string that is no model name', () => {
    expect(() => read(reply({ model: { value: 'rm -rf /', file: 'demo.ts', line: 2 } }))).toThrow(
      ReadingRefused
    )
  })

  it('is refused for something other than the shape asked for', () => {
    expect(() => read('I cannot help with that.')).toThrow(/no JSON object/)
    expect(() => read('{ not json }')).toThrow(/does not parse/)
    expect(() => read(reply({}, { steps: [] }))).toThrow(/no steps/)
    expect(() => read(reply({ nodes: [] }))).toThrow(/no nodes/)
  })
})

describe('the message a reader is given', () => {
  it('numbers every line and states what the engine already knows', () => {
    const message = readerMessage({
      ...REQUEST,
      plan: [{ id: 'work', model: 'anthropic/claude-opus-5-5:high' }]
    })
    expect(message).toContain('   5|   return `Do ${intent} now.`')
    expect(message).toContain('- inputs: intent (what to do)')
    expect(message).toContain('work (anthropic/claude-opus-5-5:high)')
  })
})
