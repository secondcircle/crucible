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

// Following the stream reads scrollHeight, which in Chromium forces a layout
// of the whole list before paint. The document re-renders for events that say
// nothing about the transcript, and those must not pay for it.
describe('following the stream', () => {
  function countScrollHeightReads(): () => number {
    const scroller = document.querySelector('.chat')
    if (scroller === null) throw new Error('no transcript scroller')
    let reads = 0
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => {
        reads += 1
        return 0
      }
    })
    return () => reads
  }

  it('reads the layout when the transcript moved, and not when it did not', () => {
    const items: readonly ViewItem[] = [
      { kind: 'user', text: 'hello' },
      { kind: 'assistant', markdown: 'hi', streaming: false }
    ]
    const view = render(<Transcript items={items} sessionId="s1" />)
    const reads = countScrollHeightReads()

    // The same list again: a runs broadcast, a schedule tick, the clock.
    view.rerender(<Transcript items={items} sessionId="s1" />)
    expect(reads()).toBe(0)

    // What the reducer hands over when a delta lands: a new array.
    view.rerender(
      <Transcript
        items={[items[0], { kind: 'assistant', markdown: 'hi there', streaming: true }]}
        sessionId="s1"
      />
    )
    expect(reads()).toBeGreaterThan(0)
  })
})

describe('a column that is put away', () => {
  const LONG: readonly ViewItem[] = Array.from({ length: 40 }, (_, at) => ({
    kind: 'assistant' as const,
    markdown: `paragraph ${at}`,
    streaming: false
  }))

  /** jsdom lays nothing out, so the scroller is given the dimensions a browser would. */
  function measure(height = 8000): HTMLElement {
    const scroller = document.querySelector('.chat')
    if (scroller === null) throw new Error('no transcript scroller')
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => height })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 600 })
    return scroller as HTMLElement
  }

  function scrollTo(scroller: HTMLElement, offset: number): void {
    scroller.scrollTop = offset
    fireEvent.scroll(scroller)
  }

  // A browser throws the scrolling box away with the layout box, so the offset
  // is not there to come back on its own. Without this the test would pass
  // against code that restores nothing.
  function hide(scroller: HTMLElement): void {
    scroller.scrollTop = 0
  }

  it('puts the reader back where they were reading', () => {
    const view = render(<Transcript items={LONG} sessionId="s1" shown />)
    const scroller = measure()
    scrollTo(scroller, 2200)

    view.rerender(<Transcript items={LONG} sessionId="s1" shown={false} />)
    hide(scroller)
    view.rerender(<Transcript items={LONG} sessionId="s1" shown />)

    expect(scroller.scrollTop).toBe(2200)
  })

  it('leaves a reader who was following the stream at the bottom', () => {
    const view = render(<Transcript items={LONG} sessionId="s1" shown />)
    const scroller = measure()
    // Within a line or two of the end, which still counts as following.
    scrollTo(scroller, 7400)

    view.rerender(<Transcript items={LONG} sessionId="s1" shown={false} />)
    hide(scroller)
    view.rerender(<Transcript items={LONG} sessionId="s1" shown />)

    expect(scroller.scrollTop).toBe(8000)
  })

  it('lets no delta that lands while it is away move the reader', () => {
    const view = render(<Transcript items={LONG} sessionId="s1" shown />)
    const scroller = measure()
    scrollTo(scroller, 2200)

    view.rerender(<Transcript items={LONG} sessionId="s1" shown={false} />)
    hide(scroller)
    for (const at of [1, 2, 3]) {
      view.rerender(
        <Transcript
          items={[...LONG, { kind: 'assistant', markdown: `late ${at}`, streaming: true }]}
          sessionId="s1"
          shown={false}
        />
      )
      expect(scroller.scrollTop).toBe(0)
    }

    view.rerender(<Transcript items={LONG} sessionId="s1" shown />)

    expect(scroller.scrollTop).toBe(2200)
  })

  it('starts a session at its bottom however the last one was left', () => {
    const view = render(<Transcript items={LONG} sessionId="s1" shown />)
    const scroller = measure()
    scrollTo(scroller, 2200)

    view.rerender(<Transcript items={LONG} sessionId="s2" shown />)

    expect(scroller.scrollTop).toBe(8000)
  })

  it('is on screen for every caller that says nothing about it', () => {
    render(<Transcript items={LONG} sessionId="s1" />)
    const scroller = measure()
    scrollTo(scroller, 2200)

    expect(scroller.scrollTop).toBe(2200)
  })
})
