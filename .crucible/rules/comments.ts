import { choice, defineRule } from 'crucible:rule'
import { addedComments } from 'crucible:rule/extract'

// Enforces the comment doctrine the build workflow ships (COMMENT_DOCTRINE in
// resources/agent-docs/examples/build.ts): a comment only explains a decision a
// reader would find strange, in a line or two, referencing nothing outside the code.
//
// Calibrated 2026-09-23 against 3,435 comments the comment-police node ruled on
// (21 commits). A single choice over what the comment is doing separated removed
// from kept better than three separate yes/no questions (AUC 0.68 vs 0.59 on
// 1-2 line comments); length is counted in code because it is the strongest
// signal of all and Jev cannot count.

const purposes = {
  narrates:
    'Restates or summarizes what the adjacent code does, or names what a value is, which the code already shows.',
  why: 'Explains the reason for a non-obvious choice: a constraint, a failure the obvious approach would hit, or an intent the code cannot show.',
  contract: 'States a guarantee or rule that callers rely on and the signature does not show.',
  pointer:
    'Points to something outside the code: a document, an ADR, an issue or question id, a design mock, or how the code came to be.',
  label: 'Names a section or a group of lines.',
} as const

export default defineRule({
  source: 'resources/agent-docs/examples/build.ts#COMMENT_DOCTRINE',
  summary: 'A comment explains why something non-obvious was done, and nothing else',
  on: 'edit',
  scope: {
    include: ['src/**/*.{ts,tsx}', 'scripts/**/*.{ts,mjs,js}', 'resources/workflow-lib/**/*.ts'],
    exclude: ['**/*.d.ts'],
  },
  mode: 'shadow',

  extract: (edit) => addedComments(edit, { following: 12, preceding: 4 }),

  judge: {
    model: 'jev-1.13.0',
    questions: {
      purpose: choice('What is the comment in `comment` mainly doing?', purposes),
    },
  },

  decide(item, a) {
    if (Number(item.meta?.lines ?? 1) > 2) return 'note'
    const { choice: what, confidence } = a.purpose
    if (what === 'why' || what === 'contract') return 'pass'
    // A pointer often also names the topic of a reason, which splits the vote; any lead is enough.
    if (what === 'pointer' && confidence >= 0.5) return 'note'
    if (confidence >= 0.7) return 'note'
    return 'escalate'
  },

  feedback(item, a) {
    const at = `${item.path}:${item.line}`
    const lines = Number(item.meta?.lines ?? 1)
    if (lines > 2) return `${at} runs ${lines} lines. Keep the why to a line or two; a longer trade-off belongs in an ADR.`
    switch (a.purpose?.choice) {
      case 'pointer':
        return `${at} points outside the code. Say the reason in the comment itself, or delete it if the reason lives elsewhere.`
      case 'label':
        return `${at} labels a section. The code's own names should carry that; delete it.`
      default:
        return `${at} describes what the code does. Delete it, or say why the code does something a reader would find strange.`
    }
  },
})
