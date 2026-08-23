// @vitest-environment jsdom
//
// The cache expiry choice, driven through the scripted port: what a send
// meets when the conversation's cache is certainly gone, and what every door
// out of it does. The typed message survives all of them.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CachedPrefix, SessionTree, ShellSnapshot } from '../../shared/agent/port'
import { Shell } from './Shell'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { sessionRows } from './testing/sidebar'
import { settled } from './testing/settled'

/** Thursday afternoon, and every prefix below is dated from it. */
const NOW = new Date(2026, 7, 20, 15, 4, 0).getTime()

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

/** Mock Y's own conversation: 2h 13m idle, 110k in context, $0.63 to re-bill. */
function prefix(over: Partial<CachedPrefix> = {}): CachedPrefix {
  return {
    at: new Date(NOW - (2 * HOUR + 13 * MINUTE)).toISOString(),
    tokens: 110_000,
    rebillDollars: 0.63,
    retention: '1h',
    ...over
  }
}

/** Two sessions in one workspace, A active, and B's cache gone or not. */
function twoSessions(b: 'expired' | 'fresh'): ShellSnapshot {
  const both = {
    workspaceId: 'w1',
    createdAt: '2026-08-20T10:00:00.000Z',
    working: false,
    fresh: false
  }
  return {
    workspaces: [{ id: 'w1', name: 'crucible', path: '/repos/crucible' }],
    activeWorkspaceId: 'w1',
    sessions: [
      { ...both, id: 's1', title: 'session A', cachedPrefix: prefix() },
      {
        ...both,
        id: 's2',
        title: 'session B',
        ...(b === 'expired' ? { cachedPrefix: prefix() } : {})
      }
    ],
    activeSessionId: 's1'
  }
}

const TREE: SessionTree = {
  roots: [
    {
      ref: 'n1',
      text: 'Scaffold the overlay.',
      at: '2026-08-20T10:00:00.000Z',
      children: [
        { ref: 'n2', text: 'Now the rail.', at: '2026-08-20T11:00:00.000Z', children: [] }
      ]
    }
  ],
  path: ['n1', 'n2']
}

async function mount(snapshot?: Partial<ShellSnapshot>): Promise<ScriptedPort> {
  const port = createScriptedPort(snapshot ?? oneSession({ cachedPrefix: prefix() }))
  port.models = [{ id: 'fake/deterministic', label: 'Fake', thinkingLevels: ['off', 'high'] }]
  port.trees.set('s1', TREE)
  port.transcripts.set('s1', [{ kind: 'assistant', markdown: 'the old conversation' }])
  render(
    <Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
    />
  )
  await settled()
  return port
}

const composer = (): HTMLTextAreaElement => screen.getByLabelText('Message') as HTMLTextAreaElement

const choice = (): HTMLElement | null =>
  screen.queryByRole('dialog', { name: 'The cache for this conversation has expired' })

const waiting = (): HTMLElement | null =>
  screen.queryByRole('dialog', { name: 'Summarizing the conversation' })

const facts = (): string[] =>
  [...document.querySelectorAll('.efact')].map((fact) => fact.textContent ?? '')

const doors = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.edoor')]

const opsOf = (port: ScriptedPort): string[] => port.calls.map((call) => call.op)

/** Types a draft and presses Enter, the way a person sends. */
async function type(text: string): Promise<void> {
  fireEvent.change(composer(), { target: { value: text } })
  await act(async () => {
    fireEvent.keyDown(composer(), { key: 'Enter' })
  })
}

// Enter and S belong to the dialog, which takes focus when it opens: a
// document listener would hear the very Enter that raised it.
async function press(key: string): Promise<void> {
  const dialog = choice() ?? waiting()
  await act(async () => {
    fireEvent.keyDown(dialog ?? document, { key })
  })
  await settled()
}

/** Escape is the shell's, which knows what else is on screen. */
async function escape(): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(document, { key: 'Escape' })
  })
  await settled()
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('when the choice is raised', () => {
  it('states the three facts in the same frame, and sends nothing', async () => {
    const port = await mount()

    await type('Now let us pick up the artifact rail work.')

    expect(choice()).not.toBeNull()
    // Nothing was expanded, cleared or sent: the draft is exactly as typed.
    expect(composer()).toHaveValue('Now let us pick up the artifact rail work.')
    expect(opsOf(port)).not.toContain('prompt')
    expect(facts()).toEqual(['Idle2h 13m', 'In context110k', 'Re-bill~$0.63'])
    // The footer names the setting the prefix was written under.
    expect(document.querySelector('.efoot')?.textContent).toContain('retention 1 hour')
  })

  it('shows a two-cent break its two cents, because there is no floor', async () => {
    await mount(
      oneSession({ cachedPrefix: prefix({ tokens: 3_000, rebillDollars: 0.02 }) })
    )

    await type('carry on')

    expect(facts()).toEqual(['Idle2h 13m', 'In context3.0k', 'Re-bill~$0.02'])
    expect(doors()[0]?.textContent).toContain('+$0.02')
  })

  it('measures the idle time against the retention the prefix carries', async () => {
    // Twenty minutes past π's five, which the hour still covers and the
    // default would not.
    const alive = prefix({ at: new Date(NOW - 20 * MINUTE).toISOString(), retention: '1h' })
    const port = await mount(oneSession({ cachedPrefix: alive }))

    await type('still warm')
    expect(choice()).toBeNull()
    expect(opsOf(port)).toContain('prompt')

    await act(async () => {
      port.endTurn('s1')
      port.update((snapshot) => ({
        ...snapshot,
        sessions: snapshot.sessions.map((session) => ({
          ...session,
          cachedPrefix: { ...alive, retention: '5m' as const }
        }))
      }))
    })

    // The same gap under π's own five minutes is a certain break.
    await type('and now it is gone')
    expect(choice()).not.toBeNull()
  })
})

describe('when it is never raised', () => {
  it('says nothing about a conversation with nothing cached', async () => {
    const port = await mount(oneSession())

    await type('first message of a fresh session')

    expect(choice()).toBeNull()
    expect(port.calls).toContainEqual({
      op: 'prompt',
      args: ['s1', 'first message of a fresh session']
    })
  })

  it('steers a live turn rather than asking about it', async () => {
    const port = await mount(oneSession({ working: true, cachedPrefix: prefix() }))

    await type('turn left')

    // The turn is live, so the cache is warm and this is a steering message.
    expect(choice()).toBeNull()
    expect(port.calls).toContainEqual({ op: 'steer', args: ['s1', 'turn left'] })
  })

  it('leaves a thinking switch to its own confirm', async () => {
    await mount(
      oneSession({
        cachedPrefix: prefix(),
        model: 'fake/deterministic',
        thinkingLevel: 'off'
      })
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Thinking: / }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'high' }))
    })

    // A break the user caused one keystroke ago is a different dialog, and it
    // is untouched.
    expect(choice()).toBeNull()
    expect(screen.getByRole('dialog', { name: "Invalidate this session's cache?" })).toBeTruthy()
  })

  it('never meets a message the run delivered', async () => {
    const port = await mount()

    // A run waking its orchestrator: no human pressed send, so there is
    // nobody to ask and nothing to ask them.
    await act(async () => {
      void port.followUp('s1', 'node planner finished')
    })
    await settled()

    expect(choice()).toBeNull()
  })
})

describe('send anyway', () => {
  it('closes, echoes and prompts, on Enter and on the door alike', async () => {
    const port = await mount()
    await type('the message that was already typed')

    await press('Enter')

    expect(choice()).toBeNull()
    expect(composer()).toHaveValue('')
    expect(screen.getByRole('log')).toHaveTextContent('the message that was already typed')
    expect(port.calls).toContainEqual({
      op: 'prompt',
      args: ['s1', 'the message that was already typed']
    })
  })

  it('hears no key that was not pressed in it', async () => {
    const port = await mount()
    await type('half a thought')

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Enter' })
    })

    // The dialog reads its keys off itself, and it has focus. A listener on
    // the document would hear the very Enter that raised the dialog and
    // answer it in the same press, so the choice would never be seen.
    expect(document.activeElement).toBe(choice())
    expect(choice()).not.toBeNull()
    expect(opsOf(port)).not.toContain('prompt')
  })

  it('sends on the door button too', async () => {
    const port = await mount()
    await type('by mouse this time')

    await act(async () => {
      fireEvent.click(doors()[0] as HTMLElement)
    })

    expect(choice()).toBeNull()
    expect(port.calls).toContainEqual({ op: 'prompt', args: ['s1', 'by mouse this time'] })
  })
})

describe('summarize, then continue', () => {
  it('jumps to before the first message, then sends the typed message', async () => {
    const port = await mount()
    port.holdJump = true
    // What a jump normally hands back to the composer, which this path drops:
    // the typed message is the one going out.
    port.jumpText = 'Scaffold the overlay.'
    await type('Now let us pick up the artifact rail work.')

    await press('s')

    // The whole wait, in the dialog that asked for it.
    expect(waiting()).not.toBeNull()
    expect(waiting()?.textContent).toContain('Reading 110k tokens once')
    expect(port.calls).toContainEqual({
      op: 'jump',
      args: ['s1', 'n1', { summarize: true }]
    })
    expect(opsOf(port)).not.toContain('prompt')

    port.transcripts.set('s1', [
      { kind: 'summary', text: 'Carried forward: the branch was summarized.' }
    ])
    await act(async () => {
      port.settleJump('jumped')
    })
    await settled()

    expect(waiting()).toBeNull()
    expect(choice()).toBeNull()
    // The new path, summary first, and the message sent against it.
    expect(screen.getByLabelText('Context summary')).toHaveTextContent('Carried forward')
    expect(port.calls).toContainEqual({
      op: 'prompt',
      args: ['s1', 'Now let us pick up the artifact rail work.']
    })
    // The composer is empty because the message went out, not because a jump
    // put someone else's text in it.
    expect(composer()).toHaveValue('')
  })

  it('narrates π\u2019s own retry in place of the subtitle', async () => {
    const port = await mount()
    port.holdJump = true
    await type('carry on')
    await press('s')

    await act(async () => {
      port.summarizeRetry('s1', { attempt: 2, maxAttempts: 3, message: 'Overloaded' })
    })

    expect(waiting()?.textContent).toContain('Overloaded — retrying (2 of 3)')
    // One wait state, and it is this one: no second spinner under the dialog.
    expect(document.querySelector('.jumpline')).toBeNull()
  })

  it('leaves everything as it was when the summary fails', async () => {
    const port = await mount()
    port.jumpRefusal = 'Opus is overloaded'
    await type('carry on')

    await press('s')
    await settled()

    expect(waiting()).toBeNull()
    expect(choice()).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent('Opus is overloaded')
    // Nothing moved and nothing was sent: the message is still in the composer.
    expect(composer()).toHaveValue('carry on')
    expect(opsOf(port)).not.toContain('prompt')
    expect(screen.getByRole('log')).toHaveTextContent('the old conversation')
  })
})

describe('escape', () => {
  it('goes back to the composer with the message kept', async () => {
    const port = await mount()
    await type('half a thought')
    const before = port.calls.length

    await escape()

    expect(choice()).toBeNull()
    expect(composer()).toHaveValue('half a thought')
    // Nothing was asked of the port at all.
    expect(port.calls).toHaveLength(before)
    expect(document.activeElement).toBe(composer())
  })

  it('re-asks on the next send, because the cache is still gone', async () => {
    await mount()
    await type('half a thought')
    await escape()

    await act(async () => {
      fireEvent.keyDown(composer(), { key: 'Enter' })
    })

    expect(choice()).not.toBeNull()
  })

  it('stops a summary in flight and moves nothing', async () => {
    const port = await mount()
    port.holdJump = true
    await type('carry on')
    await press('s')

    await escape()

    expect(port.calls).toContainEqual({ op: 'cancel', args: ['s1'] })
    // Acknowledged in the keypress frame, still in the dialog that is paying.
    expect(waiting()?.textContent).toContain('Cancelling…')

    await act(async () => {
      port.settleJump('cancelled')
    })
    await settled()

    expect(waiting()).toBeNull()
    expect(choice()).toBeNull()
    expect(composer()).toHaveValue('carry on')
    expect(screen.getByRole('log')).toHaveTextContent('the old conversation')
    expect(opsOf(port)).not.toContain('prompt')
  })
})

describe('the choice belongs to one session', () => {
  it('is dismissed by landing somewhere else, draft intact', async () => {
    await mount(twoSessions('fresh'))
    await type('half a thought')
    expect(choice()).not.toBeNull()

    await act(async () => {
      fireEvent.click(sessionRows()[1] as HTMLElement)
    })
    await settled()
    expect(choice()).toBeNull()

    await act(async () => {
      fireEvent.click(sessionRows()[0] as HTMLElement)
    })
    await settled()

    // It does not re-raise on return; the draft is where it was left.
    expect(choice()).toBeNull()
    expect(composer()).toHaveValue('half a thought')
  })

  it('never dismisses a choice another session raised while its summary landed', async () => {
    const port = await mount(twoSessions('expired'))
    port.holdJump = true
    await type('carry on in A')
    await press('s')

    // The summary keeps working while the user goes to session B and meets
    // the choice there too: B's cache is just as gone as A's was.
    await act(async () => {
      fireEvent.click(sessionRows()[1] as HTMLElement)
    })
    await settled()
    await type('carry on in B')
    expect(choice()).not.toBeNull()

    port.transcripts.set('s1', [
      { kind: 'summary', text: 'Carried forward: the branch was summarized.' }
    ])
    await act(async () => {
      port.settleJump('jumped')
    })
    await settled()

    // A's message goes out in A, exactly as promised.
    expect(port.calls).toContainEqual({ op: 'prompt', args: ['s1', 'carry on in A'] })
    // But A's chain owns nothing on B's screen: the choice B is reading —
    // the dollars it exists to show — is still up, still waiting on B's own
    // decision (per-session, ADR 0003).
    expect(choice()).not.toBeNull()
    expect(composer()).toHaveValue('carry on in B')
  })

  it('never dismisses the fresh choice a second send raised in its own session', async () => {
    const port = await mount(twoSessions('expired'))
    port.holdJump = true
    await type('carry on in A')
    await press('s')

    // Away and back: the wait state is dismissed by the landing, the summary
    // goes on, and A's composer is live again with the draft in it. A second
    // send there meets a fresh choice of its own — the cache is still gone.
    await act(async () => {
      fireEvent.click(sessionRows()[1] as HTMLElement)
    })
    await settled()
    await act(async () => {
      fireEvent.click(sessionRows()[0] as HTMLElement)
    })
    await settled()
    await type('and one more thing')
    expect(choice()).not.toBeNull()

    port.transcripts.set('s1', [
      { kind: 'summary', text: 'Carried forward: the branch was summarized.' }
    ])
    await act(async () => {
      port.settleJump('jumped')
    })
    await settled()

    expect(port.calls).toContainEqual({ op: 'prompt', args: ['s1', 'carry on in A'] })
    // Same session, but not the same dialog: the landing chain closes the
    // wait state it put up, and the choice waiting on an answer stays.
    expect(choice()).not.toBeNull()
    expect(composer()).toHaveValue('and one more thing')
  })

  it('closes the wait state it put up when a second one is already on screen', async () => {
    const port = await mount(twoSessions('expired'))
    port.holdJump = true
    await type('carry on in A')
    await press('s')

    // Away and back, then a second send in A, and its door two as well: two
    // summaries in flight in one session, the second one's dialog on screen.
    await act(async () => {
      fireEvent.click(sessionRows()[1] as HTMLElement)
    })
    await settled()
    await act(async () => {
      fireEvent.click(sessionRows()[0] as HTMLElement)
    })
    await settled()
    await type('and one more thing')
    await press('s')
    expect(waiting()).not.toBeNull()

    // The first summary lands under the second one's wait state.
    await act(async () => {
      port.settleJump('jumped')
    })
    await settled()

    expect(port.calls).toContainEqual({ op: 'prompt', args: ['s1', 'carry on in A'] })
    // The dialog on screen belongs to the second press, which is still
    // waiting: only the chain that raised a wait state ever takes it down.
    expect(waiting()).not.toBeNull()
  })

  it('lets a summary another session started run on when Escape retires this one', async () => {
    const port = await mount(twoSessions('expired'))
    port.holdTree = true
    await type('carry on in A')
    await press('s')
    // A's chain is in the round trip before π is asked for anything.
    expect(opsOf(port)).toContain('sessionTree')
    expect(opsOf(port)).not.toContain('jump')

    // In that window the user goes to B, meets B's own choice and backs out
    // of it. Escape retires B's gesture, and B's alone.
    await act(async () => {
      fireEvent.click(sessionRows()[1] as HTMLElement)
    })
    await settled()
    await type('carry on in B')
    await escape()
    expect(choice()).toBeNull()

    port.transcripts.set('s1', [
      { kind: 'summary', text: 'Carried forward: the branch was summarized.' }
    ])
    await act(async () => {
      port.settleTree('s1')
    })
    await settled()

    // A's summary was asked for and A's message went out: the door A took is
    // still being honoured.
    expect(port.calls).toContainEqual({ op: 'jump', args: ['s1', 'n1', { summarize: true }] })
    expect(port.calls).toContainEqual({ op: 'prompt', args: ['s1', 'carry on in A'] })
  })

  it('never destroys words typed while the summary was being written', async () => {
    const port = await mount(twoSessions('fresh'))
    port.holdJump = true
    await type('carry on')
    await press('s')

    // Switching away dismisses the dialog but the jump keeps working, and
    // coming back lands in a live composer that still holds the draft. The
    // user is free to keep typing there for the whole ~15s of the summary.
    await act(async () => {
      fireEvent.click(sessionRows()[1] as HTMLElement)
    })
    await settled()
    await act(async () => {
      fireEvent.click(sessionRows()[0] as HTMLElement)
    })
    await settled()
    expect(composer()).toHaveValue('carry on')
    fireEvent.change(composer(), { target: { value: 'carry on — and check the rail first' } })

    port.transcripts.set('s1', [
      { kind: 'summary', text: 'Carried forward: the branch was summarized.' }
    ])
    await act(async () => {
      port.settleJump('jumped')
    })
    await settled()

    // The message that raised the choice goes out, exactly as promised.
    expect(port.calls).toContainEqual({ op: 'prompt', args: ['s1', 'carry on'] })
    // But nothing the user typed is ever lost: the words written during the
    // wait are still in the composer, not blanked by the landing.
    expect(composer()).toHaveValue('carry on — and check the rail first')
  })
})
