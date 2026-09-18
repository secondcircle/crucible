// @vitest-environment jsdom
//
// The run view on a run that stopped short of completing, driven through the
// scripted run seam. One set of buttons and one banner over every stop —
// failed, cancelled, interrupted — with only the first sentence and the tint
// telling them apart, and the transcript marked where the node stopped and
// where a resume picked it up again.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ShellSnapshot, TranscriptItem } from '../../shared/agent/port'
import {
  CONTINUED_NODE_MESSAGE,
  type RunNode,
  type RunRecord
} from '../../shared/workflows/run'
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
      title: 'replay module build',
      working: false,
      fresh: false
    }
  ]
}

const ENOENT = "Error: ENOENT: no such file or directory, open 'src/main/workflows/replay.ts'"

function nodeOf(overrides: Partial<RunNode> & { id: string }): RunNode {
  return {
    status: 'complete',
    parents: [],
    reads: [],
    artifacts: [],
    startedAt: '2026-08-20T10:00:00.000Z',
    endedAt: '2026-08-20T10:04:00.000Z',
    ...overrides
  }
}

/** The mock's failed run: three nodes done, `fixer-1` dead on an ENOENT. */
function runOf(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: '779a',
    workflow: 'build',
    status: 'failed',
    workspacePath: '/repos/crucible',
    workspaceName: 'crucible',
    sessionId: 's1',
    worktreePath: '/repos/crucible/.crucible/worktrees/run-779a',
    branch: 'crucible/run-779a',
    baseCommit: 'eef0559abcdef',
    inputs: {},
    error: ENOENT,
    nodes: [
      nodeOf({ id: 'plan', cost: 0.61 }),
      nodeOf({ id: 'implement', parents: ['plan'], cost: 2.2 }),
      nodeOf({
        id: 'fixer-1',
        parents: ['implement'],
        status: 'failed',
        cost: 0.87,
        error: ENOENT,
        sessionToken: '/state/workflow-runs/779a/sessions/3.jsonl',
        startedAt: '2026-08-20T10:20:00.000Z',
        endedAt: '2026-08-20T10:31:00.000Z'
      })
    ],
    createdAt: '2026-08-20T10:00:00.000Z',
    startedAt: '2026-08-20T10:00:00.000Z',
    endedAt: '2026-08-20T10:31:00.000Z',
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

async function openRun(
  runs: readonly RunRecord[],
  prepare?: (scripted: ReturnType<typeof createScriptedWorkflowRuns>) => void
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

const view = (): HTMLElement => screen.getByLabelText('Run 779a')

const banner = (): HTMLElement | null => view().querySelector('.rvwhy')

const headerButtons = (): string[] =>
  [...view().querySelectorAll('.rvtop button')].map((button) => button.textContent ?? '')

const click = async (name: string): Promise<void> => {
  await act(async () => {
    fireEvent.click(within(view().querySelector('.rvtop') as HTMLElement).getByText(name))
    await settled()
  })
}

describe('a failed run', () => {
  it('offers Resume as the primary and Start node over beside it', async () => {
    await openRun([runOf()])

    expect(headerButtons()).toEqual([
      'Go to session',
      'Resume',
      'Start node over',
      'Investigate',
      'esc'
    ])
    // The one primary: Go to session goes quiet while a stop is showing.
    expect(
      [...view().querySelectorAll('.rvtop button.primary')].map((one) => one.textContent)
    ).toEqual(['Resume'])
    expect(view().querySelector('.rvtop .stat')?.className).toContain('failed')
  })

  it('names the stop, quotes the recorded error and says what each button does', async () => {
    await openRun([runOf()])

    const said = banner()
    expect(said?.className).toContain('failed')
    expect(said?.textContent).toContain('This run failed at fixer-1.')
    expect(said?.textContent).toContain('Its worktree is left as it stands.')
    // Quoted where it can be read, once in the banner and once in the node facts.
    expect(said?.querySelector('.quote')?.textContent).toBe(ENOENT)
    expect(view().querySelector('.dhead .nodeerror')?.textContent).toBe(ENOENT)

    const acts = said?.querySelector('.acts')?.textContent ?? ''
    expect(acts).toContain(
      'Resume continues the failed node — fixer-1 — from its last turn, in the same worktree, ' +
        'reporting to the same session, so nothing it already spent is spent again.'
    )
    expect(acts).toContain(
      'Start node over runs the failed node — fixer-1 — again from its prompt with no memory ' +
        'of this attempt, as fixer-1·r1.'
    )
  })

  it('sends each button’s own act, and holds both while one is in flight', async () => {
    const { workflowRuns } = await openRun([runOf()])

    await click('Start node over')
    expect(workflowRuns.calls).toContainEqual({
      op: 'resume',
      args: ['779a', 'clean-restart']
    })
    // No dialog: the click is the spend authorization, as it is for Resume.
    expect(screen.queryByRole('dialog')).toBeNull()

    await click('Resume')
    expect(workflowRuns.calls).toContainEqual({ op: 'resume', args: ['779a', 'continue'] })
  })

  it('takes both buttons out of reach from the click to the answer', async () => {
    let land = (): void => {}
    let asked = 0
    await openRun([runOf()], (scripted) => {
      scripted.resume = async () => {
        asked += 1
        await new Promise<void>((resolve) => {
          land = resolve
        })
      }
    })

    await act(async () => {
      fireEvent.click(within(view().querySelector('.rvtop') as HTMLElement).getByText('Resume'))
      await settled()
    })
    const held = (name: string): boolean =>
      (within(view().querySelector('.rvtop') as HTMLElement).getByText(name) as HTMLButtonElement)
        .disabled
    expect(held('Resume')).toBe(true)
    expect(held('Start node over')).toBe(true)

    await act(async () => {
      land()
      await settled()
    })
    expect(held('Resume')).toBe(false)
    expect(held('Start node over')).toBe(false)
    expect(asked).toBe(1)
  })

  it('reports a refusal and gives the buttons back', async () => {
    await openRun([runOf()], (scripted) => {
      scripted.resume = async () => {
        throw new Error('The run "779a" cannot resume: its worktree is gone.')
      }
    })

    await click('Start node over')
    expect(screen.getByRole('alert')).toHaveTextContent('its worktree is gone')
    expect(
      (
        within(view().querySelector('.rvtop') as HTMLElement).getByText(
          'Start node over'
        ) as HTMLButtonElement
      ).disabled
    ).toBe(false)
  })

  // The other half of the honesty the interrupted banner already keeps: a
  // record with no session on disk cannot be continued, and the banner must
  // not promise it.
  it('does not promise to continue a node whose session is not on disk', async () => {
    const run = runOf()
    await openRun([
      {
        ...run,
        nodes: run.nodes.map((node) =>
          node.id === 'fixer-1' ? { ...node, sessionToken: undefined } : node
        )
      }
    ])

    const acts = banner()?.querySelector('.acts')?.textContent ?? ''
    expect(acts).toContain(
      'Resume runs the failed node — fixer-1 — again from its prompt, in the same worktree, ' +
        'reporting to the same session: no session of its own is on disk to continue from.'
    )
    expect(acts).not.toContain('continues')
  })
})

describe('a cancelled run', () => {
  const cancelled = (): RunRecord =>
    runOf({
      status: 'cancelled',
      error: undefined,
      nodes: runOf().nodes.map((node) =>
        node.id === 'fixer-1' ? { ...node, error: undefined } : node
      )
    })

  it('wears the same shape with a quieter first sentence and nothing quoted', async () => {
    await openRun([cancelled()])

    expect(headerButtons()).toEqual([
      'Go to session',
      'Resume',
      'Start node over',
      'Investigate',
      'esc'
    ])
    const said = banner()
    expect(said?.className).toContain('cancelled')
    expect(said?.textContent).toContain('This run was cancelled at fixer-1.')
    expect(said?.querySelector('.quote')).toBeNull()
    // One vocabulary: the acts are word for word the failed run's, bar the stop.
    expect(said?.querySelector('.acts')?.textContent).toContain(
      'Resume continues the cancelled node — fixer-1 — from its last turn'
    )
    expect(said?.querySelector('.acts')?.textContent).toContain(
      'Start node over runs the cancelled node — fixer-1 — again from its prompt'
    )
  })
})

describe('one vocabulary over every stop', () => {
  // Reproduction for review-1's finding. Both briefs rule that failed,
  // cancelled and interrupted "differ only in the banner's first sentence and
  // tint", and the mock's sections 1 and 2 print the same acts sentence for
  // both, naming the node and never the stop. The built banner spells the
  // run's status into every act sentence ("the failed node", "the cancelled
  // node"), which is a second difference — and on a run with more than one
  // stopped node it puts the run's word on records that stopped another way.
  it('says the same thing about the two acts, whichever stop it was', async () => {
    const acts = async (run: RunRecord): Promise<string> => {
      await openRun([run])
      const said = banner()?.querySelector('.acts')?.textContent ?? ''
      cleanup()
      return said
    }
    const failed = await acts(runOf())
    const cancelled = await acts(
      runOf({
        status: 'cancelled',
        error: undefined,
        nodes: runOf().nodes.map((node) =>
          node.id === 'fixer-1' ? { ...node, error: undefined } : node
        )
      })
    )

    expect(cancelled).toBe(failed)
  })
})

describe('a run that stopped between nodes', () => {
  // Nothing was mid-flight, so there is no attempt to start over and the
  // engine has none to act on: the button is not offered rather than offered
  // and refused.
  it('offers Resume alone, and says so', async () => {
    await openRun([
      runOf({
        error: 'the workflow file threw after implement completed',
        nodes: [nodeOf({ id: 'plan' }), nodeOf({ id: 'implement', parents: ['plan'] })]
      })
    ])

    expect(headerButtons()).toEqual(['Go to session', 'Resume', 'Investigate', 'esc'])
    const acts = banner()?.querySelector('.acts')?.textContent ?? ''
    expect(acts).toContain(
      'Resume puts this run back to work in the same worktree, reporting to the same session.'
    )
    expect(acts).toContain('Resume is the only act here')
    expect(acts).not.toContain('Start node over')
  })
})

describe('a complete run', () => {
  it('offers neither act, and shows no banner', async () => {
    await openRun([
      runOf({
        status: 'complete',
        error: undefined,
        nodes: runOf().nodes.map((node) =>
          node.id === 'fixer-1' ? { ...node, status: 'complete' as const, error: undefined } : node
        )
      })
    ])

    expect(headerButtons()).toEqual(['Go to session', 'Investigate', 'esc'])
    expect(banner()).toBeNull()
  })
})

describe('the seams in a node’s transcript', () => {
  const SAID: readonly TranscriptItem[] = [
    { kind: 'assistant', markdown: 'moving the replay into its own module' },
    { kind: 'tool', name: 'bash', summary: 'git mv …', ok: false, output: 'ENOENT' }
  ]

  it('closes a stopped node where it stopped', async () => {
    await openRun([runOf()], (scripted) => {
      scripted.transcripts.set('779a:fixer-1', SAID)
    })

    const rules = [...view().querySelectorAll('.txrule')]
    expect(rules).toHaveLength(1)
    expect(rules[0].className).toContain('failed')
    expect(rules[0].textContent).toMatch(/^failed here · .+ ago$/)
  })

  it('marks where a resume picked the node up again, and drops the banner', async () => {
    const run = runOf()
    const working: RunRecord = {
      ...run,
      status: 'running',
      error: undefined,
      endedAt: undefined,
      nodes: run.nodes.map((node) =>
        node.id === 'fixer-1'
          ? { ...node, status: 'running' as const, error: undefined, endedAt: undefined }
          : node
      )
    }
    await openRun([working], (scripted) => {
      scripted.transcripts.set('779a:fixer-1', [
        ...SAID,
        { kind: 'user', text: CONTINUED_NODE_MESSAGE },
        { kind: 'assistant', markdown: 'the git mv never landed; moving it plainly' }
      ])
    })

    // The banner is gone the moment the run is live again, and the seam is
    // where the transcript picks up.
    expect(banner()).toBeNull()
    const rules = [...view().querySelectorAll('.txrule')]
    expect(rules).toHaveLength(1)
    expect(rules[0].className).toContain('resumed')
    expect(rules[0].textContent).toBe('resumed · picked up from here')
    expect(headerButtons()).toEqual(['Go to session', 'Pause', 'Cancel', 'Investigate', 'esc'])
  })
})
