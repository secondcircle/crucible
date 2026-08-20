// @vitest-environment jsdom
//
// Tool calls and thinking are the two regions most tempting to fake, so
// nothing here may appear without the event that earns it.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Shell } from './Shell'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { settled } from './testing/settled'

async function streaming(): Promise<ScriptedPort> {
  const port = createScriptedPort(oneSession())
  render(<Shell port={port} workspace={createScriptedWorkspace()} />)
  await screen.findByRole('button', { name: /^Session · / })
  await settled()
  await act(async () => {
    await port.prompt('s1', 'run the tests')
  })
  return port
}

const transcriptItems = (): string[] =>
  Array.from(
    screen.getByRole('log', { name: 'Transcript' }).querySelectorAll('.items > li')
  ).map((item) => item.className || (item.firstElementChild?.className ?? ''))

const chainRow = (): HTMLElement => screen.getByRole('button', { name: /^Tool chain/ })

const chainRows = (): HTMLElement[] => screen.getAllByRole('button', { name: /^Tool chain/ })

describe('tool chains', () => {
  it('appear only when a tool event says so', async () => {
    const port = await streaming()

    act(() => port.text('s1', 'Running them now.'))
    expect(screen.queryByRole('button', { name: /^Tool chain/ })).toBeNull()

    act(() => port.toolStarted('s1', 'c1', 'bash', 'npm test'))

    expect(chainRow()).toHaveTextContent('bash npm test')
    expect(chainRow()).toHaveTextContent('running')
  })

  it('render one row for a run of calls, with counts that tick as they land', async () => {
    const port = await streaming()

    act(() => {
      port.toolStarted('s1', 'c1', 'bash', 'npm test')
      port.toolEnded('s1', 'c1', true, 'ok')
      port.toolStarted('s1', 'c2', 'bash', 'npm run lint')
      port.toolEnded('s1', 'c2', true, 'ok')
      port.toolStarted('s1', 'c3', 'read', 'src/main/index.ts')
    })

    expect(chainRows()).toHaveLength(1)
    expect(chainRow()).toHaveTextContent('2 bash')
    // The call still running is what the collapsed row describes.
    expect(chainRow()).toHaveTextContent('read src/main/index.ts')

    act(() => port.toolEnded('s1', 'c3', true, 'ok'))

    expect(chainRow()).toHaveTextContent('2 bash · 1 read')
    expect(chainRow()).toHaveTextContent('done')
  })

  it('mark a failure the moment it happens, while later calls still run', async () => {
    const port = await streaming()

    act(() => {
      port.toolStarted('s1', 'c1', 'read', 'docs/design/feature-inventory.md')
      port.toolEnded('s1', 'c1', false, 'ENOENT')
      port.toolStarted('s1', 'c2', 'bash', 'ls docs/design')
    })

    // Nothing about a collapsed row may hide it, running or not.
    expect(chainRow()).toHaveTextContent('1 error')
    expect(chainRow().closest('.chain')?.className).toContain('failed')
  })

  it('start a new chain after thinking or text, in transcript order', async () => {
    const port = await streaming()

    act(() => {
      port.toolStarted('s1', 'c1', 'bash', 'npm test')
      port.toolEnded('s1', 'c1', true, 'ok')
      port.thinking('s1', 'which file names it')
      port.toolStarted('s1', 'c2', 'read', 'src/main/index.ts')
      port.toolEnded('s1', 'c2', true, 'ok')
    })

    expect(transcriptItems()).toEqual(['chain done', 'think', 'chain done'])
    expect(chainRows()).toHaveLength(2)
  })

  it('render a lone call as a chain of one', async () => {
    const port = await streaming()

    act(() => {
      port.toolStarted('s1', 'c1', 'read', 'package.json')
      port.toolEnded('s1', 'c1', true, '{}')
    })

    expect(chainRow()).toHaveTextContent('1 read')
    expect(screen.queryByRole('button', { name: 'read package.json' })).toBeNull()
  })

  it('claim no outcome for a call cut off with its turn', async () => {
    const port = await streaming()
    act(() => port.toolStarted('s1', 'c1', 'bash', 'npm test'))

    await act(async () => {
      await port.cancel('s1')
    })

    expect(chainRow()).toHaveTextContent('stopped')
    expect(chainRow()).not.toHaveTextContent('done')
    expect(screen.getByText('Stopped')).toBeInTheDocument()
  })
})

describe('drilling into a chain', () => {
  async function twoCalls(): Promise<ScriptedPort> {
    const port = await streaming()
    act(() => {
      port.toolStarted('s1', 'c1', 'bash', 'npm test')
      port.toolEnded('s1', 'c1', true, 'Tests  42 passed\n')
      port.toolStarted('s1', 'c2', 'read', 'src/main/index.ts')
      port.toolEnded('s1', 'c2', true, 'import { app } from electron\n')
    })
    return port
  }

  it('opens the call rows on a click, and their output on the next one', async () => {
    await twoCalls()

    fireEvent.click(chainRow())
    const call = screen.getByRole('button', { name: 'bash npm test' })
    expect(call).toHaveTextContent('done')
    expect(screen.queryByText(/Tests\s+42 passed/)).toBeNull()

    fireEvent.click(call)
    expect(screen.getByText(/Tests\s+42 passed/)).toBeInTheDocument()

    fireEvent.click(call)
    expect(screen.queryByText(/Tests\s+42 passed/)).toBeNull()
  })

  it('shows a running call as a row, with its output, rather than hiding it', async () => {
    const port = await streaming()
    act(() => port.toolStarted('s1', 'c1', 'bash', 'npm test'))

    fireEvent.click(chainRow())
    act(() => port.toolOutput('s1', 'c1', 'Test Files  3 passed\n'))

    expect(screen.getByRole('button', { name: 'bash npm test' })).toHaveTextContent('running')
    // While it runs, the output is shown without asking.
    expect(screen.getByText(/Test Files\s+3 passed/)).toBeInTheDocument()
  })

  it('renders every call the same way', async () => {
    await twoCalls()

    fireEvent.click(chainRow())
    const [first, second] = screen.getAllByRole('button', { name: /^(bash|read) / })

    expect(first.className).toBe(second.className)
  })

  it('keeps what was opened open as the chain grows', async () => {
    const port = await twoCalls()

    fireEvent.click(chainRow())
    act(() => {
      port.toolStarted('s1', 'c3', 'bash', 'npm run lint')
      port.toolEnded('s1', 'c3', true, 'ok')
    })

    expect(screen.getByRole('button', { name: 'bash npm run lint' })).toBeInTheDocument()
  })

  it('never leaks what one session opened into another session\u2019s rows', async () => {
    const port = createScriptedPort({
      workspaces: [{ id: 'w1', name: 'crucible', path: '/repos/crucible' }],
      activeWorkspaceId: 'w1',
      sessions: [
        { id: 's1', workspaceId: 'w1', createdAt: '2026-08-19T14:14:00.000Z', working: false },
        { id: 's2', workspaceId: 'w1', createdAt: '2026-08-19T15:20:00.000Z', working: false }
      ],
      activeSessionId: 's1'
    })
    render(<Shell port={port} workspace={createScriptedWorkspace()} />)
    await screen.findAllByRole('button', { name: /^Session · / })

    await act(async () => {
      await port.prompt('s1', 'one')
      await port.prompt('s2', 'two')
    })
    act(() => {
      port.toolStarted('s1', 'c1', 'bash', 'npm test')
      port.toolEnded('s1', 'c1', true, 'ok')
      port.toolStarted('s2', 'c2', 'bash', 'npm run lint')
      port.toolEnded('s2', 'c2', true, 'ok')
    })
    fireEvent.click(chainRow())
    expect(screen.getByRole('button', { name: 'bash npm test' })).toBeInTheDocument()

    await act(async () => {
      await port.activateSession('s2')
    })

    expect(screen.queryByRole('button', { name: 'bash npm run lint' })).toBeNull()
  })

  it('groups a restored transcript exactly as the stream was grouped', async () => {
    const port = createScriptedPort(oneSession())
    port.transcripts.set('s1', [
      { kind: 'tool', name: 'bash', summary: 'npm test', ok: true, output: 'ok' },
      { kind: 'tool', name: 'read', summary: 'src/main/index.ts', ok: true, output: 'ok' },
      { kind: 'assistant', markdown: 'Both are fine.' },
      { kind: 'tool', name: 'read', summary: 'package.json', ok: false, output: 'ENOENT' }
    ])
    render(<Shell port={port} workspace={createScriptedWorkspace()} />)

    const rows = await screen.findAllByRole('button', { name: /^Tool chain/ })

    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('1 bash · 1 read')
    expect(rows[1]).toHaveTextContent('1 error')
  })
})

describe('thinking', () => {
  it('appears only when a thinking event says so', async () => {
    const port = await streaming()

    expect(screen.queryByText('weighing the two shapes')).toBeNull()

    act(() => port.thinking('s1', 'weighing the two shapes'))

    expect(screen.getByText('weighing the two shapes')).toBeInTheDocument()
  })

  it('stays visible once the turn moves on, with no header row', async () => {
    const port = await streaming()

    act(() => port.thinking('s1', 'weighing the two shapes'))
    act(() => port.text('s1', 'The decorator wins.'))

    // No "thought" toggle exists, so nothing collapses and the transcript
    // never shifts under the reader.
    expect(screen.getByText('weighing the two shapes')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /thought/ })).toBeNull()
  })
})

describe('arrival order', () => {
  it('opens a new text block after a chain or a thought', async () => {
    const port = await streaming()

    act(() => {
      port.text('s1', 'First I will check.')
      port.thinking('s1', 'which test names it')
      port.toolStarted('s1', 'c1', 'bash', 'npm test')
      port.toolEnded('s1', 'c1', true, 'ok')
      port.text('s1', 'They pass.')
      port.endTurn('s1')
    })

    expect(transcriptItems()).toEqual(['msg agent', 'think', 'chain done', 'msg agent'])
    expect(screen.getByText('First I will check.')).toBeInTheDocument()
    expect(screen.getByText('They pass.')).toBeInTheDocument()
  })
})
