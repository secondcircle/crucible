// @vitest-environment node
//
// The reducer is pure, so the two rules a delivered message has to obey are
// provable without a DOM: it lands where it was delivered, and a stale one
// changes nothing.
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
