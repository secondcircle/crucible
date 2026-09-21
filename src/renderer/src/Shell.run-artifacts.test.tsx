// @vitest-environment jsdom
//
// The artifact rail, the artifact reader and the node's took/made strip,
// driven through the scripted run seam like the rest of the run surfaces. The
// record is the whole input: every row state, count and flow line here comes
// from a record shape and nothing else.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeAll, describe, expect, it } from 'vitest'
import type { ShellSnapshot } from '../../shared/agent/port'
import type { RunNode, RunRecord } from '../../shared/workflows/run'
import { Shell } from './Shell'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedPort } from './testing/scripted-port'
import { createScriptedWorkflowRuns } from './testing/scripted-workflow-runs'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { settled } from './testing/settled'

const SNAPSHOT: ShellSnapshot = {
  workspaces: [{ id: 'w1', name: 'crucible', path: '/repos/crucible' }],
  activeWorkspaceId: 'w1',
  activeSessionId: 's1',
  sessions: [
    {
      id: 's1',
      workspaceId: 'w1',
      createdAt: '2026-08-20T10:00:00.000Z',
      title: 'artifacts build',
      working: false,
      fresh: false
    }
  ]
}

const DIR = '/state/workflow-runs/en42/artifacts'
const INTENT = '/repos/crucible/docs/intent/artifacts.md'
const SPEC = `${DIR}/spec.md`
const CHANGES = `${DIR}/changes.md`
const REVIEW = `${DIR}/review.md`
const REPORT = `${DIR}/report.html`

const copied: string[] = []

beforeAll(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      writeText: async (text: string) => {
        copied.push(text)
      }
    },
    configurable: true
  })
})

function read(path: string): RunNode['reads'][number] {
  return { name: path.split('/').at(-1) ?? path, path, desc: 'input' }
}

function nodeOf(overrides: Partial<RunNode> & { id: string }): RunNode {
  return {
    status: 'pending',
    parents: [],
    model: 'anthropic/claude-fable-5:high',
    reads: [],
    artifacts: [],
    ...overrides
  }
}

/** A build run mid-flight: one written artifact, one being made, one expected. */
function runOf(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'en42',
    workflow: 'build',
    status: 'running',
    workspacePath: '/repos/crucible',
    workspaceName: 'crucible',
    sessionId: 's1',
    branch: 'crucible/run-en42',
    inputs: { intent: INTENT },
    inputDescs: { intent: 'What the run was asked to build' },
    nodes: [
      nodeOf({
        id: 'planner',
        status: 'complete',
        reads: [read(INTENT)],
        artifacts: [
          {
            name: 'spec',
            path: SPEC,
            desc: 'the approved implementation spec',
            writtenAt: '2026-08-20T10:04:00.000Z'
          }
        ],
        startedAt: '2026-08-20T10:00:00.000Z',
        endedAt: '2026-08-20T10:04:00.000Z'
      }),
      nodeOf({
        id: 'builder',
        status: 'running',
        parents: ['planner'],
        reads: [read(INTENT), read(SPEC)],
        artifacts: [{ name: 'changes', path: CHANGES, desc: 'every file the builder touched' }],
        startedAt: '2026-08-20T10:04:00.000Z'
      }),
      nodeOf({
        id: 'review-1',
        parents: ['builder'],
        artifacts: [{ name: 'review', path: REVIEW, desc: "the reviewer's verdict" }]
      })
    ],
    createdAt: '2026-08-20T10:00:00.000Z',
    startedAt: '2026-08-20T10:00:00.000Z',
    ...overrides
  }
}

function mount(runs: readonly RunRecord[]) {
  const port = createScriptedPort(SNAPSHOT)
  const workflowRuns = createScriptedWorkflowRuns(runs)
  render(
    <Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
      workflowRuns={workflowRuns}
    />
  )
  return { port, workflowRuns }
}

// Through ⌘R and Open run, which is the one door every run has — the strip
// carries only the live ones.
async function openRun(
  runs: readonly RunRecord[],
  prepare?: (runs: ReturnType<typeof createScriptedWorkflowRuns>) => void
) {
  const rig = mount(runs)
  prepare?.(rig.workflowRuns)
  await act(settled)
  await act(async () => {
    fireEvent.keyDown(document, { key: 'r', metaKey: true })
    await settled()
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Open run' }))
    await settled()
  })
  return rig
}

const rail = (): HTMLElement => screen.getByLabelText('Artifacts')

/** The rows alone: the scope switch is a control, not an artifact. */
const rows = (): readonly HTMLElement[] =>
  within(rail())
    .queryAllByRole('button')
    .filter((button) => button.classList.contains('art'))

const groups = (): readonly string[] =>
  [...rail().querySelectorAll('.argroup')].map((group) => group.textContent ?? '')

const scopeSwitch = (label: 'this node' | 'whole run'): HTMLElement =>
  within(rail()).getByRole('button', { name: label })

async function pickScope(label: 'this node' | 'whole run'): Promise<void> {
  await act(async () => {
    fireEvent.click(scopeSwitch(label))
    await settled()
  })
}

async function pickNode(id: string): Promise<void> {
  await act(async () => {
    const graph = screen.getByLabelText('Run graph')
    fireEvent.click(within(graph).getByRole('button', { name: new RegExp(id) }))
    await settled()
  })
}

describe('the artifact rail, following the picked node', () => {
  // The run view opens on the running node, so the rail opens on it too.
  it('shows what the node made, then what it took, and counts the node\u2019s own', async () => {
    await openRun([runOf()])

    expect(groups()).toEqual(['Made by builder', 'Took'])
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining('changes.md'),
      expect.stringContaining('artifacts.md'),
      expect.stringContaining('spec.md')
    ])

    // The rows are the rows the run-wide list draws: producer, description,
    // state and the "read by" line, on a took row as much as a made one.
    const [made, input, took] = rows()
    expect(made).toHaveClass('writing')
    expect(made).toHaveTextContent('builder')
    expect(made).toHaveTextContent('every file the builder touched')
    expect(made).toHaveTextContent('not written yet \u00b7 node running')
    expect(input).toHaveClass('input')
    expect(input).toHaveTextContent('read by planner, builder')
    expect(took).toHaveClass('written')
    expect(took).toHaveTextContent('planner')
    expect(took).toHaveTextContent('read by builder')

    // The count is this node's declared outputs, not the run's three.
    expect(rail()).toHaveTextContent('0 of 1 written')
    expect(rail()).not.toHaveTextContent('of 3 written')
  })

  it('follows the graph: another node, that node\u2019s files', async () => {
    await openRun([runOf()])
    await pickNode('planner')

    expect(groups()).toEqual(['Made by planner', 'Took'])
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining('spec.md'),
      expect.stringContaining('artifacts.md')
    ])
    expect(rail()).toHaveTextContent('1 of 1 written')
  })

  // Every file the node's prompt named, whatever its origin: this one was
  // neither handed in at kickoff nor declared by any node of the run.
  it('holds a read of a file the run neither took in nor wrote', async () => {
    const outside = '/repos/crucible/docs/adr/0001-agent-port.md'
    await openRun([
      runOf({
        nodes: [
          nodeOf({
            id: 'auditor',
            status: 'running',
            reads: [read(INTENT), read(outside)],
            artifacts: []
          })
        ]
      })
    ])

    expect(groups()).toEqual(['Took'])
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining('artifacts.md'),
      expect.stringContaining('0001-agent-port.md')
    ])
    expect(rows()[1]).toHaveClass('input')
    expect(rows()[1]).toHaveTextContent('read by auditor')
  })

  it('says so when the picked node declared nothing, and shows no count', async () => {
    await openRun([
      runOf({ nodes: [...runOf().nodes, nodeOf({ id: 'typecheck', parents: ['builder'] })] })
    ])
    await pickNode('typecheck')

    expect(rail()).toHaveTextContent(
      'typecheck declared no artifacts: nothing to take, nothing to make.'
    )
    expect(rows()).toHaveLength(0)
    expect(rail()).not.toHaveTextContent('written')
    // The whole run is still one click away.
    expect(scopeSwitch('whole run')).toBeInTheDocument()
  })

  it('outlines the row the reader is showing, and nothing otherwise', async () => {
    const { workflowRuns } = await openRun([runOf()])
    workflowRuns.artifacts.set(`en42:${SPEC}`, { kind: 'markdown', body: '# the spec', bytes: 10 })

    // The whole list is the node's, so nothing in it is lit for being the
    // node's.
    expect(rows().some((row) => row.hasAttribute('aria-current'))).toBe(false)

    await act(async () => {
      fireEvent.click(within(rail()).getByRole('button', { name: /spec\.md/ }))
      await settled()
    })
    expect(rows().filter((row) => row.hasAttribute('aria-current'))).toEqual([
      within(rail()).getByRole('button', { name: /spec\.md/ })
    ])

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
      await settled()
    })
    expect(rows().some((row) => row.hasAttribute('aria-current'))).toBe(false)
  })

  it('keeps the switch where it was left until the run view is opened again', async () => {
    await openRun([runOf()])

    await pickScope('whole run')
    expect(scopeSwitch('whole run')).toHaveAttribute('aria-pressed', 'true')
    expect(groups()).toEqual(['Handed in at kickoff', 'Written by the run'])

    // A different node is picked, and the scope the user chose stands.
    await pickNode('planner')
    expect(groups()).toEqual(['Handed in at kickoff', 'Written by the run'])

    // Out of the run view and back in: this node again.
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
      await settled()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open run' }))
      await settled()
    })
    expect(scopeSwitch('this node')).toHaveAttribute('aria-pressed', 'true')
    expect(groups()).toEqual(['Made by builder', 'Took'])
  })
})

describe('the artifact rail, whole run', () => {
  // Opened mid-flight, so the rail has watched nothing appear: the record's
  // own node order is every bit of first appearance it can be asked for, and
  // spec.md, changes.md, review.md is that order.
  it('lists kickoff inputs first, then what the run wrote, in first-appearance order', async () => {
    await openRun([runOf()])
    await pickScope('whole run')

    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining('artifacts.md'),
      expect.stringContaining('spec.md'),
      expect.stringContaining('changes.md'),
      expect.stringContaining('review.md')
    ])

    // The two groups are named and the input's is above the run's own.
    expect(groups()).toEqual(['Handed in at kickoff', 'Written by the run'])

    // Each row names its producer and its readers, which is the dataflow.
    expect(rows()[0]).toHaveTextContent('input')
    expect(rows()[0]).toHaveTextContent('What the run was asked to build')
    expect(rows()[0]).toHaveTextContent('read by planner, builder')
    expect(rows()[1]).toHaveTextContent('planner')
    expect(rows()[1]).toHaveTextContent('read by builder')
    expect(rail()).toHaveTextContent("artifacts live in the run's own directory, never in the repo")
  })

  // Run-written rows sit in order of first appearance — plan order for
  // ghosts, then start order — and a row never moves once placed. This plan
  // declares outputs for planner and review-1 but none for builder, so the
  // review row is placed at kickoff and must not move when the builder starts
  // and declares changes.md.
  it('keeps a row in place when a later node starts and declares a new output', async () => {
    const kickoff = runOf({
      nodes: [
        nodeOf({
          id: 'planner',
          artifacts: [{ name: 'spec', path: SPEC, desc: 'the approved implementation spec' }]
        }),
        nodeOf({ id: 'builder', parents: ['planner'] }),
        nodeOf({
          id: 'review-1',
          parents: ['builder'],
          artifacts: [{ name: 'review', path: REVIEW, desc: "the reviewer's verdict" }]
        })
      ]
    })
    const { workflowRuns } = await openRun([kickoff])
    await pickScope('whole run')

    const placedAt = rows().findIndex((row) => row.textContent?.includes('review.md'))
    expect(placedAt).toBeGreaterThan(-1)

    // The builder starts; its NodeSpec declares changes.md, unwritten.
    await act(async () => {
      workflowRuns.setRuns([
        runOf({
          nodes: [
            nodeOf({
              id: 'planner',
              status: 'complete',
              artifacts: [
                {
                  name: 'spec',
                  path: SPEC,
                  desc: 'the approved implementation spec',
                  writtenAt: '2026-08-20T10:04:00.000Z'
                }
              ]
            }),
            nodeOf({
              id: 'builder',
              status: 'running',
              parents: ['planner'],
              artifacts: [
                { name: 'changes', path: CHANGES, desc: 'every file the builder touched' }
              ]
            }),
            nodeOf({
              id: 'review-1',
              parents: ['builder'],
              artifacts: [{ name: 'review', path: REVIEW, desc: "the reviewer's verdict" }]
            })
          ]
        })
      ])
      await settled()
    })

    expect(rows()[placedAt]).toHaveTextContent('review.md')
  })

  it('draws the four states from the record alone', async () => {
    await openRun([runOf()])
    await pickScope('whole run')

    const [input, written, making, expected] = rows()
    expect(input).toHaveClass('input')
    expect(written).toHaveClass('written')
    // The dot mirrors the producing node's: breathing while it works.
    expect(making).toHaveClass('writing')
    expect(making).toHaveTextContent('not written yet · node running')
    expect(expected).toHaveClass('pending')
    expect(expected).toHaveTextContent('not written yet · node pending')
  })

  it('keeps a failed node\u2019s declared output, marked never written', async () => {
    await openRun([
      runOf({
        status: 'failed',
        nodes: [
          nodeOf({
            id: 'builder',
            status: 'failed',
            artifacts: [{ name: 'changes', path: CHANGES, desc: 'every file the builder touched' }],
            error: 'the node gave up'
          })
        ]
      })
    ])
    await pickScope('whole run')

    expect(rows()).toHaveLength(2)
    expect(rows()[1]).toHaveTextContent('changes.md')
    expect(rows()[1]).toHaveTextContent('never written')
    expect(rows()[1]).toHaveClass('never')
  })

  it('counts declared outputs only, and says so nowhere when none are declared', async () => {
    await openRun([runOf()])
    await pickScope('whole run')
    expect(rail()).toHaveTextContent('1 of 3 written')
  })

  it('shows no count and one quiet line when the run declared nothing', async () => {
    await openRun([
      runOf({
        inputs: {},
        nodes: [nodeOf({ id: 'work', status: 'running' })]
      })
    ])
    await pickScope('whole run')

    expect(rail()).toHaveTextContent('This run declared no artifacts.')
    expect(rail()).not.toHaveTextContent('written')
    expect(rows()).toHaveLength(0)
  })

  it('outlines the open artifact and nothing else', async () => {
    const { workflowRuns } = await openRun([runOf()])
    workflowRuns.artifacts.set(`en42:${SPEC}`, {
      kind: 'markdown',
      body: '# the spec',
      bytes: 10
    })
    await pickScope('whole run')

    // What the shown node is making is no longer lit: the per-node scope is
    // the way to ask that question.
    expect(rows().some((row) => row.hasAttribute('aria-current'))).toBe(false)

    await act(async () => {
      fireEvent.click(rows()[1])
      await settled()
    })
    expect(rows()[1]).toHaveAttribute('aria-current')
    expect(rows()[2]).not.toHaveAttribute('aria-current')
  })
})

describe('the artifact reader', () => {
  it('opens over the transcript, renders markdown, and Esc walks back one step at a time', async () => {
    const { workflowRuns } = await openRun([runOf()], (scripted) => {
      scripted.transcripts.set('en42:builder', [
        { kind: 'assistant', markdown: 'the builder speaking' }
      ])
      scripted.artifacts.set(`en42:${SPEC}`, {
        kind: 'markdown',
        body: '# Spec\n\nthe approved plan',
        bytes: 6300,
        modifiedAt: '2026-08-20T10:04:00.000Z'
      })
    })
    expect(screen.getByText('the builder speaking')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(within(rail()).getByRole('button', { name: /spec\.md/ }))
      await settled()
    })

    const reader = screen.getByLabelText('Artifact spec.md')
    expect(reader).toHaveTextContent('written by planner')
    expect(reader).toHaveTextContent('6.2 KB')
    expect(reader).toHaveTextContent(SPEC)
    expect(within(reader).getByText('the approved plan')).toBeInTheDocument()
    // The transcript is gone; the graph and the rail are not.
    expect(screen.queryByText('the builder speaking')).toBeNull()
    expect(screen.getByLabelText('Run graph')).toBeInTheDocument()
    expect(rail()).toBeInTheDocument()
    expect(workflowRuns.calls).toContainEqual({ op: 'artifact', args: ['en42', SPEC] })

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
      await settled()
    })
    expect(screen.queryByLabelText('Artifact spec.md')).toBeNull()
    expect(screen.getByText('the builder speaking')).toBeInTheDocument()

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
      await settled()
    })
    expect(screen.queryByLabelText('Run en42')).toBeNull()
  })

  it('says an unwritten artifact is not there yet, and fills in when the record says it landed', async () => {
    const { workflowRuns } = await openRun([runOf()])

    await act(async () => {
      fireEvent.click(within(rail()).getByRole('button', { name: /changes\.md/ }))
      await settled()
    })

    const reader = screen.getByLabelText('Artifact changes.md')
    expect(reader).toHaveTextContent('not written yet · builder running')
    expect(reader).toHaveTextContent('This file has not been written yet.')
    // Nothing was read: there is nothing on disk to read.
    expect(workflowRuns.calls.some((call) => call.op === 'artifact')).toBe(false)
    // A control that cannot act does not pretend it can.
    expect(within(reader).queryByRole('button', { name: 'Reveal in Finder' })).toBeNull()

    workflowRuns.artifacts.set(`en42:${CHANGES}`, {
      kind: 'markdown',
      body: 'every file, with reasons',
      bytes: 24
    })
    await act(async () => {
      const landed = runOf()
      workflowRuns.setRuns([
        {
          ...landed,
          nodes: landed.nodes.map((node) =>
            node.id !== 'builder'
              ? node
              : {
                  ...node,
                  artifacts: [{ ...node.artifacts[0], writtenAt: '2026-08-20T10:20:00.000Z' }]
                }
          )
        }
      ])
      await settled()
    })

    expect(screen.getByLabelText('Artifact changes.md')).toHaveTextContent(
      'every file, with reasons'
    )
    expect(workflowRuns.calls).toContainEqual({ op: 'artifact', args: ['en42', CHANGES] })
  })

  it('renders an HTML artifact in a sandboxed frame of its own origin', async () => {
    const { workflowRuns } = await openRun([
      runOf({
        nodes: [
          nodeOf({
            id: 'report',
            status: 'complete',
            artifacts: [
              {
                name: 'report',
                path: REPORT,
                desc: "the run's summary for the human",
                writtenAt: '2026-08-20T10:30:00.000Z'
              }
            ]
          })
        ]
      })
    ])
    workflowRuns.artifacts.set(`en42:${REPORT}`, { kind: 'html', bytes: 2048 })

    await act(async () => {
      fireEvent.click(within(rail()).getByRole('button', { name: /report\.html/ }))
      await settled()
    })

    const frame = screen.getByTitle('report.html')
    expect(frame.tagName).toBe('WEBVIEW')
    expect(frame).toHaveAttribute(
      'src',
      `file://${REPORT.split('/').map(encodeURIComponent).join('/')}`
    )
    // Full fidelity is the guest's own: no sandbox attribute narrows it.
    expect(frame.getAttribute('sandbox')).toBeNull()
  })

  it('shows a read failure in the body and leaves the rail row alone', async () => {
    await openRun([runOf()])

    await act(async () => {
      fireEvent.click(within(rail()).getByRole('button', { name: /spec\.md/ }))
      await settled()
    })

    // The scripted service was given no body for this path, so it refuses.
    expect(screen.getByLabelText('Artifact spec.md')).toHaveTextContent(
      'That file is not one this run touched.'
    )
    expect(within(rail()).getByRole('button', { name: /spec\.md/ })).toHaveClass('written')
  })

  it('reveals and copies the file, and says the path was copied', async () => {
    const { workflowRuns } = await openRun([runOf()])
    workflowRuns.artifacts.set(`en42:${SPEC}`, { kind: 'markdown', body: '# spec', bytes: 6 })
    copied.length = 0

    await act(async () => {
      fireEvent.click(within(rail()).getByRole('button', { name: /spec\.md/ }))
      await settled()
    })
    const reader = screen.getByLabelText('Artifact spec.md')

    await act(async () => {
      fireEvent.click(within(reader).getByRole('button', { name: 'Reveal in Finder' }))
      await settled()
    })
    expect(workflowRuns.calls).toContainEqual({ op: 'revealArtifact', args: ['en42', SPEC] })

    await act(async () => {
      fireEvent.click(within(reader).getByRole('button', { name: 'Copy path' }))
      await settled()
    })
    expect(copied).toEqual([SPEC])
    expect(within(reader).getByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('swaps content for another artifact and closes when a node is picked in the graph', async () => {
    const { workflowRuns } = await openRun([runOf()])
    workflowRuns.artifacts.set(`en42:${SPEC}`, { kind: 'markdown', body: '# spec', bytes: 6 })
    workflowRuns.artifacts.set(`en42:${INTENT}`, {
      kind: 'markdown',
      body: 'what was asked for',
      bytes: 18
    })

    await act(async () => {
      fireEvent.click(within(rail()).getByRole('button', { name: /spec\.md/ }))
      await settled()
    })
    await act(async () => {
      fireEvent.click(within(rail()).getByRole('button', { name: /artifacts\.md/ }))
      await settled()
    })

    const reader = screen.getByLabelText('Artifact artifacts.md')
    expect(reader).toHaveTextContent('handed in at kickoff')
    expect(reader).toHaveTextContent('what was asked for')

    await act(async () => {
      const graph = screen.getByLabelText('Run graph')
      fireEvent.click(within(graph).getByRole('button', { name: /planner/ }))
      await settled()
    })
    expect(screen.queryByLabelText('Artifact artifacts.md')).toBeNull()
    expect(screen.getByLabelText('Run en42')).toBeInTheDocument()
  })
})

describe('the node strip', () => {
  it('shows what the shown node took and is making, chips opening the reader', async () => {
    await openRun([runOf()], (scripted) => {
      scripted.artifacts.set(`en42:${SPEC}`, { kind: 'markdown', body: '# spec', bytes: 6 })
    })

    const view = screen.getByLabelText('Run en42')
    const strip = view.querySelector('.inout')
    expect(strip).not.toBeNull()
    expect(strip).toHaveTextContent('took')
    expect(strip).toHaveTextContent('making')
    // A kickoff input is styled as one wherever it appears.
    const chips = within(strip as HTMLElement)
    expect(chips.getByRole('button', { name: 'artifacts.md' })).toHaveClass('in')
    expect(chips.getByRole('button', { name: 'spec.md' })).not.toHaveClass('in')
    expect(chips.getByRole('button', { name: 'changes.md' })).toHaveClass('unwritten')

    await act(async () => {
      fireEvent.click(chips.getByRole('button', { name: 'spec.md' }))
      await settled()
    })
    expect(screen.getByLabelText('Artifact spec.md')).toBeInTheDocument()
  })

  it('says made once the node has settled, and shows nothing for a node with neither', async () => {
    await openRun([
      runOf({
        status: 'complete',
        nodes: [
          nodeOf({
            id: 'planner',
            status: 'complete',
            reads: [read(INTENT)],
            artifacts: [
              { name: 'spec', path: SPEC, desc: 'the spec', writtenAt: '2026-08-20T10:04:00.000Z' }
            ]
          })
        ]
      })
    ])
    const settledStrip = screen.getByLabelText('Run en42').querySelector('.inout')
    expect(settledStrip).toHaveTextContent('made')
    expect(settledStrip).not.toHaveTextContent('making')
  })

  it('is absent entirely for a node that neither read nor declared anything', async () => {
    await openRun([
      runOf({ inputs: {}, nodes: [nodeOf({ id: 'work', status: 'running' })] })
    ])
    expect(screen.getByLabelText('Run en42').querySelector('.inout')).toBeNull()
  })
})
