// The transcript's rows are memoized, because every port event re-renders the
// whole document and a long session has thousands of them. What that must not
// buy: a row that shows something the state no longer says. These drive the
// real component through the changes a stream makes, one item at a time.
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { sameChain, Transcript } from './Transcript'
import type { ViewItem } from '../state/shell-state'
import type { ToolChain, ToolItem } from '../state/tool-chains'

function tool(over: Partial<ToolItem> = {}): ViewItem {
  return {
    kind: 'tool',
    callId: 'c1',
    name: 'bash',
    summary: 'npm test',
    output: '',
    running: true,
    ...over
  }
}

function chainOf(calls: readonly ToolItem[]): ToolChain {
  return {
    key: 'c1',
    calls,
    counts: [{ name: 'bash', count: 1 }],
    errors: 0,
    state: 'running',
    label: 'running'
  }
}

describe('a transcript that keeps streaming', () => {
  it('grows the assistant text without disturbing the tool row above it', () => {
    const call = tool({ output: 'ran 1 test', running: false, ok: true })
    const first: readonly ViewItem[] = [
      { kind: 'user', text: 'run the tests' },
      call,
      { kind: 'assistant', markdown: 'They ', streaming: true }
    ]
    const view = render(<Transcript items={first} sessionId="s1" />)
    fireEvent.click(screen.getByRole('button', { name: /Tool chain/ }))
    fireEvent.click(screen.getByRole('button', { name: 'bash npm test' }))
    expect(screen.getByText('ran 1 test')).toBeTruthy()

    // What the reducer does on a delta: one item replaced, every other item
    // the same object it already was.
    view.rerender(
      <Transcript
        items={[first[0], call, { kind: 'assistant', markdown: 'They pass.', streaming: false }]}
        sessionId="s1"
      />
    )

    expect(screen.getByText('They pass.')).toBeTruthy()
    // The chain stayed open across the re-render, and still shows its output.
    expect(screen.getByText('ran 1 test')).toBeTruthy()
  })

  it("shows a running call's new output as it arrives", () => {
    const opening = tool({ output: 'compiling' })
    const view = render(<Transcript items={[opening]} sessionId="s1" />)
    // A running call shows its output as soon as the chain holding it opens.
    fireEvent.click(screen.getByRole('button', { name: /Tool chain/ }))
    expect(screen.getByText('compiling')).toBeTruthy()

    view.rerender(<Transcript items={[tool({ output: 'compiling\nlinking' })]} sessionId="s1" />)

    expect(screen.getByText(/linking/)).toBeTruthy()
  })

  it('re-renders a chain whose call settled, even at the same length', () => {
    const running = tool() as ToolItem
    const settled = tool({ running: false, ok: false, output: 'exit 1' }) as ToolItem

    expect(sameChain({ chain: chainOf([running]) }, { chain: chainOf([running]) })).toBe(true)
    expect(sameChain({ chain: chainOf([running]) }, { chain: chainOf([settled]) })).toBe(false)
  })

  it('re-renders a chain that gained a call, or whose counts moved', () => {
    const one = tool() as ToolItem
    const two = tool({ callId: 'c2' }) as ToolItem
    const grown = { ...chainOf([one, two]), counts: [{ name: 'bash', count: 2 }] }

    expect(sameChain({ chain: chainOf([one]) }, { chain: grown })).toBe(false)
    expect(
      sameChain(
        { chain: chainOf([one]) },
        { chain: { ...chainOf([one]), counts: [{ name: 'bash', count: 2 }] } }
      )
    ).toBe(false)
    expect(
      sameChain({ chain: chainOf([one]) }, { chain: { ...chainOf([one]), state: 'failed' } })
    ).toBe(false)
  })
})
