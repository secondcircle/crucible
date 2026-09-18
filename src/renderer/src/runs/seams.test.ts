// @vitest-environment node
//
// The two seams a node's transcript carries: where the node stopped, and
// where a resume picked it up again. Both are derived from the record and the
// stored items, so neither needs a window.
import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '../../../shared/agent/port'
import {
  CONTINUED_NODE_MESSAGE,
  type RunNode,
  type RunRecord
} from '../../../shared/workflows/run'
import { transcriptWithSeams } from './seams'

const NOW = new Date('2026-08-21T14:00:00.000Z').getTime()

function nodeOf(overrides: Partial<RunNode> = {}): RunNode {
  return {
    id: 'fixer-1',
    status: 'failed',
    parents: [],
    reads: [],
    artifacts: [],
    startedAt: '2026-08-21T12:00:00.000Z',
    endedAt: '2026-08-21T13:19:00.000Z',
    ...overrides
  }
}

function runOf(overrides: Partial<RunRecord> = {}, ...nodes: RunNode[]): RunRecord {
  return {
    id: '779a',
    workflow: 'build',
    status: 'failed',
    workspacePath: '/repos/crucible',
    workspaceName: 'crucible',
    sessionId: 's1',
    inputs: {},
    nodes: nodes.length === 0 ? [nodeOf()] : nodes,
    createdAt: '2026-08-21T11:00:00.000Z',
    startedAt: '2026-08-21T11:00:00.000Z',
    ...overrides
  }
}

const SAID: readonly TranscriptItem[] = [
  { kind: 'assistant', markdown: 'moving the replay into its own module' },
  { kind: 'tool', name: 'bash', summary: 'git mv …', ok: false, output: 'ENOENT' }
]

const rules = (items: readonly { readonly kind: string }[]): unknown[] =>
  items.filter((item) => item.kind === 'rule')

describe('the rule where a node stopped', () => {
  it('closes the transcript with the run’s own word for the stop, and when', () => {
    const shown = transcriptWithSeams(runOf(), nodeOf(), SAID, NOW)
    expect(shown).toHaveLength(3)
    expect(shown.at(-1)).toEqual({ kind: 'rule', tone: 'failed', text: 'failed here · 41m ago' })
  })

  // A cancelled run's node is recorded `failed` — the engine releases it when
  // the run ends — so the word has to come from the run, or the human is told
  // their own cancel was a failure.
  it('says cancelled for a cancelled run, whatever the node record says', () => {
    const shown = transcriptWithSeams(runOf({ status: 'cancelled' }), nodeOf(), SAID, NOW)
    expect(shown.at(-1)).toEqual({
      kind: 'rule',
      tone: 'cancelled',
      text: 'cancelled here · 41m ago'
    })
  })

  // Reproduction for review-1's finding. `stoppedNodes` returns every node the
  // engine will put back to work, which on a run with parallel nodes is not
  // only the node the stop caught: a node that failed an hour earlier, with
  // its own recorded error, is in that list too. Taking the word from the run
  // then tells the reader their cancel killed a node that died on its own,
  // and dates the cancel to when that node died. The fake flavor ships this
  // exact record (`cannedUnattended`: `spec-audit` failed, `builder` blocked)
  // — cancel that run in `npm run dev` and `spec-audit` reads
  // "cancelled here · 57m ago" under its own failure message.
  it('does not call a node cancelled when it failed on its own before the cancel', () => {
    const run = runOf(
      { status: 'cancelled', endedAt: '2026-08-21T13:59:40.000Z' },
      // Released by the cancel, seconds ago: this one the cancel did stop.
      nodeOf({ id: 'builder', endedAt: '2026-08-21T13:59:40.000Z' }),
      // Dead on its own an hour before anybody clicked Cancel.
      nodeOf({
        id: 'spec-audit',
        error: 'the audit ran out of context re-reading the spec, twice',
        endedAt: '2026-08-21T13:03:00.000Z'
      })
    )
    const audit = transcriptWithSeams(run, run.nodes[1], SAID, NOW).at(-1) as {
      readonly text: string
      readonly tone: string
    }
    expect(audit.text).not.toContain('cancelled')
    expect(audit.tone).not.toBe('cancelled')
  })

  it('draws nothing on a run that can still move itself', () => {
    const running = runOf({ status: 'running' }, nodeOf({ status: 'running', endedAt: undefined }))
    expect(rules(transcriptWithSeams(running, running.nodes[0], SAID, NOW))).toEqual([])
  })

  // The stopped node is the one the engine will act on. A record a clean
  // restart superseded is history: the run stopped somewhere else.
  it('draws nothing on the record a revision superseded', () => {
    const run = runOf(
      {},
      nodeOf({ id: 'fixer-1' }),
      nodeOf({ id: 'fixer-1·r1', parents: ['fixer-1'] })
    )
    expect(rules(transcriptWithSeams(run, run.nodes[0], SAID, NOW))).toEqual([])
    expect(rules(transcriptWithSeams(run, run.nodes[1], SAID, NOW))).toHaveLength(1)
  })
})

describe('the rule where a resume picked the node up', () => {
  it('sits above the message Crucible sent the node, once per pick-up', () => {
    const run = runOf({ status: 'running' }, nodeOf({ status: 'running', endedAt: undefined }))
    const items: readonly TranscriptItem[] = [
      ...SAID,
      { kind: 'user', text: `${CONTINUED_NODE_MESSAGE}\n\nAnd one monitor was lost.` },
      { kind: 'assistant', markdown: 'the move never landed; trying again' },
      { kind: 'user', text: CONTINUED_NODE_MESSAGE },
      { kind: 'assistant', markdown: 'back at it' }
    ]
    const shown = transcriptWithSeams(run, run.nodes[0], items, NOW)
    expect(rules(shown)).toEqual([
      { kind: 'rule', tone: 'resumed', text: 'resumed · picked up from here' },
      { kind: 'rule', tone: 'resumed', text: 'resumed · picked up from here' }
    ])
    // Above the message, never below it: what the node was told is the first
    // thing under the rule.
    expect(shown[2]).toEqual({ kind: 'rule', tone: 'resumed', text: 'resumed · picked up from here' })
    expect(shown[3]).toMatchObject({ kind: 'user' })
  })

  it('leaves a node that was never resumed exactly as it was said', () => {
    const run = runOf({ status: 'running' }, nodeOf({ status: 'running', endedAt: undefined }))
    const items: readonly TranscriptItem[] = [
      { kind: 'user', text: 'Apply the findings in review-1.md.' },
      ...SAID
    ]
    expect(transcriptWithSeams(run, run.nodes[0], items, NOW)).toHaveLength(items.length)
  })
})
