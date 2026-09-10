// @vitest-environment jsdom
//
// A summarizing jump belongs to the session that started it: its spinner, its
// narration, its failure and its confirmation. No spinner, error, toast or
// overlay may render in a session other than the one that produced it, and a
// summary that fails never leaves the user thinking the jump happened.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { SessionTree, ShellSnapshot, TranscriptItem } from '../../shared/agent/port'
import { Shell } from './Shell'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedPort, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { sessionRows, sessionsShown } from './testing/sidebar'
import { settled } from './testing/settled'

const NOW = '2026-08-21T14:14:00.000Z'

const TWO_SESSIONS: ShellSnapshot = {
  workspaces: [{ id: 'w1', name: 'crucible', path: '/repos/crucible' }],
  activeWorkspaceId: 'w1',
  sessions: [
    { id: 's1', workspaceId: 'w1', createdAt: NOW, title: 'session A', working: false, fresh: false },
    { id: 's2', workspaceId: 'w1', createdAt: NOW, title: 'session B', working: false, fresh: false }
  ],
  activeSessionId: 's1'
}

function treeOf(text: string): SessionTree {
  return {
    roots: [
      {
        ref: 'n1',
        text: 'Scaffold the overlay.',
        at: NOW,
        children: [{ ref: 'n2', text, at: NOW, children: [] }]
      }
    ],
    path: ['n1', 'n2']
  }
}

const A_NODE = 'Hook the overlay up to ⌘O.'
const B_NODE = 'Polish the quota strip.'

const A_TRANSCRIPT: readonly TranscriptItem[] = [
  { kind: 'user', text: 'Scaffold the overlay.' },
  { kind: 'assistant', markdown: 'session A speaking' }
]

const B_TRANSCRIPT: readonly TranscriptItem[] = [
  { kind: 'assistant', markdown: 'session B speaking' }
]

async function shell(): Promise<ScriptedPort> {
  const port = createScriptedPort(TWO_SESSIONS)
  port.models = [{ id: 'fake/deterministic', label: 'Fake', thinkingLevels: ['off'] }]
  port.trees.set('s1', treeOf(A_NODE))
  port.trees.set('s2', treeOf(B_NODE))
  port.transcripts.set('s1', A_TRANSCRIPT)
  port.transcripts.set('s2', B_TRANSCRIPT)
  render(
    <Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
    />
  )
  await sessionsShown()
  await settled()
  return port
}

const overlay = (): HTMLElement | null => screen.queryByRole('dialog', { name: 'Session tree' })

const tree = (): HTMLElement => screen.getByRole('dialog', { name: 'Session tree' })

const note = (): string => document.querySelector('.actnote')?.textContent ?? ''

/** The same narration in the composer's slot, which is where it goes with the tree gone. */
const line = (): string => document.querySelector('.jumpline')?.textContent ?? ''

async function closeTree(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'esc close' }))
  })
}

const composer = (): HTMLElement => screen.getByLabelText('Message')

/** Double-Esc, the session tree's only way in. */
async function openTree(): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(document, { key: 'Escape' })
  })
  await act(async () => {
    fireEvent.keyDown(document, { key: 'Escape' })
  })
  await settled()
}

async function switchTo(row: number): Promise<void> {
  await act(async () => {
    fireEvent.click(sessionRows()[row] as HTMLElement)
  })
  await settled()
}

/** Opens the tree, opens the node's card, and asks for the summarizing jump. */
async function summarize(node: string): Promise<void> {
  await openTree()
  await act(async () => {
    fireEvent.click(screen.getByText(node))
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Continue with summary/ }))
  })
  await settled()
}

describe('a failure belongs to one session', () => {
  it('shows in the session that raised it, and clears when the user leaves', async () => {
    const port = await shell()
    port.jumpRefusal = 'That session is working. Stop it first.'
    await openTree()
    await act(async () => {
      fireEvent.click(screen.getByText(A_NODE))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Continue from here/ }))
    })
    await settled()
    expect(screen.getByRole('alert')).toHaveTextContent('Stop it first')

    await switchTo(1)
    expect(screen.queryByRole('alert')).toBeNull()

    // Leaving cleared it, so coming back is a clean session rather than a
    // banner waiting to be read twice.
    await switchTo(0)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('a confirmation belongs to one session', () => {
  it('never renders over another session', async () => {
    const port = await shell()
    port.holdJump = true
    port.jumpText = A_NODE
    await summarize(A_NODE)

    await switchTo(1)
    await act(async () => {
      port.settleJump('jumped')
    })
    await settled()

    // The toast was earned in A: B says nothing about it.
    expect(screen.queryByRole('status')).toBeNull()

    await switchTo(0)
    expect(screen.getByRole('status')).toHaveTextContent('Jumped with summary')
  })
})

describe('a busy state belongs to one session', () => {
  it('leaves the other session clean and fully usable', async () => {
    const port = await shell()
    port.holdJump = true
    await summarize(A_NODE)
    expect(note()).toContain('Summarizing the branch you are leaving…')

    await switchTo(1)
    await openTree()
    await act(async () => {
      fireEvent.click(screen.getByText(B_NODE))
    })

    // No spinner, no narration, and every jump action live.
    expect(document.querySelector('.actnote.busy')).toBeNull()
    expect(screen.getByRole('button', { name: /Continue from here/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /Continue with summary/ })).toBeEnabled()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Continue from here/ }))
    })
    expect(port.calls).toContainEqual({ op: 'jump', args: ['s2', 'n2', { summarize: false }] })

    // And the session that is paying still says so when the user comes back.
    // In the composer's slot, not the tree: with a summarize in flight and
    // nothing full screen over the session, Escape means stop, so the
    // accelerator never gets its second press.
    await switchTo(0)
    expect(line()).toContain('Summarizing the branch you are leaving…')
  })
})

describe('π retrying, narrated', () => {
  it('says which attempt it is on, in the owning session only', async () => {
    const port = await shell()
    port.holdJump = true
    await summarize(A_NODE)

    await act(async () => {
      port.summarizeRetry('s1', { attempt: 2, maxAttempts: 3, message: 'Overloaded' })
    })
    expect(note()).toContain('Overloaded — retrying (2 of 3)')
    // The spinner stays: π is still working through its own budget.
    expect(document.querySelector('.actnote.busy')).not.toBeNull()

    await switchTo(1)
    await openTree()
    await act(async () => {
      fireEvent.click(screen.getByText(B_NODE))
    })
    expect(note()).not.toContain('retrying')
  })

  it('says nothing at all in a session with no jump of its own', async () => {
    const port = await shell()

    await act(async () => {
      port.summarizeRetry('s1', { attempt: 1, maxAttempts: 3, message: 'Overloaded' })
    })
    await openTree()
    await act(async () => {
      fireEvent.click(screen.getByText(A_NODE))
    })

    expect(note()).not.toContain('retrying')
  })
})

describe('a summarize whose tree is not on screen', () => {
  it('keeps saying it is working, wherever the user goes', async () => {
    const port = await shell()
    port.holdJump = true
    await summarize(A_NODE)

    // The user closed the overlay and went on reading: the call is still
    // running and still says so.
    await closeTree()
    expect(overlay()).toBeNull()
    expect(line()).toContain('Summarizing the branch you are leaving…')

    await act(async () => {
      port.summarizeRetry('s1', { attempt: 2, maxAttempts: 3, message: 'Overloaded' })
    })
    expect(line()).toContain('Overloaded — retrying (2 of 3)')

    // Not a word of it in the session that is not paying.
    await switchTo(1)
    expect(line()).toBe('')

    // Arriving back closed the tree again, and the wait is still said.
    await switchTo(0)
    expect(overlay()).toBeNull()
    expect(line()).toContain('Overloaded — retrying (2 of 3)')

    await act(async () => {
      port.settleJump('jumped')
    })
    await settled()
    expect(line()).toBe('')
  })
})

describe('a summary that failed', () => {
  it('says what failed and that nothing moved, where the jump was attempted', async () => {
    const port = await shell()
    port.jumpRefusal = 'Opus is overloaded'
    port.jumpText = A_NODE
    await summarize(A_NODE)

    expect(note()).toBe(
      'Summary failed — Opus is overloaded. Nothing moved; press s to try again.'
    )
    // Nothing moved: the transcript stands where it stood and the message was
    // not handed back to the composer.
    expect(screen.getByRole('log')).toHaveTextContent('session A speaking')
    expect(composer()).toHaveValue('')
    expect(screen.queryByRole('status')).toBeNull()
    expect(overlay()).not.toBeNull()
    // And the actions are live again, because the retry is the user's.
    expect(screen.getByRole('button', { name: /Continue with summary/ })).toBeEnabled()
  })

  it('is retried by the user pressing s, with the same ref', async () => {
    const port = await shell()
    port.jumpRefusal = 'Opus is overloaded'
    await summarize(A_NODE)
    port.jumpRefusal = undefined
    port.holdJump = true

    await act(async () => {
      fireEvent.keyDown(tree(), { key: 's' })
    })
    await settled()

    expect(port.calls.filter((call) => call.op === 'jump')).toEqual([
      { op: 'jump', args: ['s1', 'n2', { summarize: true }] },
      { op: 'jump', args: ['s1', 'n2', { summarize: true }] }
    ])
    // The failure is gone the moment the retry starts.
    expect(note()).toContain('Summarizing the branch you are leaving…')
  })

  it('survives leaving and coming back, and shows as a banner with the tree closed', async () => {
    const port = await shell()
    port.jumpRefusal = 'Opus is overloaded'
    await summarize(A_NODE)

    await switchTo(1)
    expect(screen.queryByRole('alert')).toBeNull()

    await switchTo(0)
    // The tree is closed on arrival, so the failure reports in the banner
    // position: it is there before anything is reopened.
    expect(overlay()).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Summary failed — Opus is overloaded. Nothing moved; press s to try again.'
    )

    // Reopening the tree moves it back to the node it belongs to, with the
    // card already open.
    await openTree()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(note()).toContain('Summary failed — Opus is overloaded')
  })
})

describe('cancelling a summarize', () => {
  it('acknowledges in the same frame and moves nothing at all', async () => {
    const port = await shell()
    port.holdJump = true
    port.jumpText = A_NODE
    await summarize(A_NODE)

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })

    expect(port.calls).toContainEqual({ op: 'cancel', args: ['s1'] })
    expect(note()).toContain('Cancelling…')
    // The tree it was started from is still open, which is where the user is.
    expect(overlay()).not.toBeNull()

    await act(async () => {
      port.settleJump('cancelled')
    })
    await settled()

    expect(note()).not.toContain('Cancelling…')
    expect(screen.getByRole('button', { name: /Continue with summary/ })).toBeEnabled()
    expect(overlay()).not.toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(composer()).toHaveValue('')
    expect(screen.getByRole('log')).toHaveTextContent('session A speaking')
  })

  // The port may answer cancelled without this document having asked: the
  // rule is the same either way, and it is not a failure.
  it('leaves everything as it was when the port answers cancelled', async () => {
    const port = await shell()
    port.jumpCancelled = true
    port.jumpText = A_NODE
    await summarize(A_NODE)

    expect(overlay()).not.toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(composer()).toHaveValue('')
    expect(screen.getByRole('log')).toHaveTextContent('session A speaking')
    expect(screen.getByRole('button', { name: /Continue with summary/ })).toBeEnabled()
  })

  it('reaches the summarize even with the tree already closed', async () => {
    const port = await shell()
    port.holdJump = true
    await summarize(A_NODE)

    // The user closed the overlay themselves and went on reading; the summary
    // is still running behind it.
    await closeTree()
    expect(overlay()).toBeNull()

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(port.calls).toContainEqual({ op: 'cancel', args: ['s1'] })
    // Answered in the keypress frame, with no tree to answer in.
    expect(line()).toContain('Cancelling…')

    await act(async () => {
      port.settleJump('cancelled')
    })
    await settled()

    // Once, and nothing moved by it.
    expect(line()).toBe('')
    expect(port.calls.filter((call) => call.op === 'cancel')).toHaveLength(1)
    expect(screen.getByRole('log')).toHaveTextContent('session A speaking')
    expect(composer()).toHaveValue('')
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('a jump that settles while the user is elsewhere', () => {
  it('replaces its own session transcript and never the one on screen', async () => {
    const port = await shell()
    port.holdJump = true
    port.jumpText = A_NODE
    await summarize(A_NODE)

    await switchTo(1)
    port.transcripts.set('s1', [
      { kind: 'user', text: 'Scaffold the overlay.' },
      { kind: 'summary', text: 'The abandoned branch was summarized.' }
    ])
    await act(async () => {
      port.settleJump('jumped')
    })
    await settled()

    // B is untouched: its own transcript, its own composer.
    expect(screen.getByRole('log')).toHaveTextContent('session B speaking')
    expect(screen.getByRole('log')).not.toHaveTextContent('summarized')
    expect(composer()).toHaveValue('')

    await switchTo(0)
    expect(screen.getByLabelText('Context summary')).toHaveTextContent(
      'The abandoned branch was summarized.'
    )
    // The message the jump handed back went to its own session's composer.
    expect(composer()).toHaveValue(A_NODE)
  })
})
