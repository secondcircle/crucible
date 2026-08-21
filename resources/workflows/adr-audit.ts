import { spawnSync } from 'node:child_process'
import { workflow, type OutputSpec, type PlannedNode } from 'crucible:workflow'

const DOCUMENT_MODEL = 'anthropic/claude-fable-5:high'

/**
 * Shipped inside the workflow rather than read from beside it: a workspace
 * that disagrees with the doctrine shadows this file, and one act has to
 * replace both the rule and its enforcement.
 */
export const ADR_DOCTRINE = `\
# ADR doctrine

\`docs/adr/\` holds what is currently decided and nothing else. Agents are
pointed at that folder, so the whole of it is context on every turn: a file
that no longer describes a live decision is a tax paid on every turn for
nothing. An ADR that another one silently amends is worse than dead, because
an agent that reads only the first comes away with a rule that stopped being
true.

Git is the archive. A decision that was deleted is recovered by running
\`git log --follow\` on the file, which an agent will actually do where a
human would not. Superseded markers, tombstones and superseded-by chains are
the convention this doctrine rejects, and rejects knowingly. Nearly every
agent was trained on that convention, so the urge to "repair" the folder by
putting them back is the one failure this doctrine exists to prevent.

## The three-part test

An ADR earns its place only when all three are true of the decision it
records:

1. **Hard to reverse.** The cost of changing your mind later is real.
2. **Surprising without context.** A future reader will wonder why it was
   done this way.
3. **The result of a real trade-off.** There were genuine alternatives, and
   one was picked for specific reasons.

An ADR that fails any leg no longer describes a decision worth a file.

## The deletion precondition

An ADR may be deleted only once everything load-bearing in it survives in a
remaining ADR, where a reader will land. That means above all a shape that was
tried or proposed and abandoned, together with the reason it failed, which
belongs in the surviving ADR's Considered Options. The reason a path was rejected is
what stops the path being proposed again. Where that is not yet true, make it
true first by editing the survivor, and only then delete. Deleting first and
hoping the reasoning turns up somewhere is the one irreversible mistake
available here.

## Numbers and filenames

Numbers are never reused and never renumbered. Gaps are just gaps: a reused
number makes later archaeology resolve to the wrong decision. Filenames keep
the numbers they have, and no ADR file is renamed.

## Maintenance only, never authoring

Folding, editing and deleting existing ADRs is maintenance. Writing a new ADR
is authoring a decision nobody made, and so is splitting one into two. Both
are forbidden, whatever the folder looks like.

## No invented rationale

An argument may be strengthened only with evidence that can be found and
cited in the repository: a real count, a commit that shows the failure, an
issue number. Never a plausible-sounding reason. An invented reason is
indistinguishable from a recorded one to every agent that comes after, and
there is nobody left who remembers which it was. Where no evidence is
findable, the ADR is flagged in the report and left unedited.

## The citation rule

Outside \`docs/adr/\`, no prompt, no comment and no lint message names a
specific ADR. A number is an unstable identifier that means nothing at the
point of use, and citing one couples every deletion in the folder to a sweep
of the whole codebase. A prompt may say "look for relevant ADRs"; it never
names one. Generic pointers at the folder stay, since a pointer is what sends
an agent to look. Cross-references between documents survive, ADR to ADR
included: those are read by someone who can see both files, and they carry
the replaced-shape reasoning that makes deletion safe.

## Historical records

\`.crucible/align/\` and \`.crucible/runs/\` record what was true when they
were written. Nothing edits them: not this work, not anything else.`

/** The audit's four dispositions partition the folder as it stood at kickoff. */
const AUDIT_VERDICT = {
  type: 'object',
  required: ['kept', 'edited', 'flagged', 'deleted'],
  properties: {
    kept: { type: 'number' },
    edited: { type: 'number' },
    flagged: { type: 'number' },
    deleted: { type: 'number' }
  }
}

const SWEEP_VERDICT = {
  type: 'object',
  required: ['removed'],
  properties: { removed: { type: 'number' } }
}

const AUDIT_FINDINGS: OutputSpec = {
  file: 'audit-findings.md',
  desc: 'every ADR in the folder, its disposition and the reasoning behind it'
}

const SWEEP_FINDINGS: OutputSpec = {
  file: 'sweep-findings.md',
  desc: 'every citation site the sweep edited, and what stands there now'
}

const REPORT: OutputSpec = {
  file: 'report.html',
  desc: 'the run judged in one document, for the human who reads the branch'
}

function git(args: string[], cwd: string): { ok: boolean; out: string } {
  const ran = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000 })
  return { ok: ran.status === 0, out: `${ran.stdout ?? ''}${ran.stderr ?? ''}`.trim() }
}

/**
 * An untouched worktree is a legitimate no-op, but a refused commit fails the
 * run: work that never reached the branch must not be reported as done.
 */
function commit(cwd: string, message: string): void {
  const staged = git(['add', '-A'], cwd)
  if (!staged.ok) throw new Error(`adr-audit: git add failed: ${staged.out}`)
  if (git(['diff', '--cached', '--quiet'], cwd).ok) return
  const done = git(['commit', '-m', message], cwd)
  if (!done.ok) throw new Error(`adr-audit: git commit failed: ${done.out}`)
}

export const auditPrompt = (): string => `\
# Audit the decision record

**Goal**: make \`docs/adr/\` in this worktree record what is currently decided
and nothing else. Judge every ADR in the folder, each one alone and all of
them against each other, act on your judgment by deleting, folding,
strengthening or flagging, and write the findings file that lets the user
check every call you made.

**Why it matters**: ADRs accumulate and nobody prunes them, which is what this
run is for. The folder is context on every node of every run, so a dead
decision in it is a standing tax, and one ADR quietly amending another's
central sentence teaches every agent that reads only the first a rule that is
no longer true. What you leave is a branch the user reads and either merges or
throws away.

**The doctrine you enforce, and obey**:

${ADR_DOCTRINE}

**What to read**: every file in the worktree's \`docs/adr/\`, in full. Judge
each against the three-part test, then judge them against one another: which
amends which, which two decide overlapping questions, where a rule is split
across files that have to be read together. Those relational findings are the
whole reason the audit works on the folder entire and never on a subset.

**The four operations available to you, and no others**:

- **Delete** an ADR that no longer describes a live decision, and only under
  the deletion precondition. Where the surviving ADR does not yet carry the
  doomed one's load-bearing content, edit the survivor's Considered Options
  first so that it does, then delete.
- **Fold** overlapping or mutually amending ADRs into one that reads alone:
  edit the survivor so it carries the absorbed ADR's decision weight and its
  rejected shapes with the reasons they were rejected, then delete the
  absorbed file. The survivor keeps its own number and its own filename.
- **Strengthen** a warranted ADR that argues badly, using only evidence you
  found in the repository and cite in the edit: a count, a commit, an issue
  number. No findable evidence means no edit. Flag it instead.
- **Flag** an ADR whose decision may never have been real, or whose argument
  you cannot repair with evidence: record it in the findings with the question
  the user has to answer, and edit nothing about it.

**Forbidden**: authoring a new ADR, splitting one into two, renumbering,
reusing a number, renaming a file, inventing a rationale, editing anything
outside \`docs/adr/\`, and touching \`.crucible/align/\` or
\`.crucible/runs/\`.

**Your findings file**: one entry per ADR file that was present when you
started, giving its disposition and your reasoning, plus the relational
findings you drew on. Write it for the user and for the agent that turns it
into a report. The bar: a change the user cannot evaluate from this record
alone is a defect, because a kept ADR leaves no diff at all and your reasoning
exists nowhere else.

**Your verdict** counts the four dispositions. They partition the files that
were in the folder when you started, so every file has exactly one and the
four numbers sum to the folder's starting size.

**An absent or empty \`docs/adr/\`** is a legitimate outcome, not an error:
every count is zero and the findings say so plainly.

**Context**: you are in a worktree of this repository, on the branch this run
leaves behind. The repository's glossary is \`CONTEXT.md\` at the root; use
its terms exactly.`

export const sweepPrompt = (): string => `\
# Strip the citations

**Goal**: remove every reference to one specific ADR from everywhere in this
worktree outside \`docs/adr/\` itself, and write the findings file that lists
each site you touched.

**Why it matters**: a number means nothing at the point of use, and citing one
couples every deletion in the folder to a sweep of the whole codebase. The
citations that survive a sweep are the ones that go stale silently, and a
comment pointing at an ADR that no longer exists misleads every reader who
trusts it.

**The doctrine you enforce, and obey**:

${ADR_DOCTRINE}

**What to search for**: any reference that names one ADR in particular, in
whatever form it takes. The word ADR followed by its number. A bare number in
a sentence that is about ADRs. A path or a filename under the ADR folder that
carries a number in it.

**In scope**: code comments in any language, TypeScript, CSS and config files
included; prompt text, and the code that builds prompt text; and user-facing
message strings, lint messages among them. Where the repository's own lint
configuration carries such a message, it is in scope like anything else.

**Left untouched**:

- generic pointers at \`docs/adr/\` ("its decisions live in \`docs/adr/\`",
  "look for relevant ADRs"), which are what sends an agent to look;
- cross-references between documents, ADR to ADR included: those are read by
  someone who can see both files, and they carry the replaced-shape reasoning
  that makes deletion safe;
- two files excluded by name, because what they hold looks like a citation and
  is not: \`src/shared/workspace/fake-service.ts\`, where an ADR filename is
  fake search-result data that a test asserts on, and
  \`docs/design/mock-h-queue-and-chains.html\`, where an ADR path sits in fake
  terminal output inside a mock. In a repository that has neither file, the
  exclusion costs nothing;
- \`.crucible/align/\` and \`.crucible/runs/\`, which are historical records
  and are never edited at all.

**How removal works**: a citation is deleted, never rewritten to point
somewhere else. Drop it and leave the sentence's explanation standing on its
own; where a pointer is genuinely needed, point at the folder generically. A
sentence that is nothing but the citation goes entirely. Your edits touch
comments and human-readable prompt or message text only: logic, identifiers
and structure stay exactly as they are, so rewording the string a lint message
prints is yours to do and changing what the rule matches is not.

**Judgment calls** at the boundary are yours to make under the doctrine, and
they go in the findings either way, so the user can see the call and disagree
with it.

**Your findings file**: one entry per site you edited, naming the file, the
reference you removed or reworded, and what the text says now. The report is
built from it and the user has to be able to evaluate every removal without
opening the file it came from. Finding nothing is a legitimate outcome. Say so
plainly.

**Your verdict** is \`removed\`: how many citation sites you removed or
reworded.

**Context**: you are in a worktree of this repository, on the branch this run
leaves behind. The repository's glossary is \`CONTEXT.md\` at the root; use
its terms exactly.`

export const reportPrompt = (auditFindings: string, sweepFindings: string): string => `\
# Report on the audit

**Goal**: write the one document the user reads to judge this run: what was
deleted, folded, strengthened, flagged and left alone in \`docs/adr/\`, and
every citation the sweep stripped from the rest of the worktree. Your inputs
are the audit's findings at \`${auditFindings}\` and the sweep's findings at
\`${sweepFindings}\`.

**Why it matters**: the report is the point as much as the diff. The user has
to be able to judge whether this run's opinions were any good without
rereading the folder it just rewrote, and a kept ADR leaves no diff to read at
all. A change the user cannot evaluate from the report alone is a defect.

**Required content.** Every section is present even when it is empty, because
an empty walk is a result and a missing section reads as a silent omission:

- **The verdict at a glance**: the four disposition counts, and how many
  citation sites the sweep edited.
- **Every deletion**: which ADR went, why it no longer earns its place under
  the three-part test, and where its load-bearing content survives now.
- **Every fold**: the survivor, the file it absorbed, and what moved into the
  survivor's Considered Options.
- **Every strengthening**: what the argument was missing, and the evidence
  from this repository that is now cited in it.
- **Every flag**: what is suspect about it, the plain statement that nothing
  was edited, and the question the user has to answer.
- **Every ADR left alone**, each with a one-line why.
- **The citation sweep**: every site that was edited, what was removed, what
  stands there now, and which exclusions applied.

**Constraints on you**:

- The branch is in your working directory. Where verifying a findings claim
  against the diff is cheap, verify it.
- You change nothing in the worktree. Your product is the report.
- Write it for a human reader: a dark-mode HTML document, using what HTML
  offers over markdown to carry a set of verdicts at a glance.

**Context**: you are in a worktree of this repository, on the branch this run
leaves behind. The repository's glossary is \`CONTEXT.md\` at the root; use
its terms exactly.`

export default workflow({
  description:
    'audit `docs/adr/` so it records only what is currently decided: delete dead ADRs, fold ' +
    'overlapping ones, strip numbered ADR citations from everything outside the folder, and ' +
    'leave a branch and a report',
  inputs: {},
  // Three nodes, all certain to run, so the artifact rail shows what is coming
  // from the moment of kickoff.
  plan: (): PlannedNode[] => [
    { id: 'audit', model: DOCUMENT_MODEL, outputs: { findings: AUDIT_FINDINGS } },
    {
      id: 'sweep',
      model: DOCUMENT_MODEL,
      parents: ['audit'],
      outputs: { findings: SWEEP_FINDINGS }
    },
    {
      id: 'report',
      model: DOCUMENT_MODEL,
      parents: ['audit', 'sweep'],
      outputs: { report: REPORT }
    }
  ],
  run: async (ctx) => {
    // The audit takes no inputs and follows nothing, so declaring either would
    // be an invented edge.
    const audit = await ctx.node('audit', {
      prompt: auditPrompt(),
      outputs: { findings: AUDIT_FINDINGS },
      verdict: AUDIT_VERDICT,
      model: DOCUMENT_MODEL
    })
    commit(ctx.cwd, 'adr-audit: audit')

    // The citation ban holds whatever the audit decided, so this edge is
    // ordering alone: one worktree, and commits that tell the run in order.
    const sweep = await ctx.node('sweep', {
      prompt: sweepPrompt(),
      from: ['audit'],
      outputs: { findings: SWEEP_FINDINGS },
      verdict: SWEEP_VERDICT,
      model: DOCUMENT_MODEL
    })
    commit(ctx.cwd, 'adr-audit: sweep')

    const report = await ctx.node('report', {
      prompt: reportPrompt(audit.outputs.findings, sweep.outputs.findings),
      from: ['audit', 'sweep'],
      reads: [audit.outputs.findings, sweep.outputs.findings],
      outputs: { report: REPORT },
      model: DOCUMENT_MODEL
    })

    const counts = audit.verdict as {
      kept: number
      edited: number
      flagged: number
      deleted: number
    }
    const { removed } = sweep.verdict as { removed: number }
    return {
      report: report.outputs.report,
      kept: counts.kept,
      edited: counts.edited,
      flagged: counts.flagged,
      deleted: counts.deleted,
      citationsRemoved: removed
    }
  }
})
