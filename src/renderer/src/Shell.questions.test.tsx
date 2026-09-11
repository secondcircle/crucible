// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Question, ShellSnapshot } from '../../shared/agent/port'
import { ASK_TOOL } from '../../shared/agent/ask-tool'
import { Shell } from './Shell'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedPort, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { settled } from './testing/settled'

const HERE = 'Provider quota adapters'
const OTHER = 'Cache ledger pruning'

const SNAPSHOT: ShellSnapshot = {
  workspaces: [{ id: 'w1', name: 'crucible', path: '/repos/crucible' }],
  activeWorkspaceId: 'w1',
  activeSessionId: 's1',
  sessions: [
    {
      id: 's1',
      workspaceId: 'w1',
      createdAt: '2026-09-10T10:00:00.000Z',
      title: HERE,
      working: false,
      fresh: false
    },
    {
      id: 's2',
      workspaceId: 'w1',
      createdAt: '2026-09-10T10:01:00.000Z',
      title: OTHER,
      working: false,
      fresh: false
    }
  ]
}

const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - (minutes * 60_000 + 20_000)).toISOString()

function questionOf(overrides: Partial<Question> = {}): Question {
  return {
    id: 'q-1',
    question: 'OpenAI’s meter has no reset instant. Show a countdown, or none at all?',
    context:
      'Every quota meter today shows “resets in 3h 12m”. OpenAI reports only the billing ' +
      'period, which is the calendar month.',
    recommendation: 'No countdown, same as the spend meter.',
    askedAt: minutesAgo(1),
    ...overrides
  }
}

const SECOND = questionOf({
  id: 'q-2',
  question: 'Where should the OpenAI API key come from?',
  recommendation: 'Read OPENAI_ADMIN_KEY from the environment for now.',
  askedAt: minutesAgo(3)
})

const THIRD = questionOf({ id: 'q-3', question: 'Should the merge gate block on a changelog?' })
const FOURTH = questionOf({ id: 'q-4', question: 'Keep the --legacy flag or drop it?' })

function mount(): ScriptedPort {
  const port = createScriptedPort(SNAPSHOT)
  render(
    <Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
    />
  )
  return port
}

async function asking(
  questions: readonly Question[] = [questionOf()],
  sessionId = 's1'
): Promise<ScriptedPort> {
  const port = mount()
  await act(settled)
  await act(async () => {
    for (const question of questions) port.askQuestion(sessionId, question)
    await settled()
  })
  return port
}

const dock = (): HTMLElement | null => document.querySelector<HTMLElement>('.dockband')
const card = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>('.dockband .qcard')
  if (found === null) throw new Error('no question card is in the dock')
  return found
}
const answerBox = (): HTMLTextAreaElement =>
  screen.getByLabelText('Your answer') as HTMLTextAreaElement
const button = (name: string): HTMLElement => within(card()).getByRole('button', { name })
const said = (selector: string): string =>
  document.querySelector(selector)?.textContent?.trim() ?? ''

async function type(text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(answerBox(), { target: { value: text } })
    await settled()
  })
}

async function click(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(button(name))
    await settled()
  })
}

const replies = (port: ScriptedPort): readonly unknown[][] =>
  port.calls.filter((call) => call.op === 'replyToQuestion').map((call) => [...call.args])

describe('the dock', () => {
  it('is not there at all when nothing is open', async () => {
    mount()
    await act(settled)
    expect(dock()).toBeNull()
  })

  it('shows the session on screen and no other’s', async () => {
    const port = await asking([questionOf()], 's2')
    expect(dock()).toBeNull()

    await act(async () => {
      await port.activateSession('s2')
      await settled()
    })
    expect(said('.qcard .question')).toBe(questionOf().question)
  })

  it('sits between the transcript and the composer, above the composer box', async () => {
    await asking()
    const column = document.querySelector('.main')
    const children = [...(column?.children ?? [])].map((one) => one.className)
    expect(children.indexOf('dockband')).toBeGreaterThan(children.indexOf('stage'))
    expect(children.indexOf('dockband')).toBeLessThan(children.indexOf('composer'))
  })

  it('shows the question, the context, the recommendation and how long it has waited', async () => {
    await asking()
    expect(said('.qcard .question')).toBe(questionOf().question)
    expect(said('.qcard .qctx')).toContain('resets in 3h 12m')
    expect(said('.qcard .qrec')).toContain(questionOf().recommendation)
    expect(said('.qcard .qage')).toBe('1m')
  })

  it('offers a four-row box, two buttons and a ✕, and nothing else', async () => {
    await asking()
    expect(answerBox()).toBeTruthy()
    expect(within(card()).getAllByRole('button').map((one) => one.textContent)).toEqual([
      '✕',
      'Take recommendation',
      'Send'
    ])
    // No option chips: free text and the recommendation cover it.
    expect(card().querySelector('.opts')).toBeNull()
  })

  it('shows one question at a time, counted, with the next one named', async () => {
    await asking([questionOf(), SECOND, THIRD, FOURTH])
    expect(document.querySelectorAll('.dockband .qcard')).toHaveLength(1)
    expect(said('.dockhead .cnt')).toBe('1 of 4')
    expect(said('.upnext .t')).toBe(`${SECOND.question} · then 2 more`)
  })

  it('names the next one without a tail when it is the last', async () => {
    await asking([questionOf(), SECOND])
    expect(said('.upnext .t')).toBe(SECOND.question)
  })

  it('shows the last question with nothing up next', async () => {
    await asking()
    expect(document.querySelector('.upnext')).toBeNull()
  })
})

describe('answering', () => {
  it('sends what was typed, and the card is gone in the same frame', async () => {
    const port = await asking([questionOf(), SECOND])
    await type('Show the month, but only on hover.')

    act(() => {
      fireEvent.click(button('Send'))
    })

    expect(said('.qcard .question')).toBe(SECOND.question)
    expect(replies(port)).toEqual([
      ['s1', 'q-1', { kind: 'answered', text: 'Show the month, but only on hover.' }]
    ])
  })

  it('sends on Enter and keeps a Shift-Enter for the line break', async () => {
    const port = await asking()
    await type('No countdown.')

    await act(async () => {
      fireEvent.keyDown(answerBox(), { key: 'Enter', shiftKey: true })
      await settled()
    })
    expect(replies(port)).toEqual([])

    await act(async () => {
      fireEvent.keyDown(answerBox(), { key: 'Enter' })
      await settled()
    })
    expect(replies(port)).toEqual([['s1', 'q-1', { kind: 'answered', text: 'No countdown.' }]])
  })

  it('does nothing on an empty Send, and says so', async () => {
    const port = await asking()
    await click('Send')

    expect(replies(port)).toEqual([])
    expect(dock()).toBeTruthy()
    expect(said('.qcard .qsay')).toMatch(/write an answer, or take the recommendation/i)
  })

  it('sends the recommendation itself when it is taken', async () => {
    const port = await asking()
    await click('Take recommendation')
    expect(replies(port)).toEqual([['s1', 'q-1', { kind: 'recommendation' }]])
  })

  it('dismisses with no answer on the ✕', async () => {
    const port = await asking()
    await click('Dismiss without answering')
    expect(replies(port)).toEqual([['s1', 'q-1', { kind: 'dismissed' }]])
  })

  it('brings the next question with its box focused', async () => {
    await asking([questionOf(), SECOND])
    expect(document.activeElement).not.toBe(answerBox())

    await click('Take recommendation')

    expect(said('.qcard .question')).toBe(SECOND.question)
    expect(document.activeElement).toBe(answerBox())
  })

  it('keeps each question’s own draft while the line moves', async () => {
    await asking([questionOf(), SECOND])
    await type('half an answer')
    await click('Dismiss without answering')
    expect(answerBox().value).toBe('')
  })

  it('puts the caret in the box on ⌘⇧A, which the header names', async () => {
    await asking()
    expect(said('.dockhead .hint')).toMatch(/A focus the answer/)

    act(() => {
      fireEvent.keyDown(document, { key: 'a', metaKey: true, shiftKey: true })
    })
    expect(document.activeElement).toBe(answerBox())
  })
})

describe('holding the answers', () => {
  it('says how many are held, and sends nothing to the agent yet', async () => {
    const port = await asking([questionOf(), SECOND])
    await click('Take recommendation')

    expect(said('.dockhead .hint')).toBe('1 answer held · sent together when the line is empty')
    expect(said('.dockhead .cnt')).toBe('2 of 2')
    expect(port.calls.some((call) => call.op === 'prompt' || call.op === 'steer')).toBe(false)
    expect(port.queueOf('s1')).toBeUndefined()
  })

  it('sends one message with every answer once the line empties, and the dock goes', async () => {
    const port = await asking([questionOf(), SECOND])
    await click('Take recommendation')
    await type('Env var is fine.')
    await click('Send')

    expect(dock()).toBeNull()
    const rows = [...document.querySelectorAll('.chat .syscard')]
    expect(rows).toHaveLength(1)
    expect(rows[0].querySelector('.badge')?.textContent).toBe('answers')
    expect(rows[0].textContent).toContain('2 answers')
    expect(rows[0].textContent).toContain(questionOf().question)
    expect(rows[0].textContent).toContain('Env var is fine.')
    expect(port.snapshotNow.sessions[0].questions).toBeUndefined()
  })

  it('takes a question the agent adds before the line empties into the same batch', async () => {
    const port = await asking([questionOf(), SECOND])
    await click('Take recommendation')

    await act(async () => {
      port.askQuestion('s1', THIRD)
      await settled()
    })
    expect(said('.dockhead .cnt')).toBe('2 of 3')

    await click('Dismiss without answering')
    await click('Dismiss without answering')
    const row = document.querySelector('.chat .syscard')
    expect(row?.textContent).toContain('3 answers')
  })
})

describe('the composer beside it', () => {
  it('stays a normal message: a send there is a prompt, not an answer', async () => {
    const port = await asking()
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'carry on' } })
      fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' })
      await settled()
    })

    expect(port.calls.some((call) => call.op === 'prompt')).toBe(true)
    expect(replies(port)).toEqual([])
    expect(dock()).toBeTruthy()
  })
})

describe('an open question in the sidebar', () => {
  const row = (title: string): HTMLElement => {
    const found = screen
      .getByRole('button', { name: (name) => name.startsWith(title) })
      .closest('.sessrow')
    if (found === null) throw new Error(`${title} is not in a session row`)
    return found as HTMLElement
  }
  const nameOf = (title: string): string =>
    row(title).querySelector('.sess')?.getAttribute('aria-label') ?? ''

  it('marks the session needs-you the moment it is asked', async () => {
    await asking([questionOf()], 's2')
    expect(nameOf(OTHER)).toContain('needs you')
    expect(row(OTHER).querySelector('.pip')).toBeTruthy()
  })

  it('marks it while the agent goes on working, dots and all', async () => {
    const port = await asking([], 's2')
    await act(async () => {
      await port.prompt('s2', 'go')
      port.update((snapshot) => ({
        ...snapshot,
        sessions: snapshot.sessions.map((one) =>
          one.id === 's2' ? { ...one, workingSince: minutesAgo(1) } : one
        )
      }))
      port.askQuestion('s2', questionOf())
      await settled()
    })
    expect(nameOf(OTHER)).toContain('needs you')
    expect(port.snapshotNow.sessions[1].working).toBe(true)
    const end = row(OTHER).querySelector('.rowend')
    expect(end?.querySelector('.pip')).toBeTruthy()
    expect(end?.querySelector('.typing')).toBeTruthy()
  })

  it('walks to it on Tab, and landing clears the mark while the card stays', async () => {
    const port = await asking([questionOf()], 's2')

    act(() => {
      fireEvent.keyDown(document, { key: 'Tab' })
    })
    await act(settled)

    expect(port.snapshotNow.activeSessionId).toBe('s2')
    expect(nameOf(OTHER)).not.toContain('needs you')
    expect(dock()).toBeTruthy()
    expect(said('.qcard .question')).toBe(questionOf().question)
  })

  it('says nothing about a session the user is already looking at', async () => {
    await asking()
    expect(nameOf(HERE)).not.toContain('needs you')
    expect(document.querySelector('.sessrow.asking')).toBeNull()
  })

  it('posts a banner naming the question', async () => {
    const banners: { title: string; asks?: string }[] = []
    const port = createScriptedPort(SNAPSHOT)
    render(
      <Shell
        port={port}
        workspace={createScriptedWorkspace()}
        commands={createScriptedCommands()}
        needsYou={{
          async waiting() {},
          async announce(session) {
            banners.push({
              title: session.title,
              ...(session.asks === undefined ? {} : { asks: session.asks })
            })
          }
        }}
      />
    )
    await act(settled)
    await act(async () => {
      port.askQuestion('s2', questionOf())
      await settled()
    })

    expect(banners).toEqual([{ title: OTHER, asks: questionOf().question }])
  })
})

describe('the call in the transcript', () => {
  it('is an ordinary tool row, amber, under the tool’s own name', async () => {
    const port = await asking([])
    await act(async () => {
      await port.prompt('s1', 'wire the openai adapter')
      port.toolStarted('s1', 'c1', ASK_TOOL, questionOf().question)
      port.toolEnded('s1', 'c1', true, 'asked')
      await settled()
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Tool chain/ }))
      await settled()
    })
    const row = document.querySelector('.chat .tool')
    expect(row?.className).toContain('ask')
    expect(row?.querySelector('.toolname')?.textContent).toBe(ASK_TOOL)
    expect(row?.querySelector('.toolsummary')?.textContent).toBe(questionOf().question)
  })
})
