// @vitest-environment jsdom
//
// The session tree is a view over what the port served and an in-place jump:
// no sidebar entry is ever minted, and nothing is invented for a node.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { SessionTree, TranscriptItem } from '../../shared/agent/port'
import { Shell } from './Shell'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { createScriptedCommands } from './testing/scripted-commands'
import { sessionRows, sessionsShown } from './testing/sidebar'
import { settled } from './testing/settled'

const TREE: SessionTree = {
  roots: [
    {
      ref: 'n1',
      text: 'Scaffold the resume overlay component.',
      at: '2026-08-19T13:12:00.000Z',
      activity: 'assistant · 2 edit · 1 bash',
      children: [
        {
          ref: 'n2',
          text: 'Hook the overlay up to ⌘O.',
          at: '2026-08-19T13:31:00.000Z',
          label: 'checkpoint',
          activity: 'assistant · 4 edit · 2 bash',
          children: [
            // Created first and abandoned: the fork renders where it diverged.
            {
              ref: 'n3',
              text: 'Actually, try a modal dialog instead of the overlay.',
              at: '2026-08-19T13:44:00.000Z',
              activity: 'assistant · 3 edit',
              children: [
                {
                  ref: 'n4',
                  text: 'No — revert that, go back to the overlay.',
                  at: '2026-08-19T13:55:00.000Z',
                  children: []
                }
              ]
            },
            {
              ref: 'n5',
              text: 'Now wire the resume overlay to real history search.',
              at: '2026-08-19T14:01:00.000Z',
              activity: 'assistant · 1 edit',
              children: []
            }
          ]
        }
      ]
    }
  ],
  path: ['n1', 'n2', 'n5']
}

async function shell(
  options: { readonly working?: boolean; readonly tree?: SessionTree } = {}
): Promise<ScriptedPort> {
  const port = createScriptedPort(oneSession({ working: options.working ?? false }))
  port.models = [{ id: 'fake/deterministic', label: 'Fake', thinkingLevels: ['off', 'low'] }]
  port.trees.set('s1', options.tree ?? TREE)
  render(<Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
    />)
  await sessionsShown()
  await settled()
  return port
}

const treeButton = (): HTMLElement => screen.getByRole('button', { name: 'Session tree' })

async function open(): Promise<void> {
  await act(async () => {
    fireEvent.click(treeButton())
  })
}

async function escape(): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(document, { key: 'Escape' })
  })
}

const overlay = (): HTMLElement | null => screen.queryByRole('dialog', { name: 'Session tree' })

const box = (): HTMLElement => screen.getByLabelText('Message')

const nodes = (): string[] =>
  Array.from(document.querySelectorAll('.node .nodetext')).map((node) => node.textContent ?? '')

const search = (): HTMLElement => screen.getByLabelText('Search this session')

describe('opening and closing the tree', () => {
  it('opens from the button in the session header, which says how else to', async () => {
    const port = await shell()

    expect(treeButton()).toHaveTextContent('esc esc')
    await open()

    expect(overlay()).not.toBeNull()
    expect(port.calls).toContainEqual({ op: 'sessionTree', args: ['s1'] })
  })

  it('opens on a second Escape and closes on the next one', async () => {
    await shell()

    await escape()
    expect(overlay()).toBeNull()
    await escape()
    expect(overlay()).not.toBeNull()

    await escape()
    expect(overlay()).toBeNull()
  })

  it('keeps Escape meaning stop while the session works, and opens nothing', async () => {
    const port = await shell({ working: true })

    await escape()
    await escape()

    expect(overlay()).toBeNull()
    expect(port.calls.map((call) => call.op)).toContain('cancel')
  })

  it('lets the button open it mid-turn without touching the turn', async () => {
    const port = await shell({ working: true })

    await open()

    expect(overlay()).not.toBeNull()
    expect(port.calls.map((call) => call.op)).not.toContain('cancel')
  })

  it('closes the model picker before it closes itself', async () => {
    await shell()
    await open()

    await act(async () => {
      fireEvent.click(screen.getByLabelText(/^Model:/))
    })
    expect(screen.queryByRole('dialog', { name: 'Model picker' })).not.toBeNull()

    await escape()
    expect(screen.queryByRole('dialog', { name: 'Model picker' })).toBeNull()
    expect(overlay()).not.toBeNull()

    await escape()
    expect(overlay()).toBeNull()
  })

  it('leaves the composer in place and working', async () => {
    await shell()
    await open()

    await act(async () => {
      fireEvent.change(box(), { target: { value: 'still typing' } })
    })

    expect(box()).toHaveValue('still typing')
  })
})

describe('what the rail shows', () => {
  it('renders user messages as nodes, with labels, activity lines and the fork', async () => {
    await shell()
    await open()

    expect(nodes()).toEqual([
      'Scaffold the resume overlay component.',
      'Hook the overlay up to ⌘O.',
      'Actually, try a modal dialog instead of the overlay.',
      'No — revert that, go back to the overlay.',
      'Now wire the resume overlay to real history search.',
      'Current point'
    ])

    expect(screen.getByText('checkpoint')).toBeInTheDocument()
    expect(screen.getByText('assistant · 2 edit · 1 bash')).toBeInTheDocument()
    expect(screen.getByText(/⑂ branch · abandoned/)).toBeInTheDocument()
    // The current point is marked by its solid dot alone; no chip repeats it.
    expect(document.querySelector('.node.leaf .dot')).not.toBeNull()
  })

  it('says the session is still working after the last point on the path', async () => {
    await shell({ working: true })
    await open()

    expect(screen.getByText('assistant · 1 edit · working…')).toBeInTheDocument()
  })

  it('shows only the current point for an empty conversation', async () => {
    await shell({ tree: { roots: [], path: [] } })
    await open()

    expect(nodes()).toEqual(['Current point'])
  })
})

describe('search', () => {
  it('filters node text, hides the connective lines, and counts the matches', async () => {
    await shell()
    await open()

    await act(async () => {
      fireEvent.change(search(), { target: { value: 'overlay' } })
    })

    expect(nodes()).toEqual([
      'Scaffold the resume overlay component.',
      'Hook the overlay up to ⌘O.',
      'Actually, try a modal dialog instead of the overlay.',
      'No — revert that, go back to the overlay.',
      'Now wire the resume overlay to real history search.'
    ])
    expect(screen.getByText('5 matching points')).toBeInTheDocument()
    expect(screen.queryByText('assistant · 2 edit · 1 bash')).toBeNull()
    expect(screen.queryByText(/⑂ branch/)).toBeNull()
  })

  it('searches the message text and nothing else', async () => {
    await shell()
    await open()

    await act(async () => {
      fireEvent.change(search(), { target: { value: 'checkpoint' } })
    })

    expect(nodes()).toEqual([])
    expect(screen.getByText('0 matching points')).toBeInTheDocument()
  })

  it('restores the whole rail when the filter is cleared', async () => {
    await shell()
    await open()

    await act(async () => {
      fireEvent.change(search(), { target: { value: 'modal' } })
    })
    expect(nodes()).toHaveLength(1)

    await act(async () => {
      fireEvent.change(search(), { target: { value: '' } })
    })
    expect(nodes()).toHaveLength(6)
  })
})

describe('the action card', () => {
  async function select(text: string | RegExp): Promise<void> {
    await act(async () => {
      fireEvent.click(screen.getByText(text))
    })
  }

  it('opens on a click and closes on the next one', async () => {
    await shell()
    await open()

    await select('Hook the overlay up to ⌘O.')
    expect(screen.getByRole('button', { name: /Continue from here/ })).toBeInTheDocument()

    await select('Hook the overlay up to ⌘O.')
    expect(screen.queryByRole('button', { name: /Continue from here/ })).toBeNull()
  })

  it('refuses to continue while the session works, and says why', async () => {
    await shell({ working: true })
    await open()
    await select('Hook the overlay up to ⌘O.')

    expect(screen.getByRole('button', { name: /Continue from here/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Continue with summary/ })).toBeDisabled()
    expect(screen.getByText(/stop the agent first/i)).toBeInTheDocument()
    // Labelling is browsing, and browsing stays live.
    expect(screen.getByRole('button', { name: /Remove label/ })).toBeEnabled()
  })

  it('says what continuing from an abandoned branch means', async () => {
    await shell()
    await open()
    await select('Actually, try a modal dialog instead of the overlay.')

    expect(screen.getByText(/the tree keeps every path/)).toBeInTheDocument()
  })
})

describe('a jump', () => {
  const PATH: readonly TranscriptItem[] = [
    { kind: 'user', text: 'Scaffold the resume overlay component.' },
    { kind: 'assistant', markdown: 'Done.' }
  ]

  async function jumped(action: RegExp): Promise<ScriptedPort> {
    const port = await shell()
    port.jumpText = 'Hook the overlay up to ⌘O.'
    port.transcripts.set('s1', PATH)
    await open()

    await act(async () => {
      fireEvent.click(screen.getByText('Hook the overlay up to ⌘O.'))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: action }))
    })
    return port
  }

  it('continues in place, replaces the transcript and hands the message back', async () => {
    const port = await jumped(/Continue from here/)

    expect(port.calls).toContainEqual({
      op: 'jump',
      args: ['s1', 'n2', { summarize: false }]
    })
    expect(overlay()).toBeNull()
    expect(screen.getByRole('log')).toHaveTextContent('Scaffold the resume overlay component.')
    expect(box()).toHaveValue('Hook the overlay up to ⌘O.')
    // In place: no new sidebar entry, and no guard dialog either.
    expect(sessionRows()).toHaveLength(1)
    expect(screen.queryByRole('dialog', { name: /Invalidate/ })).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('Jumped —')
  })

  it('summarizes when asked, and shows the context the jump landed on', async () => {
    const port = await shell()
    port.jumpText = 'Hook the overlay up to ⌘O.'
    port.transcripts.set('s1', [
      ...PATH,
      { kind: 'summary', text: 'The branch explored a modal dialog and was abandoned.' }
    ])
    await open()
    await act(async () => {
      fireEvent.click(screen.getByText('Hook the overlay up to ⌘O.'))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Continue with summary/ }))
    })

    expect(port.calls).toContainEqual({ op: 'jump', args: ['s1', 'n2', { summarize: true }] })
    expect(screen.getByRole('status')).toHaveTextContent('Jumped with summary')
    // The summary is the context now, so the transcript shows it in full.
    expect(screen.getByLabelText('Context summary')).toHaveTextContent(
      'The branch explored a modal dialog and was abandoned.'
    )
  })

  it('stacks the restored message above a draft already being typed', async () => {
    const port = await shell()
    port.jumpText = 'Hook the overlay up to ⌘O.'
    await act(async () => {
      fireEvent.change(box(), { target: { value: 'a half-typed sentence' } })
    })
    await open()

    await act(async () => {
      fireEvent.click(screen.getByText('Hook the overlay up to ⌘O.'))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Continue from here/ }))
    })

    expect(box()).toHaveValue('Hook the overlay up to ⌘O.\n\na half-typed sentence')
  })

  it('continues from the selected node when Enter is pressed', async () => {
    const port = await shell()
    await open()

    await act(async () => {
      fireEvent.keyDown(search(), { key: 'ArrowDown' })
    })
    await act(async () => {
      fireEvent.keyDown(search(), { key: 'Enter' })
    })

    expect(port.calls).toContainEqual({ op: 'jump', args: ['s1', 'n1', { summarize: false }] })
  })

  it('says so and stays open when the port refuses', async () => {
    const port = await shell()
    port.jumpRefusal = 'That session is working. Stop it first.'
    await open()

    await act(async () => {
      fireEvent.click(screen.getByText('Hook the overlay up to ⌘O.'))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Continue from here/ }))
    })

    expect(screen.getByRole('alert')).toHaveTextContent('Stop it first')
    expect(overlay()).not.toBeNull()
  })
})

describe('labels', () => {
  it('defaults to checkpoint and round-trips through the port', async () => {
    const port = await shell()
    await open()

    await act(async () => {
      fireEvent.click(screen.getByText('Scaffold the resume overlay component.'))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Label/ }))
    })
    expect(screen.getByLabelText('Label this point')).toHaveValue('checkpoint')

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Label this point'), {
        target: { value: 'before the rewrite' }
      })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save label' }))
    })

    expect(port.calls).toContainEqual({
      op: 'setLabel',
      args: ['s1', 'n1', 'before the rewrite']
    })
    expect(screen.getByText('before the rewrite')).toBeInTheDocument()
  })

  it('removes the label on the one click the button promises', async () => {
    const port = await shell()
    await open()

    await act(async () => {
      fireEvent.click(screen.getByText('Hook the overlay up to ⌘O.'))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Remove label/ }))
    })

    expect(port.calls).toContainEqual({ op: 'setLabel', args: ['s1', 'n2', undefined] })
    expect(screen.queryByText('checkpoint')).toBeNull()
    // No editor stands between the button and what it says it does.
    expect(screen.queryByLabelText('Label this point')).toBeNull()
    // And the action now offers the other half of the toggle.
    expect(screen.getByRole('button', { name: /^Label/ })).toBeInTheDocument()
  })

  it('removes it from the keyboard too, so l and the button never differ', async () => {
    const port = await shell()
    await open()

    await act(async () => {
      fireEvent.click(screen.getByText('Hook the overlay up to ⌘O.'))
    })
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('dialog', { name: 'Session tree' }), { key: 'l' })
    })

    expect(port.calls).toContainEqual({ op: 'setLabel', args: ['s1', 'n2', undefined] })
    expect(screen.queryByText('checkpoint')).toBeNull()
  })

  it('clears rather than sets when the input is emptied', async () => {
    const port = await shell()
    await open()

    await act(async () => {
      fireEvent.click(screen.getByText('Scaffold the resume overlay component.'))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Label/ }))
    })
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Label this point'), { target: { value: '  ' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save label' }))
    })

    expect(port.calls).toContainEqual({ op: 'setLabel', args: ['s1', 'n1', undefined] })
  })
})
