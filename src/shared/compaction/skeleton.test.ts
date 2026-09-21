import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '../agent/port'
import { WAKE_MESSAGE_PREFIX } from '../monitors/wording'
import { composeAnswerBatch } from '../questions/wording'
import type { Question } from '../agent/port'
import { RUN_MESSAGE_PREFIX } from '../workflows/run'
import {
  pruneSkeleton,
  renderSkeleton,
  skeletonOf,
  skeletonTokens,
  trimSkeleton,
  type SkeletonLine
} from './skeleton'

function questionOf(question: string): Question {
  return {
    id: question,
    question,
    context: 'context',
    recommendation: 'the recommendation',
    askedAt: '2026-09-10T10:00:00.000Z'
  }
}

const SPAN: readonly TranscriptItem[] = [
  { kind: 'user', text: 'Make the retry policy the same in both clients.' },
  { kind: 'thinking', text: 'Long private reasoning that costs tokens and says nothing later.' },
  { kind: 'assistant', markdown: 'Reading both clients first.' },
  { kind: 'tool', name: 'read', summary: 'src/a/client.ts', ok: true, output: 'x'.repeat(4_000) },
  { kind: 'tool', name: 'bash', summary: 'npm test', ok: false, output: 'boom' },
  { kind: 'bashRun', command: 'git status', output: 'y'.repeat(400), exitCode: 0 },
  { kind: 'summary', text: 'An earlier compaction’s own text.' },
  { kind: 'cacheMiss', miss: { tokensRebilled: 1, dollarsRebilled: 1, gapMs: 1, modelChanged: 'no', thinkingChanged: 'no', jump: 'no', retention: '1h' } },
  { kind: 'error', message: 'The provider refused.' }
]

describe('the skeleton', () => {
  it('keeps what was said, drops thinking, and leaves one line per call', () => {
    expect(skeletonOf(SPAN)).toEqual([
      { kind: 'user', text: 'Make the retry policy the same in both clients.' },
      { kind: 'assistant', text: 'Reading both clients first.' },
      { kind: 'call', name: 'read', handle: 'src/a/client.ts', ok: true, tokens: 1_000 },
      { kind: 'call', name: 'bash', handle: 'npm test', ok: false, tokens: 1 },
      { kind: 'bashRun', command: 'git status', tokens: 100 },
      { kind: 'error', message: 'The provider refused.' }
    ])
  })

  // Summaries are rewritten whole at every compaction, so an earlier one never
  // becomes part of the next skeleton.
  it('never carries an earlier summary into the skeleton', () => {
    expect(skeletonOf(SPAN).some((line) => line.kind === 'assistant' && line.text.includes('earlier'))).toBe(
      false
    )
  })

  // What the person said is the one thing a compaction cannot get back: the
  // session file and the transcript keep it, and the model can reach neither
  // afterwards. Length is the budget's business and the model's, not a cut
  // made before anything is asked.
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
    const lines = skeletonOf([
      { kind: 'user', text: report },
      { kind: 'user', text: wake },
      { kind: 'user', text: 'Okay so everything is on main now?' }
    ])
    expect(lines.map((line) => line.kind)).toEqual(['notice', 'notice', 'user'])
    expect(renderSkeleton(lines.slice(0, 1))).toMatch(
      /^1\. \[crucible\] ⚑ Crucible run 09fb \(build\) completed · branch crucible\/run-09fb\. · 1,0\d\d tok dropped$/
    )
  })

  // An answer batch is Crucible's envelope, but what is inside it is the
  // person's ruling, and in a session run through the ask tool it is most of
  // what they ever said. Measured on a real session: eleven batches reduced
  // to eleven identical headers, and the compacted agent could say what was
  // decided but not what the user said or why.
  it('keeps what the person typed in an answer batch, as their own words', () => {
    const batch = composeAnswerBatch([
      {
        question: questionOf('Which counter do you want: A, B or C?'),
        reply: { kind: 'answered', text: 'B looks better, but should days be its own column?' }
      },
      { question: questionOf('Freeze the counter when a job closes?'), reply: { kind: 'recommendation' } },
      { question: questionOf('Email the customer on cancel?'), reply: { kind: 'dismissed' } }
    ])
    const lines = skeletonOf([{ kind: 'user', text: batch.text }])
    expect(lines.map((line) => line.kind)).toEqual(['user'])
    expect(renderSkeleton(lines)).toBe(
      '1. [user] Answered: (1) Which counter do you want: A, B or C? → “B looks better, but should ' +
        'days be its own column?” (2) Freeze the counter when a job closes? → took the ' +
        'recommendation (3) Email the customer on cancel? → dismissed'
    )
  })

  // A handle is the one thing here with a ceiling: it has to be one line of a
  // list, and its first line is what identifies it.
  it('keeps a call’s handle to one line', () => {
    const [line] = skeletonOf([
      { kind: 'bashRun', command: `git log\n${'x'.repeat(2_000)}`, output: '', exitCode: 0 }
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

describe('the skeleton’s budget', () => {
  const calls: readonly SkeletonLine[] = Array.from({ length: 200 }, (_unused, at) => ({
    kind: 'call' as const,
    name: 'read',
    handle: `src/file-${at}.ts`,
    ok: true,
    tokens: 900
  }))

  it('drops the oldest lines that are not the person’s words until it fits', () => {
    const trimmed = trimSkeleton(calls, 300)
    expect(skeletonTokens(trimmed)).toBeLessThanOrEqual(300)
    // The newest survive: age is the judge among tool calls.
    expect(trimmed.at(-1)).toEqual(calls.at(-1))
  })

  it('trims Crucible’s notices and the agent’s replies like any other line', () => {
    const chatter: readonly SkeletonLine[] = Array.from({ length: 100 }, (_unused, at) =>
      at % 2 === 0
        ? { kind: 'notice' as const, text: `⚑ Crucible run ${at} (build) is checking in:`, tokens: 900 }
        : { kind: 'assistant' as const, text: `Approved checkpoint ${at}; nothing needed from you.`, more: 400 }
    )
    const trimmed = trimSkeleton([{ kind: 'user', text: 'the brief' }, ...chatter], 200)
    expect(skeletonTokens(trimmed)).toBeLessThanOrEqual(200)
    expect(trimmed[0]).toEqual({ kind: 'user', text: 'the brief' })
  })

  // Only the model, naming one, may drop a user message. A skeleton that
  // cannot fit without doing so stays over budget instead.
  it('never drops a user message to make room', () => {
    const said: readonly SkeletonLine[] = Array.from({ length: 50 }, (_unused, at) => ({
      kind: 'user' as const,
      text: `Something the person asked for, number ${at}.`
    }))
    expect(trimSkeleton(said, 10)).toEqual(said)
  })

  it('keeps every user message while trimming the calls around them', () => {
    const mixed: readonly SkeletonLine[] = [
      { kind: 'user', text: 'first ask' },
      ...calls,
      { kind: 'user', text: 'second ask' }
    ]
    const trimmed = trimSkeleton(mixed, 200)
    expect(trimmed.filter((line) => line.kind === 'user')).toHaveLength(2)
    expect(trimmed.length).toBeLessThan(mixed.length)
  })
})
