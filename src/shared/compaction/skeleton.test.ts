import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '../agent/port'
import { WAKE_MESSAGE_PREFIX } from '../monitors/wording'
import { ANSWER_BATCH_PREFIX } from '../questions/wording'
import { RUN_MESSAGE_PREFIX } from '../workflows/run'
import {
  pruneSkeleton,
  reclassifySkeleton,
  renderSkeleton,
  skeletonOf,
  skeletonTokens,
  type SkeletonLine
} from './skeleton'

const SPAN: readonly TranscriptItem[] = [
  { kind: 'user', text: 'Make the retry policy the same in both clients.' },
  {
    kind: 'thinking',
    text: 'Long private reasoning that costs tokens and says nothing later.'
  },
  { kind: 'assistant', markdown: 'Reading both clients first.' },
  {
    kind: 'tool',
    name: 'read',
    summary: 'src/a/client.ts',
    ok: true,
    output: 'x'.repeat(4_000)
  },
  {
    kind: 'tool',
    name: 'bash',
    summary: 'npm test',
    ok: false,
    output: 'boom'
  },
  {
    kind: 'bashRun',
    command: 'git status',
    output: 'y'.repeat(400),
    exitCode: 0
  },
  { kind: 'summary', text: 'An earlier compaction’s own text.' },
  {
    kind: 'cacheMiss',
    miss: {
      tokensRebilled: 1,
      dollarsRebilled: 1,
      gapMs: 1,
      modelChanged: 'no',
      thinkingChanged: 'no',
      jump: 'no',
      retention: '1h'
    }
  },
  { kind: 'error', message: 'The provider refused.' }
]

describe('the skeleton', () => {
  it('keeps what was said, drops thinking, and leaves one line per call', () => {
    expect(skeletonOf(SPAN)).toEqual([
      { kind: 'user', text: 'Make the retry policy the same in both clients.' },
      { kind: 'assistant', text: 'Reading both clients first.' },
      {
        kind: 'call',
        name: 'read',
        handle: 'src/a/client.ts',
        ok: true,
        tokens: 1_000
      },
      { kind: 'call', name: 'bash', handle: 'npm test', ok: false, tokens: 1 },
      { kind: 'bashRun', command: 'git status', tokens: 100 },
      { kind: 'error', message: 'The provider refused.' }
    ])
  })

  // Summaries are rewritten whole at every compaction, so an earlier one never
  // becomes part of the next skeleton.
  it('never carries an earlier summary into the skeleton', () => {
    expect(
      skeletonOf(SPAN).some((line) => line.kind === 'assistant' && line.text.includes('earlier'))
    ).toBe(false)
  })

  // What the person said is the one thing a compaction cannot get back: the
  // session file and the transcript keep it, and the model can reach neither
  // afterwards. Length is the model's business, not a cut made before
  // anything is asked.
  it('keeps a long user message whole, however long it ran', () => {
    const spec = `Rewrite the importer. ${'The rows carry a provider, a model and a cost. '.repeat(80)}Stop once the tests pass.`
    expect(skeletonOf([{ kind: 'user', text: spec }])).toEqual([{ kind: 'user', text: spec }])
  })

  // A reply opens with what is waiting on the person; the account behind it
  // is what the trajectory summary is rewritten from at the same compaction.
  it('keeps a reply’s opening paragraph and counts the rest', () => {
    const reply =
      'One decision is waiting in your dock: whether I merge or you do.\n\n' +
      `The run came back approved. ${'Every requirement is met and pinned. '.repeat(40)}`
    expect(skeletonOf([{ kind: 'assistant', markdown: reply }])).toEqual([
      {
        kind: 'assistant',
        text: 'One decision is waiting in your dock: whether I merge or you do.',
        more: expect.any(Number)
      }
    ])
    expect(renderSkeleton(skeletonOf([{ kind: 'assistant', markdown: reply }]))).toMatch(
      /^1\. \[agent\] One decision is waiting in your dock: whether I merge or you do\. · \d+ more tok$/
    )
  })

  it('renders a one-paragraph reply as it was, with nothing counted', () => {
    expect(renderSkeleton(skeletonOf([{ kind: 'assistant', markdown: 'Done.' }]))).toBe(
      '1. [agent] Done.'
    )
  })

  // A run's report, a monitor's wake and an answer batch arrive in the user's
  // role, but nobody typed them and every fact in one is on a record. Kept
  // whole they are most of a skeleton, protected by a rule written for the
  // person's brief.
  it('keeps one line per message Crucible sent, naming what it announced', () => {
    const report =
      `${RUN_MESSAGE_PREFIX} 09fb (build) completed · branch crucible/run-09fb.\n\n` +
      `Outputs: ${JSON.stringify({ verdict: 'approved', reason: 'x'.repeat(4_000) })}`
    const wake = `${WAKE_MESSAGE_PREFIX} m1 ended: condition met.\n\nThe check printed nothing.`
    const answers = `${ANSWER_BATCH_PREFIX}. Every question you had open, answered.\n\n1. Merge?\n   Answer: yes`
    const lines = skeletonOf([
      { kind: 'user', text: report },
      { kind: 'user', text: wake },
      { kind: 'user', text: answers },
      { kind: 'user', text: 'Okay so everything is on main now?' }
    ])
    expect(lines.map((line) => line.kind)).toEqual(['notice', 'notice', 'notice', 'user'])
    expect(renderSkeleton(lines.slice(0, 1))).toMatch(
      /^1\. \[crucible\] ⚑ Crucible run 09fb \(build\) completed · branch crucible\/run-09fb\. · 1,0\d\d tok dropped$/
    )
  })

  // A handle is the one thing here with a ceiling: it has to be one line of a
  // list, and its first line is what identifies it.
  it('keeps a call’s handle to one line', () => {
    const [line] = skeletonOf([
      {
        kind: 'bashRun',
        command: `git log\n${'x'.repeat(2_000)}`,
        output: '',
        exitCode: 0
      }
    ])
    expect(line).toEqual({ kind: 'bashRun', command: 'git log', tokens: 0 })
  })

  it('states the handle a dropped result can be re-read or re-run from', () => {
    const lines = renderSkeleton(skeletonOf(SPAN))
    expect(lines).toContain('3. [read] src/a/client.ts → ok · 1,000 tok dropped')
    expect(lines).toContain('4. [bash] npm test → failed · 1 tok dropped')
    expect(lines).toContain('5. [bash run] git status → 100 tok dropped')
  })

  it('numbers from where an earlier block left off, so one list spans both', () => {
    expect(renderSkeleton(skeletonOf(SPAN).slice(0, 1), 41)).toBe(
      '41. [user] Make the retry policy the same in both clients.'
    )
  })

  it('strikes the lines the model named, by the numbers it read', () => {
    const lines = skeletonOf(SPAN)
    expect(pruneSkeleton(lines, [3, 4, 5])).toEqual([lines[0], lines[1], lines[5]])
  })
})

// The skeleton is carried from one compaction into the next as it was stored,
// and the `notice` kind is newer than the first skeletons. A build before it
// stored every run report as the person's words, and those lines rode along
// under the protection written for the person's brief.
describe('a skeleton an earlier build stored', () => {
  const report = `${RUN_MESSAGE_PREFIX} 09fb (build) completed · branch crucible/run-09fb\n\nOutputs: ${'x'.repeat(5_000)}`
  const stored: readonly SkeletonLine[] = [
    { kind: 'user', text: report },
    { kind: 'user', text: 'proceed' },
    {
      kind: 'user',
      text: `${ANSWER_BATCH_PREFIX}. Every question you had open, answered.\n\n1. Merge?\n   Answer: yes`
    },
    { kind: 'assistant', text: 'Merged.' },
    { kind: 'call', name: 'read', handle: 'a.ts', ok: true, tokens: 3 }
  ]

  it('is re-read with this build’s kinds: Crucible’s messages become notices', () => {
    expect(reclassifySkeleton(stored).map((line) => line.kind)).toEqual([
      'notice',
      'user',
      'notice',
      'assistant',
      'call'
    ])
  })

  it('gives a re-read notice the shape a fresh one has', () => {
    const [line] = reclassifySkeleton(stored)
    expect(line).toEqual(skeletonOf([{ kind: 'user', text: report }])[0])
  })

  it('leaves the person’s own words and every other kind exactly as stored', () => {
    expect(reclassifySkeleton(stored).slice(1, 2)).toEqual(stored.slice(1, 2))
    expect(reclassifySkeleton(stored).slice(3)).toEqual(stored.slice(3))
  })

  // Kept as the person's words, the two reports were 6k characters of
  // skeleton; as notices they are two lines.
  it('is a fraction of its stored size once re-read', () => {
    expect(skeletonTokens(reclassifySkeleton(stored))).toBeLessThan(skeletonTokens(stored) / 5)
  })
})

// The list is markdown, and a person's message is kept word for word. A blank
// line inside one ends the list: what follows renders renumbered from 1 and
// the second paragraph floats outside it, so the list reads as cut off and the
// numbers the model strikes by are not the numbers the reader sees.
describe('a line that spans paragraphs', () => {
  it('renders as one numbered item', () => {
    const rendered = renderSkeleton([
      { kind: 'user', text: 'first paragraph,\n\nsecond paragraph\nthird line' },
      { kind: 'user', text: 'next' }
    ])
    expect(rendered).toBe('1. [user] first paragraph, second paragraph third line\n2. [user] next')
  })
})
