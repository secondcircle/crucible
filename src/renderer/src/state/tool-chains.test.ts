// @vitest-environment node
//
// The grouping rules are combinatorial — boundaries, mixed outcomes, calls cut
// off with their turn — so they are proved here, once, on the pure function,
// rather than one DOM assertion at a time.
import { describe, expect, it } from 'vitest'
import type { ViewItem } from './shell-state'
import { countsText, groupIntoChains, type ToolChain } from './tool-chains'

function call(
  callId: string,
  name: string,
  state: 'running' | 'ok' | 'failed' | 'stopped',
  summary = ''
): ViewItem {
  return {
    kind: 'tool',
    callId,
    name,
    summary,
    output: '',
    running: state === 'running',
    ok: state === 'ok' ? true : state === 'failed' ? false : undefined
  }
}

const text = (markdown: string): ViewItem => ({ kind: 'assistant', markdown, streaming: false })

const thought = (): ViewItem => ({ kind: 'thinking', text: 'weighing it', running: false })

function chains(items: readonly ViewItem[]): ToolChain[] {
  return groupIntoChains(items).flatMap((row) => (row.kind === 'chain' ? [row.chain] : []))
}

describe('what counts as one chain', () => {
  it('is every maximal run of consecutive calls', () => {
    const grouped = chains([
      call('a', 'bash', 'ok'),
      call('b', 'read', 'ok'),
      text('and so'),
      call('c', 'read', 'ok')
    ])

    expect(grouped.map((chain) => chain.calls.length)).toEqual([2, 1])
  })

  it('is ended by thinking, by text, by a delivered message and by a marker', () => {
    for (const between of [
      thought(),
      text('so far so good'),
      { kind: 'user', text: 'actually, check the tests' } as ViewItem,
      { kind: 'stopped' } as ViewItem,
      { kind: 'error', message: 'the provider is overloaded' } as ViewItem
    ]) {
      const grouped = chains([call('a', 'bash', 'ok'), between, call('b', 'bash', 'ok')])
      expect(grouped).toHaveLength(2)
    }
  })

  it('keeps the transcript in the order it happened', () => {
    const rows = groupIntoChains([
      text('first'),
      call('a', 'bash', 'ok'),
      call('b', 'bash', 'ok'),
      thought(),
      call('c', 'read', 'ok')
    ])

    expect(rows.map((row) => row.kind)).toEqual(['item', 'chain', 'item', 'chain'])
  })

  it('makes a chain of one of a lone call, in the same grammar', () => {
    const [chain] = chains([call('a', 'read', 'ok', 'package.json')])

    expect(chain.calls).toHaveLength(1)
    expect(countsText(chain.counts)).toBe('1 read')
    expect(chain.label).toBe('done')
  })

  it('names chains apart, so two of them never share expansion state', () => {
    const rows = groupIntoChains([call('a', 'bash', 'ok'), thought(), call('b', 'bash', 'ok')])

    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length)
  })
})

describe('what the collapsed row says', () => {
  it('counts settled calls per name, in order of first settlement', () => {
    const [chain] = chains([
      call('a', 'bash', 'ok'),
      call('b', 'read', 'ok'),
      call('c', 'bash', 'ok'),
      call('d', 'read', 'ok'),
      call('e', 'bash', 'ok')
    ])

    expect(countsText(chain.counts)).toBe('3 bash · 2 read')
  })

  it('counts a call only once it has ended, whichever way it ended', () => {
    const [chain] = chains([
      call('a', 'bash', 'ok'),
      call('b', 'bash', 'failed'),
      call('c', 'bash', 'running')
    ])

    expect(countsText(chain.counts)).toBe('2 bash')
  })

  it('describes the call running right now, and nothing once the chain settles', () => {
    const [running] = chains([
      call('a', 'bash', 'ok'),
      call('b', 'read', 'running', 'src/main/index.ts')
    ])
    const [settled] = chains([call('a', 'bash', 'ok')])

    expect(running.live).toMatchObject({ name: 'read', summary: 'src/main/index.ts' })
    expect(settled.live).toBeUndefined()
  })

  it('describes the most recently started call when two of them overlap', () => {
    const [chain] = chains([call('a', 'bash', 'running'), call('b', 'read', 'running')])

    expect(chain.live).toMatchObject({ name: 'read' })
  })

  it('says running while any call runs, and done when they are all in', () => {
    expect(chains([call('a', 'bash', 'running')])[0].label).toBe('running')
    expect(chains([call('a', 'bash', 'ok')])[0].label).toBe('done')
  })

  it('says a failure the moment it happens, and keeps saying it', () => {
    const [live] = chains([call('a', 'bash', 'failed'), call('b', 'read', 'running')])
    const [settled] = chains([
      call('a', 'bash', 'failed'),
      call('b', 'read', 'failed'),
      call('c', 'read', 'ok')
    ])

    // A collapsed row can never hide a failure, not even while later calls in
    // the same chain are still running.
    expect(live.label).toBe('1 error')
    expect(live.state).toBe('failed')
    // The spinner keeps spinning: work continues, and the chain says both.
    expect(live.live).toMatchObject({ name: 'read' })
    expect(settled.label).toBe('2 errors')
  })

  it('says stopped for a call cut off with its turn, inventing no outcome', () => {
    const [chain] = chains([call('a', 'bash', 'ok'), call('b', 'read', 'stopped')])

    expect(chain.label).toBe('stopped')
    expect(countsText(chain.counts)).toBe('1 bash')
  })
})
