import { describe, expect, it } from 'vitest'
import { escapeRung, type EscapeRung, type EscapeState } from './escape'

const NOTHING_UP: EscapeState = {
  loginOpen: false,
  expiryChoiceOpen: false,
  confirmOpen: false,
  popoverOpen: false,
  commandPopoverOpen: false,
  filePopoverOpen: false,
  graphFullScreen: false,
  artifactReaderOpen: false,
  panelMaximized: false,
  summarizeCancellable: false,
  treeOpen: false,
  regionOccupied: false,
  turnCancellable: false
}

function up(over: Partial<EscapeState>): EscapeState {
  return { ...NOTHING_UP, ...over }
}

const window_ = (over: Partial<EscapeState>): EscapeRung => escapeRung('window', up(over))
const exhibit = (over: Partial<EscapeState>): EscapeRung => escapeRung('exhibit', up(over))

// Every rung and the state that reaches it. `yieldsToRegion` marks the two
// that wait for an overlay to come off first — the maximized panel and a
// summarize — which is a guard rather than a place in the order.
const LADDER: ReadonlyArray<{
  readonly rung: EscapeRung
  readonly state: Partial<EscapeState>
  readonly yieldsToRegion?: true
}> = [
  { rung: 'closeLogin', state: { loginOpen: true } },
  { rung: 'answerExpiryChoice', state: { expiryChoiceOpen: true } },
  { rung: 'closeConfirm', state: { confirmOpen: true } },
  { rung: 'closePopover', state: { popoverOpen: true } },
  { rung: 'closeCommandPopover', state: { commandPopoverOpen: true } },
  { rung: 'closeFilePopover', state: { filePopoverOpen: true } },
  { rung: 'leaveGraphFullScreen', state: { graphFullScreen: true, regionOccupied: true } },
  { rung: 'closeArtifactReader', state: { artifactReaderOpen: true, regionOccupied: true } },
  { rung: 'unmaximizePanel', state: { panelMaximized: true }, yieldsToRegion: true },
  { rung: 'cancelSummarize', state: { summarizeCancellable: true }, yieldsToRegion: true },
  { rung: 'closeTopOfRegion', state: { regionOccupied: true } },
  { rung: 'cancelTurn', state: { turnCancellable: true } },
  { rung: 'none', state: {} }
]

describe('the ladder, in order', () => {
  it('fires each rung on its own condition', () => {
    for (const step of LADDER) expect(window_(step.state)).toBe(step.rung)
  })

  it('takes the topmost surface that is up and stops there', () => {
    for (const [at, step] of LADDER.entries()) {
      for (const lower of LADDER.slice(at + 1)) {
        const both = { ...lower.state, ...step.state }
        const answer =
          step.yieldsToRegion === true && lower.rung === 'closeTopOfRegion'
            ? 'closeTopOfRegion'
            : step.rung
        expect(window_(both)).toBe(answer)
      }
    }
  })

  it('answers nothing when nothing is up, which is the accelerator\u2019s press', () => {
    expect(window_({})).toBe('none')
  })
})

describe('a maximized panel', () => {
  it('comes off before a summarize, a turn and the tree accelerator', () => {
    expect(
      window_({ panelMaximized: true, summarizeCancellable: true, turnCancellable: true })
    ).toBe('unmaximizePanel')
  })

  it('waits for the region to empty, so an overlay closes first', () => {
    expect(window_({ panelMaximized: true, regionOccupied: true })).toBe('closeTopOfRegion')
    expect(window_({ panelMaximized: true, regionOccupied: true, graphFullScreen: true })).toBe(
      'leaveGraphFullScreen'
    )
    expect(
      window_({ panelMaximized: true, regionOccupied: true, artifactReaderOpen: true })
    ).toBe('closeArtifactReader')
    expect(window_({ panelMaximized: true, confirmOpen: true })).toBe('closeConfirm')
    expect(window_({ panelMaximized: true })).toBe('unmaximizePanel')
  })

  it('comes off before a summarize the tree is showing, as the graph does', () => {
    expect(
      window_({
        panelMaximized: true,
        summarizeCancellable: true,
        treeOpen: true,
        regionOccupied: true
      })
    ).toBe('cancelSummarize')
  })
})

describe('the rungs this work did not touch', () => {
  it('leaves a split panel\u2019s ladder exactly as it was', () => {
    expect(window_({ turnCancellable: true })).toBe('cancelTurn')
    expect(window_({ regionOccupied: true, turnCancellable: true })).toBe('closeTopOfRegion')
    expect(window_({ summarizeCancellable: true, turnCancellable: true })).toBe('cancelSummarize')
    expect(window_({ summarizeCancellable: true, regionOccupied: true })).toBe('closeTopOfRegion')
    expect(window_({ summarizeCancellable: true, regionOccupied: true, treeOpen: true })).toBe(
      'cancelSummarize'
    )
  })
})

describe('an Escape out of an exhibit guest', () => {
  it('leaves a maximized panel, wherever the region and the turn stand', () => {
    expect(exhibit({ panelMaximized: true })).toBe('unmaximizePanel')
    expect(exhibit({ panelMaximized: true, turnCancellable: true })).toBe('unmaximizePanel')
    expect(exhibit({ panelMaximized: true, summarizeCancellable: true })).toBe('unmaximizePanel')
  })

  it('does nothing else, ever: every other state answers none', () => {
    for (const step of LADDER) {
      if (step.rung === 'unmaximizePanel') continue
      expect(exhibit(step.state)).toBe('none')
    }
    // Including the states where the window would close an overlay over the
    // maximized panel, or stop the turn under it.
    expect(exhibit({ panelMaximized: true, regionOccupied: true })).toBe('none')
    expect(exhibit({ turnCancellable: true })).toBe('none')
    expect(exhibit({})).toBe('none')
  })
})
