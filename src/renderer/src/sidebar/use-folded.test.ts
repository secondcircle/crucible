// @vitest-environment jsdom
//
// The three verbs and no fourth. What is checked here is that one workspace's
// fold is its own, that a write never carries an id no workspace holds, and
// that nothing folds or unfolds without being asked.
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { WorkspaceState } from '../../../shared/agent/port'
import { memoryFoldedStore } from './folded-store'
import { useFolded } from './use-folded'

const WORKSPACES: readonly WorkspaceState[] = [
  { id: 'w1', name: 'crucible', path: '/repos/crucible' },
  { id: 'w2', name: 'camping', path: '/repos/camping' },
  { id: 'w3', name: 'redball', path: '/repos/redball' }
]

function folding(seed: readonly string[] = []): {
  readonly hook: ReturnType<typeof renderHook<ReturnType<typeof useFolded>, unknown>>
  readonly store: ReturnType<typeof memoryFoldedStore>
} {
  const store = memoryFoldedStore(seed)
  const hook = renderHook(() => useFolded(store, WORKSPACES))
  return { hook, store }
}

describe('the folded set', () => {
  it('starts as the store left it', () => {
    const { hook } = folding(['w2'])

    expect([...hook.result.current.folded]).toEqual(['w2'])
  })

  it('folds an open workspace and unfolds a folded one', () => {
    const { hook } = folding()

    act(() => hook.result.current.toggle('w1'))
    expect([...hook.result.current.folded]).toEqual(['w1'])

    act(() => hook.result.current.toggle('w1'))
    expect([...hook.result.current.folded]).toEqual([])
  })

  it('leaves every other workspace exactly as it was', () => {
    const { hook } = folding(['w2'])

    act(() => hook.result.current.toggle('w1'))

    expect([...hook.result.current.folded].sort()).toEqual(['w1', 'w2'])
  })

  it('unfolds only what is folded, and folds nothing on the way', () => {
    const { hook } = folding(['w2'])

    act(() => hook.result.current.unfold('w2'))
    act(() => hook.result.current.unfold('w1'))

    expect([...hook.result.current.folded]).toEqual([])
  })

  it('folds everything handed to it and unfolds nothing', () => {
    const { hook } = folding(['w2'])

    act(() => hook.result.current.foldAll(['w1', 'w3']))

    expect([...hook.result.current.folded].sort()).toEqual(['w1', 'w2', 'w3'])
  })
})

describe('what is written', () => {
  it('goes to the store on every change, for the next launch to read', () => {
    const { hook, store } = folding()

    act(() => hook.result.current.toggle('w3'))

    expect([...store.read()]).toEqual(['w3'])
  })

  // The record is not a second list of workspaces: an id whose workspace is
  // gone drops on the next write rather than living there forever.
  it('drops ids of workspaces that no longer exist', () => {
    const { hook, store } = folding(['gone'])

    act(() => hook.result.current.toggle('w1'))

    expect([...store.read()]).toEqual(['w1'])
    // In memory it is still there, because pruning is a fact about the record
    // and never about what is folded.
    expect([...hook.result.current.folded].sort()).toEqual(['gone', 'w1'])
  })

  it('writes nothing at all until something changes', () => {
    const store = memoryFoldedStore(['w2'])
    renderHook(() => useFolded(store, []))

    expect([...store.read()]).toEqual(['w2'])
  })
})
