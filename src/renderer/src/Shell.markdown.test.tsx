// @vitest-environment jsdom
//
// Markdown is where an agent's own text becomes what the window shows: the
// formatting a reply is entitled to, and the markup it must never get.
import { act, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Shell } from './Shell'
import { createScriptedPort, oneSession } from './testing/scripted-port'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { settled } from './testing/settled'

const REPLY = [
  'Two adapters implement the agent port.\n\n',
  '- the fake one is free\n',
  '- the SDK one is metered\n\n',
  '| flavor | cost |\n| --- | --- |\n| fake | none |\n\n',
  'Switching is `CRUCIBLE_AGENT=sdk`, described in [the mock](https://example.test/mock).\n\n',
  '```ts\nconst port = createIpcClient()\n```\n\n',
  'Raw: <b>bold?</b> <script>alert(1)</script>\n'
]

async function replyWith(deltas: readonly string[]): Promise<void> {
  const port = createScriptedPort(oneSession())
  render(<Shell port={port} workspace={createScriptedWorkspace()} />)
  await screen.findByRole('button', { name: /^Session · / })
  await settled()

  await act(async () => {
    await port.prompt('s1', 'compare the adapters')
  })
  act(() => {
    for (const delta of deltas) port.text('s1', delta)
    port.endTurn('s1')
  })
}

describe('an assistant reply', () => {
  it('renders the markdown a reply is entitled to', async () => {
    await replyWith(REPLY)

    expect(screen.getByText('the fake one is free').tagName).toBe('LI')
    expect(screen.getByText('the SDK one is metered').tagName).toBe('LI')

    const table = screen.getByRole('table')
    expect(within(table).getByRole('columnheader', { name: 'flavor' })).toBeInTheDocument()
    expect(within(table).getByRole('cell', { name: 'none' })).toBeInTheDocument()

    const inline = screen.getByText('CRUCIBLE_AGENT=sdk')
    expect(inline.tagName).toBe('CODE')
    expect(inline.closest('pre')).toBeNull()

    const fenced = screen.getByText('const port = createIpcClient()')
    expect(fenced.tagName).toBe('CODE')
    expect(fenced.closest('pre')).not.toBeNull()
  })

  it('streams into one block, and opens a new one only where the turn did', async () => {
    await replyWith(['Half a sentence', ' and the rest of it.'])

    expect(screen.getByText('Half a sentence and the rest of it.')).toBeInTheDocument()
  })
})

describe('what a reply can never do', () => {
  it('renders raw HTML as text rather than as elements', async () => {
    await replyWith(REPLY)

    const transcript = screen.getByRole('log', { name: 'Transcript' })
    expect(transcript.querySelector('script')).toBeNull()
    expect(transcript.querySelector('b')).toBeNull()
    expect(screen.getByText(/Raw: <b>bold\?<\/b> <script>alert\(1\)<\/script>/)).toBeInTheDocument()
  })

  it('renders a link that opens outside rather than navigating this window', async () => {
    await replyWith(REPLY)
    const before = window.location.href

    const link = screen.getByRole('link', { name: 'the mock' })
    expect(link).toHaveAttribute('href', 'https://example.test/mock')
    expect(link).toHaveAttribute('target', '_blank')

    act(() => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))

    expect(window.location.href).toBe(before)
  })

  it('refuses to make a link of an address the OS should never be handed', async () => {
    await replyWith(['Try [this](javascript:alert(1)) instead.\n'])

    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText(/\[this\]\(javascript:alert\(1\)\)/)).toBeInTheDocument()
  })
})

describe('a person\u2019s own message', () => {
  it('is plain text, whatever it looks like', async () => {
    const port = createScriptedPort(oneSession())
    render(<Shell port={port} workspace={createScriptedWorkspace()} />)
    await screen.findByRole('button', { name: /^Session · / })

    act(() => {
      port.emit({ type: 'state', snapshot: port.snapshotNow })
    })
    await act(async () => {
      await port.prompt('s1', '# not a heading, and `not code`')
    })
    act(() => {
      port.endTurn('s1')
    })

    // A settled transcript is what a restored one looks like, and a prompt is
    // text either way.
    expect(screen.queryByRole('heading', { name: 'not a heading, and `not code`' })).toBeNull()
  })
})
