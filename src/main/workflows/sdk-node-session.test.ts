// @vitest-environment node
//
// The complete_node parameter schema is where a node's verdict contract
// becomes enforceable: π validates tool arguments against it and hands the
// model a precise error naming the received arguments. Loose here meant a
// mangled call arrived as a plausible object with the verdict silently
// missing, failed one engine turn later with less to go on, and burned the
// node's retries (run 779a died exactly this way).
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { toTranscript, type StoredMessage } from '../agent/sdk-transcript'
import {
  COMPLETE_NODE_DESCRIPTION,
  RAISE_BLOCKER_DESCRIPTION,
  completeNodeParameters,
  reopenable,
  toolCallCount,
  withWorkspaceContext
} from './sdk-node-session'

// With no role prompt written for a node, the two tools' descriptions are the
// whole of what a node is told about finishing. They ride the request's tools
// parameter, so they reach a node whatever its workflow put in its prompts.
describe('what the two node tools say about themselves', () => {
  it('complete_node: the only way out, ending a message is not it, outputs first, the verdict shape', () => {
    const text = COMPLETE_NODE_DESCRIPTION
    expect(text).toMatch(/only way this node finishes/)
    expect(text).toMatch(/Ending a message is not completion/)
    expect(text).toMatch(/every\s+declared output file is written/)
    expect(text).toMatch(/rejects the call, in this same\s+conversation/)
    expect(text).toMatch(/`verdict` is required when a schema is declared/)
    expect(text).toMatch(/plain\s+JSON object matching that schema, never as a JSON-encoded string/)
  })

  it('raise_blocker: parks the node, plain text is never read, the answer is the next message', () => {
    const text = RAISE_BLOCKER_DESCRIPTION
    expect(text).toMatch(/Park this node/)
    expect(text).toMatch(/Nobody reads your messages/)
    expect(text).toMatch(/end your\s+turn and wait: the answer arrives as your next message/)
    expect(text).toMatch(/Do\s+not improvise/)
  })

  it('names nothing of the layer below', () => {
    for (const text of [COMPLETE_NODE_DESCRIPTION, RAISE_BLOCKER_DESCRIPTION]) {
      expect(text).not.toMatch(/\bpi\b/i)
      expect(text).not.toContain('\u03c0')
    }
  })
})

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

// A run that targets a repository inside the workspace hands its nodes the
// workspace's AGENTS.md as well as the worktree's, walked by the agent
// runtime's own loader, so what a node is told never depends on where the
// target's worktree was put.
describe('the context files of a node in a targeted run', () => {
  const made: string[] = []
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function sh(cwd: string, ...args: string[]): void {
    execFileSync('git', args, { cwd, stdio: 'ignore' })
  }

  /** A workspace with its own AGENTS.md and a component repository with another. */
  function layout(): { root: string; workspace: string; component: string; agentDir: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'crucible-node-context-')))
    made.push(root)
    const workspace = join(root, 'workspace')
    const component = join(workspace, 'app')
    const agentDir = join(root, 'agent')
    mkdirSync(component, { recursive: true })
    mkdirSync(agentDir)
    writeFileSync(join(workspace, 'AGENTS.md'), 'the workspace\n')
    writeFileSync(join(component, 'AGENTS.md'), 'the component\n')
    sh(component, 'init', '-q', '-b', 'main')
    sh(component, '-c', 'user.email=t@example.invalid', '-c', 'user.name=T', 'add', '-A')
    sh(component, '-c', 'user.email=t@example.invalid', '-c', 'user.name=T', 'commit', '-q', '-m', 'first')
    return { root, workspace, component, agentDir }
  }

  async function contextOf(cwd: string, workspace: string, agentDir: string): Promise<string[]> {
    const pi = await import('@earendil-works/pi-coding-agent')
    return withWorkspaceContext(
      pi.loadProjectContextFiles({ cwd, agentDir }),
      pi.loadProjectContextFiles({ cwd: workspace, agentDir })
    ).map((file) => file.content.trim())
  }

  it('sends each once when the worktree sits under the target inside the workspace', async () => {
    const { workspace, component, agentDir } = layout()
    const worktree = join(component, '.crucible', 'worktrees', 'run-1')
    sh(component, 'worktree', 'add', '-q', '-b', 'crucible/run-1', worktree)

    expect(await contextOf(worktree, workspace, agentDir)).toEqual([
      'the workspace',
      'the component'
    ])
  })

  it('sends the same when a script put the worktree outside the workspace', async () => {
    const { root, workspace, component, agentDir } = layout()
    const worktree = join(root, 'elsewhere', 'wt-1')
    sh(component, 'worktree', 'add', '-q', '-b', 'wt/1', worktree)

    expect(await contextOf(worktree, workspace, agentDir)).toEqual([
      'the workspace',
      'the component'
    ])
  })
})
