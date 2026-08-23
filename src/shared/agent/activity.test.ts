import { describe, expect, it } from 'vitest'
import { summarizeActivity } from './activity'
import type { TranscriptItem } from './port'

function tool(name: string, summary: string): TranscriptItem {
  return { kind: 'tool', name, summary, ok: true, output: '' }
}

describe('the session tree activity line', () => {
  it('says nothing about a stretch with no activity in it', () => {
    expect(summarizeActivity([])).toBeUndefined()
    expect(summarizeActivity([{ kind: 'user', text: 'hello' }])).toBeUndefined()
  })

  it('counts calls per tool name, in order of first appearance', () => {
    expect(
      summarizeActivity([
        { kind: 'thinking', text: 'hm' },
        tool('read', 'a.ts'),
        tool('bash', 'npm test'),
        tool('read', 'b.ts'),
        { kind: 'assistant', markdown: 'done' }
      ])
    ).toBe('thinking · assistant · 2 read · 1 bash')
  })

  it('counts one skill once however many of its files were opened', () => {
    // Progressive disclosure inside a skill is the skill being used, not three
    // skills firing, and the chain head says `1 skill` for the same turn.
    expect(
      summarizeActivity([
        tool('skill', 'writing-agent-prompts'),
        tool('skill', 'writing-agent-prompts · scope-boundaries.md'),
        tool('skill', 'writing-agent-prompts · examples/worked.md')
      ])
    ).toBe('1 skill')
  })

  it('still counts two skills as two', () => {
    expect(
      summarizeActivity([
        tool('skill', 'writing-agent-prompts · scope-boundaries.md'),
        tool('skill', 'reviewing-diffs'),
        tool('skill', 'writing-agent-prompts')
      ])
    ).toBe('2 skill')
  })

  it('names what went wrong after what happened', () => {
    expect(
      summarizeActivity([tool('read', 'a.ts'), { kind: 'error', message: 'boom' }])
    ).toBe('1 read · failed')
  })
})
