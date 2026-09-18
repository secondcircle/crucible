// @vitest-environment node
//
// The complete_node parameter schema is where a node's verdict contract
// becomes enforceable: π validates tool arguments against it and hands the
// model a precise error naming the received arguments. Loose here meant a
// mangled call arrived as a plausible object with the verdict silently
// missing, failed one engine turn later with less to go on, and burned the
// node's retries (run 779a died exactly this way).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { toTranscript, type StoredMessage } from '../agent/sdk-transcript'
import { completeNodeParameters, reopenable, toolCallCount } from './sdk-node-session'

describe('completeNodeParameters', () => {
  it('leaves verdict optional and untyped when the node declares no schema', () => {
    expect(completeNodeParameters(undefined)).toEqual({
      type: 'object',
      required: ['summary'],
      properties: {
        summary: { type: 'string', description: 'One-paragraph summary of what was done.' },
        verdict: { description: 'Verdict matching the declared schema.' }
      }
    })
  })

  it('splices a declared schema in and marks verdict required', () => {
    const schema = {
      type: 'object',
      required: ['verdict', 'reason'],
      properties: {
        verdict: { enum: ['approved', 'changes-required'] },
        reason: { type: 'string' }
      }
    }
    expect(completeNodeParameters(schema)).toEqual({
      type: 'object',
      required: ['summary', 'verdict'],
      properties: {
        summary: { type: 'string', description: 'One-paragraph summary of what was done.' },
        verdict: { description: 'Verdict matching the declared schema.', ...schema }
      }
    })
  })

  it("lets the schema's own description win over the boilerplate one", () => {
    const schema = { type: 'string', description: 'yes or no' }
    const parameters = completeNodeParameters(schema) as {
      properties: { verdict: { description: string } }
    }
    expect(parameters.properties.verdict.description).toBe('yes or no')
  })
})

// The engine asks a live node for its tool-call count on every lull in the
// stream. It used to get it by building the whole transcript and throwing it
// away; these hold the cheap count to the number the transcript reports.
describe('toolCallCount', () => {
  function messages(...stored: unknown[]): StoredMessage[] {
    return stored as StoredMessage[]
  }

  const conversation = messages(
    { role: 'user', content: 'Fix the classifier.' },
    {
      role: 'assistant',
      stopReason: 'toolUse',
      content: [
        { type: 'thinking', thinking: 'read it first' },
        { type: 'text', text: 'Reading.' },
        { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.ts' } },
        { type: 'toolCall', id: 'c2', name: 'read', arguments: { path: 'b.ts' } }
      ]
    },
    {
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'read',
      isError: false,
      content: [{ type: 'text', text: 'ok' }]
    },
    {
      role: 'toolResult',
      toolCallId: 'c2',
      toolName: 'read',
      isError: true,
      content: [{ type: 'text', text: 'no such file' }]
    },
    { role: 'branchSummary', summary: 'went another way' },
    { role: 'bashExecution', command: 'ls', output: 'a.ts', exitCode: 0 },
    {
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'Done.' }]
    }
  )

  it('counts what the transcript would count', () => {
    expect(toolCallCount(conversation)).toBe(
      toTranscript(conversation).filter((item) => item.kind === 'tool').length
    )
  })

  it('counts a failed call, and counts no bash run or summary as a call', () => {
    expect(toolCallCount(conversation)).toBe(2)
    expect(toolCallCount(messages())).toBe(0)
  })
})

// Resume continues a node in its own session, so the factory is handed the
// token the node's record carries. A token that names nothing would open as
// a blank conversation and lose the node its task, so it is refused here and
// the engine runs the node again from its prompt instead.
describe('reopening a node session', () => {
  const scratch: string[] = []
  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function tempFile(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'crucible-node-session-'))
    scratch.push(dir)
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, body, 'utf8')
    return path
  }

  it('accepts a session file with something in it', () => {
    const path = tempFile('{"type":"session"}\n')
    expect(reopenable(path)).toBe(path)
  })

  it('refuses a file that is gone, naming it', () => {
    expect(() => reopenable('/nowhere/session.jsonl')).toThrow('/nowhere/session.jsonl')
  })

  it('refuses an empty file, which would open as a conversation with no task', () => {
    const path = tempFile('')
    expect(() => reopenable(path)).toThrow('empty')
  })
})
