// @vitest-environment jsdom
//
// Tool calls and thinking are the two regions most tempting to fake, so nothing
// here may appear without the event that earns it.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Shell } from './Shell'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'

async function streaming(): Promise<ScriptedPort> {
  const port = createScriptedPort(oneSession())
  render(<Shell port={port} />)
  await screen.findByRole('button', { name: /^Session · / })
  await act(async () => {
    await port.prompt('s1', 'run the tests')
  })
  return port
}

const transcriptItems = (): string[] =>
  Array.from(
    screen.getByRole('log', { name: 'Transcript' }).querySelectorAll('.items > li')
  ).map((item) => item.className || (item.firstElementChild?.className ?? ''))

describe('tool calls', () => {
  it('appear only when a tool event says so', async () => {
    const port = await streaming()

    act(() => port.text('s1', 'Running them now.'))
    expect(screen.queryByRole('button', { name: /npm test/ })).toBeNull()

    act(() => port.toolStarted('s1', 'c1', 'bash', 'npm test'))

    expect(screen.getByRole('button', { name: 'bash npm test' })).toBeInTheDocument()
  })

  it('show a running call with its live output, then a finished one', async () => {
    const port = await streaming()

    act(() => {
      port.toolStarted('s1', 'c1', 'bash', 'npm test')
      port.toolOutput('s1', 'c1', 'Test Files  3 passed\n')
    })

    const chip = screen.getByRole('button', { name: 'bash npm test' })
    expect(chip).toHaveTextContent('running')
    // While it runs, the output is shown without asking.
    expect(screen.getByText(/Test Files\s+3 passed/)).toBeInTheDocument()

    act(() => port.toolEnded('s1', 'c1', true, 'Test Files  3 passed\nTests  42 passed\n'))

    expect(chip).toHaveTextContent('done')
    expect(screen.queryByText(/Tests\s+42 passed/)).toBeNull()
  })

  it('expand and collapse a finished call on click', async () => {
    const port = await streaming()
    act(() => {
      port.toolStarted('s1', 'c1', 'bash', 'npm test')
      port.toolEnded('s1', 'c1', true, 'Tests  42 passed\n')
    })
    const chip = screen.getByRole('button', { name: 'bash npm test' })

    fireEvent.click(chip)
    expect(screen.getByText(/Tests\s+42 passed/)).toBeInTheDocument()

    fireEvent.click(chip)
    expect(screen.queryByText(/Tests\s+42 passed/)).toBeNull()
  })

  it('marks a call that failed as failed', async () => {
    const port = await streaming()

    act(() => {
      port.toolStarted('s1', 'c1', 'bash', 'grep -r adapter')
      port.toolEnded('s1', 'c1', false, 'exit 1')
    })

    expect(screen.getByRole('button', { name: 'bash grep -r adapter' })).toHaveTextContent('error')
  })

  it('stops spinning when the turn it was in was cancelled, claiming no outcome', async () => {
    const port = await streaming()
    act(() => port.toolStarted('s1', 'c1', 'bash', 'npm test'))

    await act(async () => {
      await port.cancel('s1')
    })

    const chip = screen.getByRole('button', { name: 'bash npm test' })
    expect(chip).toHaveTextContent('stopped')
    expect(chip).not.toHaveTextContent('done')
    expect(screen.getByText('Stopped')).toBeInTheDocument()
  })

  it('renders every tool the same way', async () => {
    const port = await streaming()

    act(() => {
      port.toolStarted('s1', 'c1', 'bash', 'npm test')
      port.toolEnded('s1', 'c1', true, 'ok')
      port.toolStarted('s1', 'c2', 'read', 'src/main/index.ts')
      port.toolEnded('s1', 'c2', true, 'ok')
    })

    const [first, second] = screen.getAllByRole('button', { name: /^(bash|read) / })
    expect(first.className).toBe(second.className)
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

    // A single dim element: the trace remains, and no "thought" toggle exists,
    // so nothing collapses and the transcript never shifts under the reader.
    expect(screen.getByText('weighing the two shapes')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /thought/ })).toBeNull()
  })
})

describe('arrival order', () => {
  it('opens a new text block after a tool or a thought', async () => {
    const port = await streaming()

    act(() => {
      port.text('s1', 'First I will check.')
      port.thinking('s1', 'which test names it')
      port.toolStarted('s1', 'c1', 'bash', 'npm test')
      port.toolEnded('s1', 'c1', true, 'ok')
      port.text('s1', 'They pass.')
      port.endTurn('s1')
    })

    expect(transcriptItems()).toEqual(['msg agent', 'think', 'tool ok', 'msg agent'])
    expect(screen.getByText('First I will check.')).toBeInTheDocument()
    expect(screen.getByText('They pass.')).toBeInTheDocument()
  })
})
