// @vitest-environment node
//
// The reducer is pure, so a delivered message's two rules are provable without
// a DOM: it lands where it was delivered, and a stale one changes nothing.
import { describe, expect, it } from 'vitest'
import type { PortEvent } from '../../../shared/agent/port'
import { NOTHING_YET, reduce, type ShellState } from './shell-state'

const AT = 1_000

function heard(state: ShellState, event: PortEvent): ShellState {
  return reduce(state, { type: 'event', event, at: AT })
}

function working(): ShellState {
  return heard(NOTHING_YET, { type: 'turn_started', sessionId: 's1', turnId: 't-1' })
}

const items = (state: ShellState) => state.views.s1?.items ?? []

describe('a message the port delivered itself', () => {
  it('appends a user item and settles the streaming block before it', () => {
    let state = heard(working(), {
      type: 'text_delta',
      sessionId: 's1',
      turnId: 't-1',
      delta: 'reading the tests'
    })

    state = heard(state, {
      type: 'user_message',
      sessionId: 's1',
      turnId: 't-1',
      text: 'check the adapter too'
    })

    expect(items(state)).toEqual([
      { kind: 'assistant', markdown: 'reading the tests', streaming: false },
      { kind: 'user', text: 'check the adapter too' }
    ])
  })

  // The existing user item, thumbnails and all: nothing tells a steered
  // picture apart from a prompted one.
  it('carries the images the delivered message held', () => {
    const images = [{ mimeType: 'image/png', data: 'AAAAAA==' }]

    const state = heard(working(), {
      type: 'user_message',
      sessionId: 's1',
      turnId: 't-1',
      text: 'look at this',
      images
    })

    expect(items(state)).toEqual([{ kind: 'user', text: 'look at this', images }])
  })

  // Crucible's own message wears the card it was sent with, so nothing on
  // screen mistakes a wake for something the user typed. The transcript learns
  // nothing about monitors from it: badge, tone, title, meta, body.
  it('is a system item, never a user one, when it carries a card', () => {
    const card = {
      badge: 'monitor',
      tone: 'monitor',
      title: 'CI on PR #482 to finish',
      meta: 'condition met · 6m 40s · 13 checks',
      body: 'last output: completed'
    } as const

    const state = heard(working(), {
      type: 'user_message',
      sessionId: 's1',
      turnId: 't-1',
      text: '⏳ Crucible monitor m-1f3a — condition met: CI on PR #482 to finish',
      card
    })

    expect(items(state)).toEqual([
      {
        kind: 'system',
        text: '⏳ Crucible monitor m-1f3a — condition met: CI on PR #482 to finish',
        card
      }
    ])
  })

  // A restored transcript reads a delivered message back as the user message
  // it is stored as: the card is live presentation, not a stored fact.
  it('produces no system item from restored history', () => {
    const state = reduce(NOTHING_YET, {
      type: 'loaded',
      sessionId: 's1',
      items: [{ kind: 'user', text: '⏳ Crucible monitor m-1f3a — condition met: CI' }]
    })
    expect(items(state)).toEqual([
      { kind: 'user', text: '⏳ Crucible monitor m-1f3a — condition met: CI' }
    ])
  })

  it('changes nothing when it names a turn that is over', () => {
    const state = working()

    const after = heard(state, {
      type: 'user_message',
      sessionId: 's1',
      turnId: 't-0',
      text: 'from a dead turn'
    })

    expect(after).toBe(state)
  })
})

describe('a flush', () => {
  it('leaves the transcript alone: what it hands back goes to the composer', () => {
    const state = working()

    const after = heard(state, {
      type: 'queue_flushed',
      sessionId: 's1',
      messages: [{ kind: 'steering', text: 'redirect' }]
    })

    expect(after).toBe(state)
  })
})
