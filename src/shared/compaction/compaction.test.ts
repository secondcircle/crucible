import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '../agent/port'
import { ANSWER_BATCH_PREFIX } from '../questions/wording'
import { RUN_MESSAGE_PREFIX } from '../workflows/run'
import { planCompaction, settleCompaction, type CompactionState } from './compaction'
import { skeletonTokens } from './skeleton'

const AGED: readonly TranscriptItem[] = [
  { kind: 'user', text: 'Rewrite the retry policy.' },
  { kind: 'thinking', text: 'private' },
  {
    kind: 'tool',
    name: 'read',
    summary: 'src/retry.ts',
    ok: true,
    output: 'z'.repeat(8_000)
  }
]

const CARRIED: CompactionState = {
  skeleton: [{ kind: 'user', text: 'An older ask, from before the last compaction.' }]
}

const reply = (trajectory: string, strike = ''): string =>
  `<trajectory>${trajectory}</trajectory><strike>${strike}</strike>`

describe('planning a compaction', () => {
  it('asks about the newly aged span and carries the earlier skeleton whole', () => {
    const plan = planCompaction(CARRIED, AGED)
    expect(plan.lines).toHaveLength(3)
    expect(plan.lines[0]).toEqual(CARRIED.skeleton[0])
    // Numbered where the window left off, so one strike list covers both.
    expect(plan.instruction).toContain('2. [user] Rewrite the retry policy.')
    expect(plan.instruction).not.toContain('An older ask')
  })

  // Carried as this build reads it, not as the build that stored it did: a
  // line's kind decides how the model is told to treat it.
  it('re-reads the carried skeleton with this build’s kinds', () => {
    const stale: CompactionState = {
      skeleton: [
        {
          kind: 'user',
          text: `${RUN_MESSAGE_PREFIX} 09fb (build) completed · branch x\n\n${'x'.repeat(4_000)}`
        },
        { kind: 'user', text: 'proceed' }
      ]
    }
    const plan = planCompaction(stale, AGED)
    expect(plan.lines.slice(0, 2).map((line) => line.kind)).toEqual(['notice', 'user'])
  })
})

// A day of orchestration as one session actually recorded it: runs checking
// in, raising blockers and reporting completion, each message a few thousand
// characters and every one in the user's role, around a person typing a word
// or two at a time. Twelve such runs were 124k characters of skeleton.
function orchestrationSpan(runs: number): readonly TranscriptItem[] {
  const items: TranscriptItem[] = [{ kind: 'user', text: 'Launch the fix intents, one at a time.' }]
  for (let at = 0; at < runs; at += 1) {
    const id = `r${at.toString().padStart(3, '0')}`
    items.push(
      {
        kind: 'user',
        text: `${RUN_MESSAGE_PREFIX} ${id} (build) is checking in:\n\n# Checkpoint: the requirements and design are ready\n\n${'Requirement text. '.repeat(110)}`
      },
      {
        kind: 'assistant',
        markdown: `Checkpoint for ${id} reviewed; one decision is in your dock.\n\n${'Detail of the review. '.repeat(60)}`
      },
      {
        kind: 'user',
        text: `${ANSWER_BATCH_PREFIX}. Every question you had open, answered or dismissed.\n\n1. Build it?\n   Answer: yes\n\n${'More answer text. '.repeat(90)}`
      },
      {
        kind: 'tool',
        name: 'crucible_answer',
        summary: `${id}: build`,
        ok: true,
        output: 'ok'
      },
      {
        kind: 'user',
        text: `${RUN_MESSAGE_PREFIX} ${id} (build) raised a blocker at node "builder":\n\n${'The design is ambiguous about a thing. '.repeat(45)}`
      },
      { kind: 'assistant', markdown: `Answered the blocker on ${id}.` },
      { kind: 'user', text: 'proceed' },
      {
        kind: 'tool',
        name: 'Bash',
        summary: `git -C /repo log --oneline -5`,
        ok: true,
        output: 'y'.repeat(600)
      },
      {
        kind: 'user',
        text: `${RUN_MESSAGE_PREFIX} ${id} (build) completed · branch crucible/run-${id} · worktree /repo/.crucible/worktrees/${id}\n\n${'Report paragraph. '.repeat(330)}`
      },
      {
        kind: 'assistant',
        markdown: `Run ${id} is merged.\n\n${'What it changed. '.repeat(80)}`
      }
    )
  }
  return items
}

describe('a compaction of a session shaped like a real one', () => {
  const span = orchestrationSpan(12)
  const settled = settleCompaction(planCompaction(undefined, span), reply('Standing here.'))
  if (settled === undefined) throw new Error('the compaction should have settled')

  // Twelve runs' worth of reports, check-ins, blockers and answers is 124k
  // characters as the person's words and one line each as Crucible's.
  it('is a fraction of the span even though the model struck nothing', () => {
    const spanTokens = span.reduce((sum, item) => sum + JSON.stringify(item).length / 4, 0)
    expect(skeletonTokens(settled.state.skeleton)).toBeLessThan(spanTokens / 5)
  })

  // Twelve "proceed"s and twelve answer batches: the batch is Crucible's
  // envelope, but what is inside it is the person's ruling, kept as theirs.
  it('keeps every word the person typed', () => {
    const said = settled.state.skeleton.filter((line) => line.kind === 'user')
    expect(said).toHaveLength(1 + 12 + 12)
    expect(said[1]?.text).toMatch(/^Answered: \(1\) Build it\? → “yes/)
    expect(said[0]).toEqual({
      kind: 'user',
      text: 'Launch the fix intents, one at a time.'
    })
  })

  it('never presents a run’s message as something the person said', () => {
    expect(settled.text).not.toMatch(/\[user\] [⚑❓]/)
    expect(settled.text).toContain('[crucible] ⚑ Crucible run r011 (build) completed')
  })

  // The point of the skeleton: what the agent did survives beside what the
  // person said. A skeleton that is nothing but user lines has lost the story.
  it('still carries the agent’s replies and calls, not only the person’s words', () => {
    const kinds = new Set(settled.state.skeleton.map((line) => line.kind))
    expect(kinds).toContain('assistant')
    expect(kinds).toContain('call')
    expect(kinds).toContain('notice')
  })
})

describe('settling one', () => {
  it('composes the window from the account and what survived pruning', () => {
    const plan = planCompaction(CARRIED, AGED)
    const settled = settleCompaction(plan, reply('Where the work stands.', '1'))
    if (settled === undefined) throw new Error('the compaction should have settled')

    expect(settled.text).toContain('## Where we are')
    expect(settled.text).toContain('Where the work stands.')
    expect(settled.text).toContain('## What happened before this point')
    // Struck by the model, so it is not in the window and not carried on.
    expect(settled.text).not.toContain('An older ask')
    expect(settled.state.skeleton).toHaveLength(2)
    expect(settled.text).toContain('[read] src/retry.ts → ok · 2,000 tok dropped')
  })

  // A window of handles with no account is an agent that knows what it touched
  // and not what it was doing, which is the one outcome worth refusing.
  it('refuses a reply that wrote no account', () => {
    expect(settleCompaction(planCompaction(undefined, AGED), 'no tags here')).toBeUndefined()
  })

  // Refused rather than settled, so the compaction cancels and the account
  // already in the window stands. Four idle compactions in one session each
  // replaced a whole account with a fragment before this refused them.
  it('refuses an account the provider cut before its end', () => {
    expect(
      settleCompaction(
        planCompaction(undefined, AGED),
        '<trajectory>\nWHERE WE ARE\n\nRepo `x`. Standing rules from the cost (~$2,080; rec'
      )
    ).toBeUndefined()
  })

  // The model's strike list is the whole of the pruning. No rule of size
  // second-guesses what it left: a build before this one trimmed to a budget
  // and dropped every reply and call from a skeleton whose protected lines
  // alone were over it.
  it('keeps every line the model did not strike, however many aged out', () => {
    const many: readonly TranscriptItem[] = Array.from({ length: 4_000 }, (_unused, at) => ({
      kind: 'tool' as const,
      name: 'read',
      summary: `src/deep/nested/path/to/file-${at}.ts`,
      ok: true,
      output: 'x'.repeat(2_000)
    }))
    const settled = settleCompaction(
      planCompaction(undefined, many),
      reply('Standing here.', '1-2000')
    )
    if (settled === undefined) throw new Error('the compaction should have settled')
    expect(settled.state.skeleton).toHaveLength(2_000)
    expect(settled.state.skeleton[0]).toMatchObject({
      handle: 'src/deep/nested/path/to/file-2000.ts'
    })
  })

  // The end of an account is where what comes next lives. A model that ran
  // past the length it was asked for wrote a long account, not a bad one, and
  // nothing it wrote is cut.
  it('keeps an account whole however far past the asked-for length it ran', () => {
    const account = `${'word '.repeat(40_000)}THE LAST THING IT SAID`
    const settled = settleCompaction(planCompaction(undefined, AGED), reply(account))
    if (settled === undefined) throw new Error('the compaction should have settled')
    expect(settled.text).toContain('THE LAST THING IT SAID')
    expect(settled.text).not.toContain('…')
  })

  it('leaves out the skeleton heading when the model struck everything', () => {
    const plan = planCompaction(undefined, [{ kind: 'user', text: 'one thing' }])
    const settled = settleCompaction(plan, reply('Standing here.', '1'))
    expect(settled?.text).not.toContain('## What happened before this point')
  })
})
