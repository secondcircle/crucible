// The per-session panel view, as the rules that move it: split, collapsed and
// maximized are one field, so the pairs that must never both be true cannot be
// written down at all.
import { describe, expect, it } from 'vitest'
import type { PanelState, SessionState } from '../../../shared/agent/port'
import {
  forgetEmptyPanels,
  panelPlace,
  panelViewOf,
  withPanelView,
  withShownTab,
  type PanelView,
  type PanelViews
} from './panel-view'

const TABS: PanelState = {
  tabs: [
    {
      id: 'plan',
      title: 'the plan',
      kind: 'markdown',
      shownAt: '2026-09-09T09:00:00.000Z',
      path: '/repos/crucible/docs/plan.md'
    }
  ],
  activeTabId: 'plan'
}

// The port never sends one — an empty panel is an absent panel — but the type
// admits it, and "no tabs means no panel" is the rule either way.
const EMPTY: PanelState = { tabs: [], activeTabId: 'plan' }

function session(id: string, panel?: PanelState): SessionState {
  return {
    id,
    workspaceId: 'w1',
    createdAt: '2026-09-09T09:00:00.000Z',
    working: false,
    fresh: false,
    ...(panel === undefined ? {} : { panel })
  }
}

const VIEWS: readonly PanelView[] = ['split', 'collapsed', 'maximized']

describe('what a session remembers', () => {
  it('is split for a session nothing was ever said about', () => {
    expect(panelViewOf({}, 's1')).toBe('split')
    expect(panelViewOf({ s2: 'maximized' }, 's1')).toBe('split')
  })

  it('is split when there is no session on screen at all', () => {
    expect(panelViewOf({ s1: 'maximized' }, undefined)).toBe('split')
  })

  it('reads back every view it was set to, over all nine transitions', () => {
    for (const from of VIEWS) {
      for (const to of VIEWS) {
        const held = withPanelView({}, 's1', from)
        expect(panelViewOf(withPanelView(held, 's1', to), 's1')).toBe(to)
      }
    }
  })

  it('says split by dropping the entry, so one fact has one spelling', () => {
    const maximized = withPanelView({}, 's1', 'maximized')
    expect(maximized).toEqual({ s1: 'maximized' })

    expect(withPanelView(maximized, 's1', 'split')).toEqual({})
  })

  it('hands the same record back when nothing moved', () => {
    const held: PanelViews = { s1: 'collapsed' }

    expect(withPanelView(held, 's1', 'collapsed')).toBe(held)
    expect(withPanelView({}, 's1', 'split')).toEqual({})
  })

  it('touches no other session, whatever it is told about one', () => {
    const held: PanelViews = { s1: 'maximized', s2: 'collapsed' }

    expect(withPanelView(held, 's1', 'collapsed')).toEqual({ s1: 'collapsed', s2: 'collapsed' })
    expect(withPanelView(held, 's1', 'split')).toEqual({ s2: 'collapsed' })
    expect(withPanelView(held, 's3', 'maximized')).toEqual({
      s1: 'maximized',
      s2: 'collapsed',
      s3: 'maximized'
    })
    // The record it was handed is never edited.
    expect(held).toEqual({ s1: 'maximized', s2: 'collapsed' })
  })
})

describe('a tab the agent shows', () => {
  it('opens a collapsed panel, as it does today', () => {
    expect(withShownTab({ s1: 'collapsed' }, 's1')).toEqual({})
  })

  it('leaves a maximized panel maximized', () => {
    const held: PanelViews = { s1: 'maximized' }

    expect(withShownTab(held, 's1')).toBe(held)
  })

  it('leaves a split panel split, and every other session alone', () => {
    expect(withShownTab({ s2: 'maximized' }, 's1')).toEqual({ s2: 'maximized' })
    expect(withShownTab({ s1: 'collapsed', s2: 'maximized' }, 's1')).toEqual({ s2: 'maximized' })
  })
})

describe('a memory for a panel that is gone', () => {
  it('goes with a session that has left the sidebar', () => {
    const held: PanelViews = { s1: 'maximized', s2: 'collapsed' }

    expect(forgetEmptyPanels(held, [session('s2', TABS)])).toEqual({ s2: 'collapsed' })
  })

  it('goes with the last tab, however the panel emptied', () => {
    const held: PanelViews = { s1: 'maximized' }

    // A close, an agent's panel_close and a session reset all present the
    // same way here: the session is still on the rail with no panel at all.
    expect(forgetEmptyPanels(held, [session('s1')])).toEqual({})
    expect(forgetEmptyPanels(held, [session('s1', EMPTY)])).toEqual({})
  })

  it('stays for as long as the panel does, whatever else changed', () => {
    const held: PanelViews = { s1: 'maximized' }
    // What a jump leaves behind: the same tabs, a new conversation under them.
    const jumped = [{ ...session('s1', TABS), title: 'after the jump' }]

    expect(forgetEmptyPanels(held, jumped)).toBe(held)
  })

  it('hands the same record back when it drops nothing', () => {
    const held: PanelViews = { s1: 'maximized', s2: 'collapsed' }
    const sessions = [session('s1', TABS), session('s2', TABS)]

    expect(forgetEmptyPanels(held, sessions)).toBe(held)
    expect(forgetEmptyPanels({}, sessions)).toEqual({})
  })
})

describe('what the panel area shows', () => {
  it('is nothing at all for a session with no tabs, whatever is remembered', () => {
    for (const view of VIEWS) {
      expect(panelPlace(undefined, view)).toBe('none')
      expect(panelPlace(EMPTY, view)).toBe('none')
    }
  })

  it('is the remembered view for a session that has tabs', () => {
    for (const view of VIEWS) expect(panelPlace(TABS, view)).toBe(view)
  })
})
