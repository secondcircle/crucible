// The renderer's entry point is a module whose interface is what it does when
// the browser loads it: it finds `#root` in the document the app ships and
// mounts the pane there against a port it builds itself. So the test loads it
// the way `index.html` does — import for effect, into a document that has the
// same `#root` — and asserts only on what a person then sees on screen. It
// never reaches for `mountApp`, which is private to the module, and it never
// hands the module a port: which adapter the app launches with is exactly what
// is under test here.
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** The reply the launched app answers with today, written out independently. */
const CANNED_REPLY =
  'Hello from the fake adapter.' +
  ' Nothing was sent anywhere and nothing was paid for this reply.'

/** `index.html` is the module's real environment: one empty `#root`. */
function pageWithRoot(): void {
  document.body.innerHTML = '<div id="root"></div>'
}

/** Loads the entry point for effect, as a script tag would. */
async function launch(): Promise<void> {
  await act(async () => {
    await import('./main')
  })
}

beforeEach(() => {
  vi.resetModules()
  document.body.innerHTML = ''
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('the renderer entry point', () => {
  it('mounts the chat pane on #root against a port that answers', async () => {
    vi.useFakeTimers()
    pageWithRoot()

    await launch()

    // The scaffold's placeholder is gone: what launches now is the pane.
    expect(screen.getByRole('heading', { name: 'Crucible' })).toBeInTheDocument()
    expect(screen.queryByText('Scaffold running.')).toBeNull()
    const transcript = screen.getByRole('list', { name: 'Transcript' })
    expect(within(transcript).queryAllByLabelText('You')).toEqual([])

    // Whatever port the entry point built, it answers a prompt — nothing else
    // in the app has to be wired for the launched window to hold a conversation.
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'Hello agent' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(within(transcript).getByLabelText('You').textContent).toBe('Hello agent')

    // The reply streams in on a clock — the launch flavour is the fake adapter
    // at its own cadence (D5), not a port that answers all at once.
    const agent = (): HTMLElement => within(transcript).getAllByLabelText('Agent')[0]
    expect(agent().textContent).toBe('')
    let beats = 0
    while (agent().textContent !== CANNED_REPLY) {
      beats += 1
      expect(beats).toBeLessThan(1000)
      await act(async () => {
        await vi.advanceTimersToNextTimerAsync()
      })
    }
    expect(beats).toBeGreaterThan(1)

    await act(async () => {
      await vi.advanceTimersToNextTimerAsync()
    })
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled() // the box is empty again
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('refuses to launch into a document without #root', async () => {
    await expect(import('./main')).rejects.toThrow('renderer: #root is missing from index.html')
    expect(document.body.innerHTML).toBe('')
  })
})
