// @vitest-environment jsdom
//
// The rules board and its doors: the top-bar chip, the run strip's chip, the
// rule marks on tool calls, and the notes a rule delivered. Driven through the
// rules seam over canned ledger lines, because the ledger is all the board
// may read: nothing here reaches a judge or an agent.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShellSnapshot } from '../../shared/agent/port'
import type { LedgerLine } from '../../shared/rules/ledger'
import type { RunNode, RunRecord } from '../../shared/workflows/run'
import { Shell } from './Shell'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedPort, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkflowRuns } from './testing/scripted-workflow-runs'
import {
  catalogLine,
  COMMENTS,
  createScriptedRules,
  escalatedOpen,
  inNode,
  NO_CONSOLE,
  NOTE_TEXT,
  notedAndFixed,
  PINNED,
  PROMPTS,
  shadowPass,
  steeredOpen,
  tenDaysOld,
  threw,
  type ScriptedRules
} from './testing/scripted-rules'
import { createScriptedWorkspace, type ScriptedWorkspace } from './testing/scripted-workspace'
import { sessionRows } from './testing/sidebar'
import { settled } from './testing/settled'

const HERE = '/repos/crucible'
const AWAY = '/repos/resume-site'

const SNAPSHOT: ShellSnapshot = {
  workspaces: [
    { id: 'w1', name: 'crucible', path: HERE },
    { id: 'w2', name: 'resume-site', path: AWAY }
  ],
  activeWorkspaceId: 'w1',
  activeSessionId: 's1',
  sessions: [
    { id: 's1', workspaceId: 'w1', createdAt: '2026-09-23T10:00:00.000Z', title: 'rules board', working: false, fresh: false },
    { id: 's2', workspaceId: 'w1', createdAt: '2026-09-13T10:00:00.000Z', title: 'older work', working: false, fresh: false },
    { id: 's3', workspaceId: 'w2', createdAt: '2026-09-23T10:00:00.000Z', title: 'resume', working: false, fresh: false }
  ]
}

/** Every kind of row the board draws, in one workspace. */
function everything(): LedgerLine[] {
  return [
    catalogLine([COMMENTS, PROMPTS, NO_CONSOLE, PINNED]),
    ...tenDaysOld('s2'),
    ...notedAndFixed('s1'),
    ...shadowPass('s1'),
    ...steeredOpen('s1'),
    ...threw('s1')
  ]
}

interface Rig {
  readonly port: ScriptedPort
  readonly rules: ScriptedRules
  readonly workspace: ScriptedWorkspace
}

/** `null` is a workspace with no `.crucible/rules/`. */
async function mount(lines: readonly LedgerLine[] | null = everything()): Promise<Rig> {
  const port = createScriptedPort(SNAPSHOT)
  const rules = createScriptedRules(lines === null ? {} : { [HERE]: lines })
  const workspace = createScriptedWorkspace()
  render(<Shell port={port} workspace={workspace} commands={createScriptedCommands()} rules={rules} />)
  await act(settled)
  return { port, rules, workspace }
}

const chip = (): HTMLElement | null => screen.queryByRole('button', { name: 'Rules board' })

const board = (): HTMLElement => screen.getByRole('dialog', { name: 'Rules board' })

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element)
    await settled()
  })
}

async function openBoard(lines: readonly LedgerLine[] = everything()): Promise<Rig> {
  const rig = await mount(lines)
  await click(chip()!)
  return rig
}

function ruleRow(name: string): HTMLElement {
  return within(board()).getByRole('button', { name: `Rule ${name}` })
}

/** The chosen rule's firings, by the label each row carries, top to bottom. */
function firingRows(rule: string): string[] {
  const group = within(board()).getByLabelText(`Firings of ${rule}`)
  return [...group.querySelectorAll('.frow')].map((row) => row.getAttribute('aria-label') ?? '')
}

const pane = (): HTMLElement => within(board()).getByRole('complementary', { name: 'Firing' })

const section = (name: string): HTMLElement => within(pane()).getByLabelText(name)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the rules chip', () => {
  it('is absent for a workspace with no .crucible/rules/', async () => {
    await mount(null)
    expect(chip()).toBeNull()
  })

  it('counts the rules, and lights only while a rule is broken', async () => {
    const { rules } = await mount([catalogLine([COMMENTS, PROMPTS]), ...notedAndFixed('s1')])
    expect(chip()).toHaveTextContent('§ 2 rules')
    expect(chip()).not.toHaveClass('lit')

    await act(async () => {
      rules.append(HERE, [catalogLine([COMMENTS, PROMPTS, NO_CONSOLE]), ...threw('s1')])
      await settled()
    })
    expect(chip()).toHaveTextContent('§ 3 rules · 1 broken')
    expect(chip()).toHaveClass('lit')
  })

  it('counts an open escalation without lighting', async () => {
    await mount([catalogLine([COMMENTS]), ...escalatedOpen('s1')])
    expect(chip()).toHaveTextContent('1 escalated')
    expect(chip()).not.toHaveClass('lit')
  })

  it('lights for a judge that cannot be reached', async () => {
    await mount([
      catalogLine([COMMENTS]),
      {
        v: 1,
        type: 'firing',
        id: 'f-down',
        at: new Date().toISOString(),
        rule: 'comments',
        mode: 'enforce',
        trigger: 'edit',
        agent: { kind: 'session', sessionId: 's1' },
        where: 'src/a.ts',
        action: 'log',
        delivery: 'none',
        tookMs: 5000,
        skip: { kind: 'judge-unreachable', message: 'api.typesafe.ai timed out' }
      }
    ])
    expect(chip()).toHaveTextContent('judge unreachable')
    expect(chip()).toHaveClass('lit')
  })

  it('follows the workspace: none for one without rules', async () => {
    await mount()
    expect(chip()).not.toBeNull()
    await click(sessionRows().find((row) => row.textContent?.includes('resume'))!)
    expect(chip()).toBeNull()
  })
})

describe('the rules board', () => {
  it('opens from the chip in the overlay region and closes on Esc', async () => {
    await openBoard()
    expect(board()).toHaveTextContent('in crucible')
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
      await settled()
    })
    expect(screen.queryByRole('dialog', { name: 'Rules board' })).toBeNull()
  })

  it('puts a broken rule under Needs attention', async () => {
    await openBoard()
    const attention = within(board()).getByLabelText('Needs attention')
    expect(attention).toHaveTextContent('no-console')
    expect(attention).toHaveTextContent("skipped 1 time on edit · Cannot read properties of undefined (reading 'text')")
    expect(attention).not.toHaveTextContent('comments')
  })

  it('lists every rule with what reached it, what it decided, what came of it, what it took and cost', async () => {
    await openBoard()
    const comments = ruleRow('comments')
    expect(comments).toHaveTextContent('1 admitted')
    expect(comments).toHaveTextContent('2 judged · 0 nothing to judge')
    expect(comments).toHaveTextContent('2 note')
    expect(comments).toHaveTextContent('1 fixed')
    expect(comments).toHaveTextContent('1 open')
    expect(comments).toHaveTextContent('p50')
    expect(comments).toHaveTextContent('$0.00082')
    expect(comments).toHaveTextContent('/mo')

    expect(ruleRow('no-console')).toHaveTextContent('1 skipped · broken')
    expect(ruleRow('no-console')).toHaveTextContent('decided · no judge')
    expect(ruleRow('no-console')).toHaveTextContent('$0')
  })

  it('says what a shadow rule would have done, and that nothing was delivered', async () => {
    await openBoard()
    const shadow = ruleRow('prompts-live-in-files')
    expect(shadow).toHaveTextContent('1 would note')
    expect(shadow).toHaveTextContent('nothing delivered')

    await click(shadow)
    expect(firingRows('prompts-live-in-files')).toEqual([
      'prompts-live-in-files would note at src/shared/agent/port.ts:12'
    ])
    expect(section('What the agent read')).toHaveTextContent('shadow · nothing delivered')
    expect(section('What the agent read')).toHaveTextContent('would have read')
    expect(section('What the agent read')).toHaveTextContent('move it into a file under resources/')
    expect(section('What came of it')).toHaveTextContent('outcome open')
  })

  it('dims an off rule and shows no numbers for it', async () => {
    await openBoard()
    const off = ruleRow('pinned-deps')
    expect(off).toHaveClass('off')
    expect(off).not.toHaveTextContent('admitted')
    expect(off).not.toHaveTextContent('$')
  })

  it("lists the chosen rule's firings newest first, skips that mean something is wrong among them", async () => {
    await openBoard()
    expect(firingRows('comments')).toEqual([
      'comments note at src/shared/agent/port.ts:120',
      'comments note at src/shared/agent/port.ts:98'
    ])
    await click(ruleRow('no-console'))
    expect(firingRows('no-console')).toEqual(['no-console skipped at src/shared/agent/port.ts'])
  })

  it('reads one firing whole: what was judged, what the judge said, what the agent read, did next, and what came of it', async () => {
    await openBoard()
    await click(within(board()).getByRole('button', { name: 'comments note at src/shared/agent/port.ts:98' }))

    expect(pane().querySelector('.rhead h3 .path')).toHaveTextContent('src/shared/agent/port.ts:98')
    expect(section('What was judged').querySelector('.codebox .hl')).toHaveTextContent(
      '// Loop over the listeners and call each one'
    )
    expect(section('What was judged')).toHaveTextContent('edit · 3 lines added')

    const said = section('What the judge said')
    expect(said).toHaveTextContent('jev-1.13.0 · 412 tokens · $0.00041 · 380ms')
    expect(said).toHaveTextContent('narrates0.91')
    expect(said).toHaveTextContent('explains_why0.06')
    expect(said).toHaveTextContent('other0.03')

    const read = section('What the agent read')
    expect(read).toHaveTextContent('appended to the edit result')
    expect(read).toHaveTextContent(`§ Rule "comments" (AGENTS.md#comments): ${NOTE_TEXT}`)

    const next = section('What the agent did next')
    expect(next).toHaveTextContent('"Dropping that comment: the loop already says what it does."')
    expect(next).toHaveTextContent('edit src/shared/agent/port.ts')
    expect(next.querySelector('.del')).toHaveTextContent('- // Loop over the listeners and call each one')

    expect(section('What came of it')).toHaveTextContent('outcome fixed · at the next edit of this file')
  })

  it('shows the whole workspace for the default 7 days, and further back when asked', async () => {
    await openBoard()
    expect(firingRows('comments')).toHaveLength(2)
    await click(within(board()).getByRole('button', { name: '30 days' }))
    expect(firingRows('comments')).toHaveLength(3)
    expect(within(board()).getByRole('button', { name: '30 days' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('narrows to this session', async () => {
    await openBoard()
    await click(within(board()).getByRole('button', { name: 'all' }))
    expect(firingRows('comments')).toHaveLength(3)
    await click(within(board()).getByRole('button', { name: 'this session' }))
    expect(firingRows('comments')).toHaveLength(2)
  })

  it('updates as the ledger grows', async () => {
    const { rules } = await openBoard([catalogLine([COMMENTS]), ...steeredOpen('s1')])
    expect(firingRows('comments')).toHaveLength(1)
    await act(async () => {
      rules.append(HERE, notedAndFixed('s1'))
      await settled()
    })
    expect(firingRows('comments')).toHaveLength(2)
  })

  it('explains the item in the terminal with the runner', async () => {
    const { workspace } = await openBoard()
    await click(within(board()).getByRole('button', { name: 'comments note at src/shared/agent/port.ts:98' }))
    await click(within(pane()).getByRole('button', { name: 'Explain in terminal' }))
    expect(workspace.calls).toContainEqual({
      op: 'startRun',
      args: [expect.any(String), 'crucible rules explain comments src/shared/agent/port.ts:98']
    })
    expect(screen.queryByRole('dialog', { name: 'Rules board' })).toBeNull()
  })

  it('copies the content key', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await openBoard()
    await click(within(board()).getByRole('button', { name: 'comments note at src/shared/agent/port.ts:98' }))
    await click(within(pane()).getByRole('button', { name: 'Copy key' }))
    expect(writeText).toHaveBeenCalledWith('a1b2c3d4e5f6a7b8')
  })

  it('offers no control that would change a rule', async () => {
    await openBoard()
    const labels = within(board())
      .getAllByRole('button')
      .map((button) => button.textContent ?? '')
    for (const verb of [/enable/i, /disable/i, /dismiss/i, /reset/i, /enforce/i, /mute/i]) {
      expect(labels.filter((label) => verb.test(label) && !label.startsWith('enforce'))).toEqual([])
    }
  })
})

describe('the session door', () => {
  async function withCalls(): Promise<Rig> {
    const rig = await mount()
    await act(async () => {
      await rig.port.prompt('s1', 'tidy the port')
    })
    act(() => {
      rig.port.toolStarted('s1', 'c1', 'edit', 'src/shared/agent/port.ts')
      rig.port.toolEnded('s1', 'c1', true, `Edited src/shared/agent/port.ts (+3 −0)\n\n§ Rule "comments" (AGENTS.md#comments): ${NOTE_TEXT}`)
      rig.port.toolStarted('s1', 'c2', 'edit', 'src/shared/agent/port.ts')
      rig.port.toolEnded('s1', 'c2', true, 'Edited src/shared/agent/port.ts (+1 −0)')
    })
    await act(settled)
    return rig
  }

  it('marks each judged tool call, shadow marks among them', async () => {
    await withCalls()
    fireEvent.click(screen.getByRole('button', { name: /^Tool chain/ }))
    expect(screen.getAllByRole('button', { name: '§ comments · note' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: '§ comments · note' })[0]).toHaveClass('rulemark')
    expect(screen.getByRole('button', { name: '§ prompts-live-in-files · would note' })).toHaveClass('shadow')
    expect(screen.getByRole('button', { name: '§ no-console · skipped' })).toBeInTheDocument()
  })

  it('shows an inline note inside the tool result, once', async () => {
    await withCalls()
    fireEvent.click(screen.getByRole('button', { name: /^Tool chain/ }))
    fireEvent.click(screen.getAllByRole('button', { name: /edit src\/shared\/agent\/port\.ts/ })[0]!)
    const out = document.querySelector('.toolout')!
    expect(out.querySelector('.rulenote')).toHaveTextContent(`§ comments ${NOTE_TEXT}`)
    expect(out.textContent?.split(NOTE_TEXT)).toHaveLength(2)
    expect(out).toHaveTextContent('Edited src/shared/agent/port.ts (+3 −0)')
  })

  it('shows a steered note as its own message after the chain', async () => {
    await withCalls()
    const steered = screen.getByLabelText('Rule note from comments')
    expect(steered).toHaveTextContent('§ comments · steered · 2.10s')
    expect(steered).toHaveTextContent('restates the type below it')
    expect(steered.closest('li')?.previousElementSibling?.querySelector('.chain')).not.toBeNull()
  })

  it('opens the board on the firing a mark names, scoped to the session', async () => {
    await withCalls()
    fireEvent.click(screen.getByRole('button', { name: /^Tool chain/ }))
    await click(screen.getAllByRole('button', { name: '§ comments · note' })[0]!)
    expect(within(board()).getByRole('button', { name: 'this session' })).toHaveAttribute('aria-pressed', 'true')
    expect(pane().querySelector('.rhead h3 .path')).toHaveTextContent('src/shared/agent/port.ts:98')
  })

  it("counts the session's firings on the run strip, and opens the board scoped to it", async () => {
    await withCalls()
    const fired = screen.getByRole('button', { name: /fired here/ })
    expect(fired).toHaveTextContent('§ 4 fired here · 2 open')
    await click(fired)
    expect(within(board()).getByRole('button', { name: 'this session' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('opens the conversation at the call a firing judged', async () => {
    await withCalls()
    await click(chip()!)
    await click(within(board()).getByRole('button', { name: 'comments note at src/shared/agent/port.ts:98' }))
    await click(within(pane()).getByRole('button', { name: /Open in the conversation/ }))
    expect(screen.queryByRole('dialog', { name: 'Rules board' })).toBeNull()
    expect(screen.getAllByRole('button', { name: '§ comments · note' })[0]).toBeVisible()
  })
})

describe('the run view door', () => {
  function node(id: string, parents: string[]): RunNode {
    return {
      id,
      status: 'complete',
      parents,
      reads: [],
      artifacts: [],
      startedAt: '2026-09-23T10:00:00.000Z',
      endedAt: '2026-09-23T10:12:00.000Z'
    }
  }

  const RUN: RunRecord = {
    id: 'e7a2',
    workflow: 'build',
    status: 'complete',
    workspacePath: HERE,
    workspaceName: 'crucible',
    sessionId: 's1',
    branch: 'crucible/run-e7a2',
    inputs: {},
    nodes: [node('planner', []), node('builder', ['planner']), node('review', ['builder'])],
    createdAt: '2026-09-23T10:00:00.000Z',
    startedAt: '2026-09-23T10:00:00.000Z',
    endedAt: '2026-09-23T10:40:00.000Z'
  }

  async function openRun(): Promise<void> {
    const port = createScriptedPort(SNAPSHOT)
    const workflowRuns = createScriptedWorkflowRuns([RUN])
    workflowRuns.transcripts.set('e7a2:builder', [
      { kind: 'tool', callId: 'n1', name: 'edit', summary: 'src/renderer/src/runs/flow.ts', ok: true, output: 'Edited' }
    ])
    const rules = createScriptedRules({
      [HERE]: [
        catalogLine([COMMENTS]),
        ...inNode('e7a2', 'builder'),
        ...inNode('e7a2', 'builder', 'f-node-2', 'n2'),
        ...inNode('e7a2', 'review', 'f-node-3', 'r1'),
        ...inNode('other', 'builder', 'f-elsewhere', 'x1')
      ]
    })
    render(
      <Shell
        port={port}
        workspace={createScriptedWorkspace()}
        commands={createScriptedCommands()}
        workflowRuns={workflowRuns}
        rules={rules}
      />
    )
    await act(settled)
    await act(async () => {
      fireEvent.keyDown(document, { key: 'r', metaKey: true })
      await settled()
    })
    await click(screen.getByRole('button', { name: 'Open run' }))
  }

  const card = (id: string): HTMLElement =>
    [...document.querySelectorAll<HTMLElement>('.nd')].find((found) => found.querySelector('.nm')?.textContent === id)!

  it("counts each node's firings on its card, and the run's in its header", async () => {
    await openRun()
    expect(card('builder').querySelector('.rm')).toHaveTextContent('§ 2')
    expect(card('review').querySelector('.rm')).toHaveTextContent('§ 1')
    expect(card('planner').querySelector('.rm')).toBeNull()
    expect(document.querySelector('.rulecount')).toHaveTextContent('§ 3 rule firings · 3 open')
  })

  it("gives the node pane a rules tab listing that node's firings, each a door to the board scoped to the run", async () => {
    await openRun()
    await click(card('builder'))
    const tab = screen.getByRole('tab', { name: '§ rules · 2' })
    await click(tab)
    expect(tab).toHaveAttribute('aria-selected', 'true')
    const list = screen.getByLabelText('Rule firings in this node')
    expect(list.querySelectorAll('.frow')).toHaveLength(2)
    expect(list).toHaveTextContent('2 firings in this node')

    await click(list.querySelector<HTMLElement>('.frow')!)
    expect(within(board()).getByRole('button', { name: 'run e7a2' })).toHaveAttribute('aria-pressed', 'true')
    expect(firingRows('comments')).toHaveLength(3)

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
      await settled()
    })
    expect(screen.queryByRole('dialog', { name: 'Rules board' })).toBeNull()
    expect(screen.getByRole('tablist', { name: 'Node pane' })).toBeInTheDocument()
  })

  it("marks the judged call in a node's transcript", async () => {
    await openRun()
    await click(card('builder'))
    fireEvent.click(screen.getByRole('button', { name: /^Tool chain/ }))
    expect(screen.getByRole('button', { name: '§ comments · note' })).toHaveClass('rulemark')
  })
})
