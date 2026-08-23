// @vitest-environment jsdom
//
// `/` is Crucible's own grammar: the service expands the invocation and the
// agent port carries the delivered text alone. Nothing here reads a folder.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Shell } from './Shell'
import {
  createScriptedCommands,
  SCRIPTED_COMMANDS,
  type ScriptedCommand,
  type ScriptedCommands
} from './testing/scripted-commands'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { sessionsShown } from './testing/sidebar'
import { settled } from './testing/settled'

async function shell(
  commands: ScriptedCommands = createScriptedCommands()
): Promise<{ port: ScriptedPort; commands: ScriptedCommands }> {
  const port = createScriptedPort(oneSession())
  port.models = [{ id: 'fake/deterministic', label: 'Fake', thinkingLevels: ['off'] }]
  render(
    <Shell port={port} workspace={createScriptedWorkspace()} commands={commands} />
  )
  await sessionsShown()
  await settled()
  return { port, commands }
}

const box = (): HTMLTextAreaElement => screen.getByLabelText('Message') as HTMLTextAreaElement

async function type(text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(box(), { target: { value: text, selectionStart: text.length } })
  })
  await settled()
}

const popover = (): HTMLElement | null => screen.queryByRole('listbox', { name: 'Commands' })

const rows = (): string[] =>
  Array.from(document.querySelectorAll('.cmdrow')).map((row) => row.textContent ?? '')

async function press(key: string, options: Record<string, unknown> = {}): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(box(), { key, ...options })
  })
  await settled()
}

const sent = (port: ScriptedPort, op: string): unknown[] | undefined =>
  port.calls.find((call) => call.op === op)?.args as unknown[] | undefined

describe('command mode', () => {
  it('flips on the first character, and bash still wins its own', async () => {
    await shell()

    await type('/al')

    expect(document.querySelector('.cbox')?.className).toContain('cmd')
    expect(screen.getByText('command')).toBeInTheDocument()

    await type('!ls')

    expect(document.querySelector('.cbox')?.className).toContain('bash')
    expect(document.querySelector('.cbox')?.className).not.toContain('cmd')
  })

  it('lists every command for a bare slash, with hint, description and origin', async () => {
    await shell()

    await type('/')

    expect(popover()).not.toBeNull()
    expect(rows()).toEqual([
      '/align[subject]Grill an idea into shared understandingbuilt-in',
      '/component<name> [features…]Create a React componentworkspace',
      '/review<PR-URL>Review a pull requestuser'
    ])
  })

  it('filters on a fuzzy subsequence, and says so when nothing matches', async () => {
    await shell()

    await type('/cmp')

    expect(rows()).toEqual(['/component<name> [features…]Create a React componentworkspace'])

    await type('/zz')

    expect(rows()).toEqual([])
    expect(screen.getByText('No command matches "zz"')).toBeInTheDocument()
  })

  it('reads the folders again every time it opens', async () => {
    const { commands } = await shell()

    await type('/')
    expect(commands.calls.filter((call) => call.op === 'list')).toHaveLength(1)

    await type('')
    // An agent wrote a command while the composer was closed.
    commands.commands = [
      ...SCRIPTED_COMMANDS,
      { name: 'standup', description: 'Summarize the week', origin: 'workspace', body: 'Standup.' }
    ]
    await type('/')

    expect(commands.calls.filter((call) => call.op === 'list')).toHaveLength(2)
    expect(rows().some((row) => row.startsWith('/standup'))).toBe(true)
  })

  it('cycles with the arrows and inserts the selection on Enter, sending nothing', async () => {
    const { port } = await shell()

    await type('/')
    await press('ArrowDown')
    await press('Enter')

    expect(box().value).toBe('/component ')
    expect(popover()).toBeNull()
    expect(port.calls.map((call) => call.op)).not.toContain('prompt')
  })

  it('inserts on Tab and on a click, the same way', async () => {
    await shell()

    await type('/rev')
    await press('Tab')
    expect(box().value).toBe('/review ')

    await type('/')
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /\/align/ }))
    })
    expect(box().value).toBe('/align ')
  })

  it('closes on Escape and opens again on the next edit', async () => {
    await shell()
    await type('/al')

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    await settled()
    expect(popover()).toBeNull()

    await type('/ali')
    expect(popover()).not.toBeNull()
  })

})

describe('sending a command', () => {
  it('expands first, and the port receives the delivered text alone', async () => {
    const { port, commands } = await shell()

    await type('/component Button "click handler"')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    })
    await settled()

    expect(commands.calls).toContainEqual({
      op: 'expand',
      args: ['/repos/crucible', '/component Button "click handler"']
    })
    expect(sent(port, 'prompt')).toEqual([
      's1',
      'Create a React component named Button with features: click handler'
    ])
    expect(box().value).toBe('')
  })

  it('steers with the expanded text while the session works', async () => {
    const { port } = await shell()
    await type('first')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    })
    await settled()

    await type('/review https://example.invalid/pr/7')
    await press('Enter')

    expect(sent(port, 'steer')).toEqual([
      's1',
      'Review the pull request at https://example.invalid/pr/7.'
    ])
  })

  it('follows up with the expanded text on Option+Enter', async () => {
    const { port } = await shell()
    await type('first')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    })
    await settled()

    await type('/align the queue')
    await press('Enter', { altKey: true })

    expect(sent(port, 'followUp')).toEqual(['s1', 'Interview me about the queue until we agree.'])
  })

  it('sends nothing at all on Enter while the popover shows no match', async () => {
    const { port } = await shell()

    await type('/zz')
    await press('Enter')

    expect(port.calls.map((call) => call.op)).not.toContain('prompt')
    expect(box().value).toBe('/zz')
  })

  it('queues the delivered text as ordinary text, strip and all', async () => {
    const { port } = await shell()
    await type('first')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    })
    await settled()

    await type('/review https://example.invalid/pr/7')
    await press('Enter')

    const delivered = 'Review the pull request at https://example.invalid/pr/7.'
    expect(port.queueOf('s1')?.steering).toEqual([{ text: delivered }])
    // Nothing command-shaped is in the strip either: it shows what will be
    // delivered, and taking it back is by that same text.
    expect(screen.getByText(delivered)).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByText(delivered))
    })
    expect(port.calls).toContainEqual({ op: 'dequeue', args: ['s1', 'steering', delivered] })
  })

  it('sends a slash that names no command exactly as it was typed', async () => {
    const { port } = await shell()

    await type('/nothing like a command')
    await press('Enter')

    expect(sent(port, 'prompt')).toEqual(['s1', '/nothing like a command'])
  })

  // A command clears the draft only once its expansion resolves, and keyboard
  // auto-repeat lands several Enters inside that window.
  it('delivers the command once when Enter repeats before the expansion resolves', async () => {
    const { port } = await shell()

    await type('/align the queue')
    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Enter' })
      fireEvent.keyDown(box(), { key: 'Enter' })
    })
    await settled()

    expect(port.calls.filter((call) => call.op === 'prompt')).toHaveLength(1)
  })

  it('queues one steering message when Enter repeats before the expansion resolves', async () => {
    const { port } = await shell()
    await type('first')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    })
    await settled()

    await type('/review https://example.invalid/pr/7')
    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Enter' })
      fireEvent.keyDown(box(), { key: 'Enter' })
    })
    await settled()

    expect(port.calls.filter((call) => call.op === 'steer')).toHaveLength(1)
    expect(port.queueOf('s1')?.steering).toEqual([
      { text: 'Review the pull request at https://example.invalid/pr/7.' }
    ])
  })

  // The composer stays live for the whole of the expansion's round trip, so
  // what it holds when the send lands may be words that were never sent.
  it('empties the composer of the message it sent and of nothing typed after it', async () => {
    const { port, commands } = await shell()
    commands.holdExpansion = true

    await type('/align the queue')
    await press('Enter')
    // Still waiting on the expansion, and the user carries on writing.
    await type('/align the queue, and the strip under it')
    await act(async () => {
      commands.settleExpansion()
    })
    await settled()

    expect(sent(port, 'prompt')).toEqual(['s1', 'Interview me about the queue until we agree.'])
    expect(box()).toHaveValue('/align the queue, and the strip under it')
  })

  it('sends the draft on the next Enter after an expansion was refused', async () => {
    const gone: ScriptedCommand = {
      name: 'gone',
      description: 'A file that will not be there',
      origin: 'user'
    }
    const { port, commands } = await shell(createScriptedCommands([gone]))

    await type('/gone now')
    await press('Enter')
    expect(screen.getByRole('alert')).toBeInTheDocument()

    // Whoever removed the file put it back; the draft never left the composer.
    commands.commands = [{ ...gone, body: 'Here after all: $@' }]
    await press('Enter')

    expect(sent(port, 'prompt')).toEqual(['s1', 'Here after all: now'])
  })

  it('keeps the draft and says why when the file has gone', async () => {
    const { port } = await shell(
      createScriptedCommands([
        { name: 'gone', description: 'A file that will not be there', origin: 'user' }
      ])
    )

    await type('/gone now')
    await press('Enter')

    expect(box().value).toBe('/gone now')
    expect(port.calls.map((call) => call.op)).not.toContain('prompt')
    expect(screen.getByRole('alert')).toHaveTextContent('The file behind /gone could not be read.')

    // The next edit takes the message away.
    await type('/gone now please')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('the command row in the transcript', () => {
  it('shows the invocation, and opens to exactly what was delivered', async () => {
    await shell()

    await type('/align the command system')
    await press('Enter')

    const row = screen.getByRole('button', { name: 'Command /align the command system' })
    expect(row).toHaveTextContent('/align the command system')
    expect(
      screen.queryByText('Interview me about the command system until we agree.')
    ).toBeNull()

    await act(async () => {
      fireEvent.click(row)
    })

    expect(
      screen.getByText('Interview me about the command system until we agree.')
    ).toBeInTheDocument()
  })

  it('re-compacts a transcript the port served again', async () => {
    const { port } = await shell()
    port.trees.set('s1', {
      roots: [
        {
          ref: 'n1',
          text: 'Interview me about the command system until we agree.',
          at: '2026-08-19T13:12:00.000Z',
          children: []
        }
      ],
      path: ['n1']
    })

    await type('/align the command system')
    await press('Enter')
    await act(async () => {
      port.endTurn('s1')
    })

    // What main serves back is the delivered text, which is all it ever
    // stored: no command metadata is persisted anywhere.
    port.transcripts.set('s1', [
      { kind: 'user', text: 'Interview me about the command system until we agree.' }
    ])
    // Double-Esc, the tree's only way in.
    await press('Escape')
    await press('Escape')
    await settled()
    await act(async () => {
      fireEvent.click(screen.getByText('Interview me about the command system until we agree.'))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Continue from here/ }))
    })
    await settled()

    expect(port.calls.filter((call) => call.op === 'transcript').length).toBeGreaterThan(1)
    expect(
      screen.getByRole('button', { name: 'Command /align the command system' })
    ).toBeInTheDocument()
  })

  it('leaves an ordinary message alone', async () => {
    await shell()

    await type('just a message')
    await press('Enter')

    expect(screen.getByText('just a message')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Command / })).toBeNull()
  })
})
