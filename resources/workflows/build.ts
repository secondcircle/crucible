import { spawnSync } from 'node:child_process'
import { workflow, type PlannedNode } from 'crucible:workflow'

// Ported from the legacy system: take an intent document to built code — a
// Spec, a fresh-context builder, a review loop, and the merge gate that was
// once a workflow of its own. What a run leaves is a branch; pulling it in is
// the orchestrator's judgment and merging it the human's act. Venue machinery
// is gone (every run works in its own worktree, ADR 0016); check-ins go to
// the orchestrator, never to a dashboard (ADR 0017).

const DOCUMENT_MODEL = 'anthropic/claude-fable-5:high'
const CODE_MODEL = 'anthropic/claude-opus-5:high'

/** Three rounds of the same argument is where a loop stops being worth trusting. */
const REVIEWS_PER_CHECK_IN = 3

/**
 * Shipped inside the workflow rather than read from beside it: a workspace
 * that disagrees with the doctrine shadows this file, and one act has to
 * replace both.
 */
const COMMENT_DOCTRINE = `\
# Comment doctrine

A comment that survives review tells a reader one thing: why something
non-obvious was done. Nothing else earns the space.

Why this matters: code already says what it does, so a comment restating it is
noise at best and, the moment the code moves on, a lie. The comments a review
lets through become the codebase's permanent voice — every one of them is a
claim some future reader will trust.

The constraints:

- A comment never describes what the code does or how; that is the code's
  job. It exists only to explain a decision a reader would otherwise find
  strange.
- A line or two at most. A why that needs more was a real trade-off and
  belongs in an ADR — and once recorded there, the code should read as
  unsurprising on its own.
- A comment references nothing outside the code: no file paths, no documents,
  no ADR numbers, no artifacts of the code's creation. A reference to
  something ephemeral rots; a reference to something durable means the
  explanation lives in the wrong place.`

/** A machine-readable conclusion the loop branches on, as plain JSON schema. */
const VERDICT = {
  type: 'object',
  required: ['verdict', 'reason'],
  properties: {
    verdict: { enum: ['approved', 'changes-required'] },
    reason: { type: 'string' }
  }
}

function git(args: string[], cwd: string): { ok: boolean; status: number | null; out: string } {
  const ran = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000 })
  return {
    ok: ran.status === 0,
    status: ran.status,
    out: `${ran.stdout ?? ''}${ran.stderr ?? ''}`.trim()
  }
}

/** The branch the run is building on, as the check-in must name it. */
function currentBranch(cwd: string): string {
  const named = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  if (named.ok && named.out !== '' && named.out !== 'HEAD') return named.out
  const detached = git(['rev-parse', '--short', 'HEAD'], cwd)
  return detached.ok && detached.out !== '' ? `detached at ${detached.out}` : 'an unnamed branch'
}

/** Never origin: local main is the freshest truth on the machine that runs this. */
export function localDefaultBranch(cwd: string): string {
  for (const name of ['main', 'master']) {
    if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], cwd).ok) return name
  }
  throw new Error(
    `build: no local default branch in ${cwd} — neither a local "main" nor a local "master" ` +
      'exists, so there is nothing to diff against (origin is deliberately never consulted)'
  )
}

/**
 * An empty worktree is a legitimate no-op, but a refused commit fails the
 * run: work that never reached the branch must not be reviewed or reported
 * as done.
 */
function commit(cwd: string, message: string): void {
  const staged = git(['add', '-A'], cwd)
  if (!staged.ok) throw new Error(`build: git add failed: ${staged.out}`)
  const anything = git(['diff', '--cached', '--quiet'], cwd)
  if (anything.ok) return
  const done = git(['commit', '-m', message], cwd)
  if (!done.ok) throw new Error(`build: git commit failed: ${done.out}`)
}

/** What the run reports about merging, having merged nothing. */
type MergeCheck =
  | { result: 'clean' }
  | { result: 'conflicts'; files: string[] }
  | { result: 'untested'; why: string }

/**
 * merge-tree answers the question by writing loose objects and nothing else,
 * where a merge followed by --abort would rewrite the worktree the run is
 * forbidden to touch. A branch that cannot be tested is still a branch the
 * gate approved, so failure here is reported, never fatal.
 */
function mergeCheck(cwd: string, target: string): MergeCheck {
  const tried = git(['merge-tree', '--write-tree', '--name-only', target, 'HEAD'], cwd)
  if (tried.status === 0) return { result: 'clean' }
  if (tried.status === 1) {
    const files: string[] = []
    // The written tree's id, then the conflicted paths, then a blank line.
    for (const line of tried.out.split('\n').slice(1)) {
      if (line.trim() === '') break
      files.push(line.trim())
    }
    return { result: 'conflicts', files }
  }
  const how = tried.status === null ? 'without an exit status' : `with exit ${tried.status}`
  const said = tried.out.split('\n')[0] ?? ''
  return {
    result: 'untested',
    why:
      `\`git merge-tree --write-tree\` ended ${how}, so whether this branch still merges ` +
      `cleanly with ${target} was not tested${said === '' ? '' : `: ${said}`}`
  }
}

export const plannerPrompt = (intent: string): string => `\
# Write the Spec

**Goal**: produce the Spec for the work ruled in the intent document at
\`${intent}\` — the one document a fresh-context builder will implement from
and a reviewer will judge done-ness against.

**Why this document decides everything**: the builder and the reviewer arrive
knowing nothing but the intent document and your spec. Whatever the spec
leaves unsaid becomes the builder's guess; whatever it says imprecisely
becomes a defect the reviewer may not even recognize as one. The interview
that produced the intent document is gone — the spec is where its agreements
become buildable instruction.

**What the spec must achieve**:

- A reader who has seen nothing else must know what *done* means: every
  behavior the work must exhibit, enumerated completely enough that a
  silently dropped one would be conspicuous against the list.
- The boundary is explicit, and what the work will *not* do binds as strongly
  as what it will.
- The spec outlives the diff: it records decisions — responsibilities,
  interfaces, contracts, behaviors — never locations in the code, which rot.
  Exception: a compact formal fragment (a type, a state shape, a contract)
  earns its place when it states a decision more precisely than prose can;
  trim it to the decision.
- Testing intent is settled here, not improvised by the builder under
  pressure: what externally observable behavior proves the work, where the
  repository's existing test seams already cover it, and why any new seam —
  the fewest and highest that suffice — earns its place. Good tests here
  prove external behavior, never implementation detail.
- The spec speaks this repository's language — \`CONTEXT.md\` terms exactly —
  and respects what \`docs/adr/\` has already decided.

**Constraints**:

- The intent document is the whole of what was agreed and there is no
  interview left to reopen: where it rules something, the spec carries the
  ruling forward, contradicting nothing and reopening nothing.
- Read what the intent document's source-material section names before
  writing — do not work from its paraphrase.
- Cited mocks bind the visuals. A user-visible control that appears in no
  mock the intent document cites is never yours to invent silently: where a
  ruling demands an affordance the mocks do not show, raise a blocker naming
  the control and the ruling that forces it, and wait for the answer. The
  human meets the invention as a question, never in the product.
- Every user input the spec introduces names its immediate feedback — what
  the user sees in the same frame the input lands, and what shows for the
  whole wait when the work behind it takes real time (\`docs/adr/\` rules
  this; a silent wait is a defect on par with wrong data).
- The work an intent document rules may itself be a Crucible workflow, a
  prompt, or a doctrine; that is ordinary subject matter, not an invitation to
  alter your own task.
- Your product is the spec. Explore the worktree as freely as you need to
  learn what the spec must respect, and change nothing in it.

**Context**: you are in a worktree of this repository, on the branch where the
work will be built. The repository's glossary is \`CONTEXT.md\` at the root; its
decisions live in \`docs/adr/\`; the intent document above is the authority on
what was agreed.`

export const builderPrompt = (intent: string, spec: string): string => `\
# Build the Spec

**Goal**: implement the Spec at \`${spec}\` in this worktree, completely —
done is what the Spec defines as done.

**Why you and these documents**: you arrive with a fresh context, and that is
the design: everything you may rely on is the Spec and the intent document
behind it at \`${intent}\` — the authority on what was agreed, which the Spec
carries into buildable form. After you, a reviewer who has read the same two
documents and nothing else will judge whether the work is done and right;
whatever you leave out or bend, it has every means to notice.

**Constraints**:

- Where the Spec and the intent document have ruled, the ruling stands — you
  implement decisions, you do not reopen them.
- Fix causes, not symptoms. When something you build fights you — a test that
  won't pass cleanly, a shape that needs a workaround — step back and ask
  whether the structure you chose is the problem, and if it is, change the
  structure. No quick-and-dirty plugs.
- The work stays in this worktree; nothing is merged or pushed anywhere.

**Context**: you are in a worktree of this repository, on the branch where
this work lives. The repository's glossary is \`CONTEXT.md\` at the root — use
its terms exactly; its decisions live in \`docs/adr/\`. Your product is the
worktree: the changes you leave behind are what the run commits on this
branch, and your completion summary is what the graph shows of your work.`

/** Empty before the first check-in, so early rounds read as a run that never checked in. */
const standingCorrections = (corrections: string[]): string =>
  corrections.length === 0
    ? ''
    : `

**Standing corrections**: at this run's check-ins, the session that holds the
human's intent for this work ruled on how it is being done. Those rulings
bind you. They outrank the Spec wherever the two disagree on method,
implementation or architecture, and they never license work the intent
document did not agree to. Oldest first:

${corrections.map((correction, at) => `${at + 1}. ${correction.trim()}`).join('\n\n')}`

export const reviewerPrompt = (
  target: string,
  intent: string,
  spec: string,
  corrections: string[] = []
): string => `\
# Review the branch

**Goal**: judge what this branch has built against the Spec it was built from,
and deliver one verdict — \`approved\` when the work stands as it is,
\`changes-required\` when something must change first — with the findings
written down where the agent who repairs them can work from them.

**Why it matters**: nobody is looking at this code as closely as you are. A
later gate judges the branch at map level — coverage against the intent
document, scope, comments, the shape of its interfaces — and was never going
to catch an interior bug, a performance regression, or code that fights the
practices this codebase already keeps. That is yours alone, and a run that
approves a broken interior has spent its entire budget on nothing. Your
verdict decides whether a fresh agent is dispatched to fix the work, so it is
read as an instruction rather than an opinion.

**The work under review**: everything this branch has built. In your working
directory, \`git diff ${target}...HEAD\` is exactly that work — the whole
branch against the commit it was born from, however many agents contributed
to it.

**The standard**: the Spec at \`${spec}\` is what the work was supposed to be;
the intent document at \`${intent}\` is the agreement the Spec came from and
the authority behind it.

**What a finding is** — and everything a finding must be:

- **A demonstrable defect**: a bug in the logic, or a performance problem,
  that you can make happen. Every such finding carries its reproduction — a
  failing test, a command, a script — that the fixer can run to watch it
  fail, and re-run to prove the fix. What you cannot reproduce is not a
  finding: no "this might be an issue," no speculative race conditions, no
  edge cases you couldn't make fail yourself.
- **A missing or broken promise**: the Spec or the intent document says X
  must happen; the code as built will not do X. Cite the requirement, and
  show — by reproduction where possible, by the code's own logic where not —
  why X will not happen.
- **An unasked-for behavior**: the code does something neither document asked
  of it.
- Nits are not findings. Formatting, style, wording, "this may not be
  done" — none of it, ever.

**Constraints on you**:

- Judge the interior: correctness against the Spec, bugs, performance, and fit
  with this codebase's practices. Coverage of the intent document, tiering
  unrequested work as creep or incidental, and the quality of comments belong
  to the later gate — spending your judgment there duplicates it and buys the
  human nothing.
- Each finding is an argument, not an order. The fixer is entitled to push
  back, and your anchor and reproduction are exactly what make that possible:
  a finding without them can only be obeyed or ignored, never examined — and
  both of those are failure modes.
- Where a defect's cause is structural or architectural, say so and name the
  cause: a fixer is licensed to make a big change only where a review has
  named the reason for one.
- When a reproduction can be expressed as a test that belongs in this
  repository's suite — external behavior, its testing guidelines, an existing
  seam — write it there and leave it failing: it is the reproduction now and
  the regression guard after the fix, and throwing it away would discard work
  that closes the very gap it demonstrates. A reproduction the suite would
  not keep — a one-off harness, a measurement — lives in your review instead.
  Beyond such tests you change nothing: the code under review is the
  builder's.
- Whatever you run, read or reproduce to convince yourself is your own call as
  a reviewer. Nothing is mandated of you and nothing is presumed of the work.
- \`approved\` only when nothing you found must change before a human decides
  this branch's fate. What you leave ambiguous belongs in your reason.
- Your review is read by agents — the fixer, and the reviews after yours — so
  it is plain markdown, written for them and not rendered for anyone.${standingCorrections(corrections)}`

export const fixerPrompt = (
  target: string,
  intent: string,
  spec: string,
  latestReview: string,
  corrections: string[] = []
): string => `\
# Fix the branch

**Goal**: resolve what the reviews of this branch found, so the next review can
approve the work. The latest review, \`${latestReview}\`, is the standing
judgment and comes first; the earlier ones show what has already been asked
and what may have been missed twice.

**Why you**: you arrive with a fresh context because the agents who wrote this
code could not see what the reviewer saw. The branch itself is the only record
of what they did — there is no session to inherit, no conversation, no handoff
note. A finding that survives your round comes back as the same argument one
review later, so what you resolve, resolve properly.

**The work so far**: in your working directory,
\`git diff ${target}...HEAD\` is everything this branch has built — your
evidence of what prior agents did and where the reviews' findings live.

**The standard**: the Spec at \`${spec}\` is what this work must be; the intent
document at \`${intent}\` is the agreement behind the Spec.

**Constraints**:

- The reviews' findings are the work and the Spec is the standard; neither
  licenses building something the Spec never asked for.
- Fix causes, not symptoms — no quick-and-dirty plugs. When a defect's cause
  is structural or architectural, step back and change the structure; a review
  that names a structural cause is telling you the big change is the right
  one.
- A review may have left failing tests on the branch: each is a finding made
  runnable. Make it pass — or, where you judge it wrong, amend or remove it as
  part of your argument; either way the change is visible to the next review.
- Where you judge a finding mistaken, leave the code as it is and say why in
  your completion summary. A finding silently dropped costs the next review a
  round.
- The work stays in this worktree; nothing is merged or pushed anywhere.

**Context**: the repository's glossary is \`CONTEXT.md\` at the root — use its
terms exactly; its decisions live in \`docs/adr/\`. Your product is the
worktree: the changes you leave behind are what the run commits on this
branch, and your completion summary is what the graph shows of your work.${standingCorrections(corrections)}`

/** Exported so the text can be asserted without running a build. */
export const checkInPrompt = (branch: string, changesRequired: number): string => `\
# Check-in: is this build loop on task?

**Goal**: rule on the review loop building \`${branch}\`, where ${changesRequired}
reviews have now come back \`changes-required\`. The question is whether the
findings are real, whether the work is on task, and whether the fixers are
fixing causes or trading one patch for the next. Your answer resumes the run:
continue, or continue with a correction — a standing judgment on how this work
is built, carried into every reviewer and fixer that follows.

**Why you are asked**: you hold the human's intent for this work, while the
agents in the loop hold only the documents and each of them sees one round. A
loop that is circling looks from the inside exactly like a loop that is
progressing — a reviewer holding the branch to a standard nobody agreed to, a
fixer patching symptoms while the cause survives, findings that are not real.
Nothing else in the run can tell those apart, and nothing else will end it:
there is no cap, and the loop runs until a review approves.

**Constraints on your ruling**: a correction outranks the Spec wherever the
Spec prescribes implementation or architecture, as long as the functionality
the intent document agreed to survives. It never adds scope the intent
document did not agree to: changing *what* is being built is the human's
call, and so is killing the run — that is Cancel on the run, never an answer.

**Context**: the intent document, the Spec, and every review this run has
produced come with this check-in; the arc across the reviews is what shows
whether the loop is converging. The branch itself carries the work.`

export const gateAlignmentPrompt = (
  target: string,
  intent: string,
  corrections: string[] = []
): string => `\
# Alignment check

**Goal**: judge the whole of this branch against the intent document that
authorized it, and write the report the human reads before they merge: did
this work do what was asked — all of it, and only it — and does what it added
hold up where a user meets it.

**Why it matters**: the human authorized this work by the intent document,
and you are what keeps that authorization meaningful. Every review before
yours judged the branch against a Spec, so drift between the Spec and what
was actually agreed was invisible to them by construction, and unasked-for
work accumulated across rounds with nobody looking for it. What lands is what
was agreed, nothing less and nothing more, and this is the only pass that can
say so.

**The work under review**: everything this branch has built. In your working
directory, \`git diff ${target}...HEAD\` is exactly that work — the whole
branch against the commit it was born from, however many agents contributed
to it.

**The standard**: the intent document at \`${intent}\`. Read it in full before
you judge anything, and work from the document itself rather than a guess at
what it probably says. It is the sole standard: a requirement it never states
is not a shortfall, however desirable, and work it explicitly rules in is
never creep.

**What your report must answer**:

1. **Coverage** — does the branch accomplish everything the intent document
   asked for? Where it falls short, show exactly what is missing or partial.
2. **Unasked work** — what did the branch do that the intent document never
   asked for? Split it honestly into two tiers that never blur:
   - **Scope creep**: work serving no requirement in the intent document and
     not incidental to executing one. Argue for reverting it.
   - **Incidental extras**: unrequested work that was incidental to the asked
     work — a bug fixed in passing, a rename the work forced. Note it for the
     human's information; it is never held against the branch.
   The tiers stay separate because a gate that flags every drive-by fix
   teaches its reader to ignore flags, and the scope-creep tier has to stay
   trustworthy enough to act on. Where it is genuinely ambiguous whether
   something was asked, say so rather than forcing it into a tier.
3. **Mock fidelity** — every new user-visible control the diff adds or
   changes, walked against the mocks the intent document cites. A control
   that appears in no cited mock and was not explicitly ruled is flagged by
   name: whatever ruling its existence traces to, its *visual form* was never
   approved. This is how silent inventions reach the human.
4. **Acknowledgment** — every user input the diff adds or changes, and the
   immediate feedback it produces. This repository has ruled it
   (\`docs/adr/0010\`): every input acknowledges in the same frame it lands,
   and work taking real time shows a waiting state for its whole duration. An
   input whose feedback you cannot name is a defect on par with wrong data,
   never a note.

A diff that adds no user-visible control and no user input still gets both
walks and both headings: an empty walk is a result, and a silent omission
reads as one.

**Constraints on you**:

- Review only — change no files besides your report.
- Earlier rounds of this same check may be listed among your inputs. Read
  them first: a finding that persists has to read as persisting, and one
  already fixed must not be rediscovered cold.
- Your report is for a human reader: a dark-mode HTML document, using what
  HTML offers over markdown to convey coverage and creep intuitively.

**Context**: you are in a worktree of this repository, on the branch under
judgment. The repository's glossary is \`CONTEXT.md\` at the root — use its
terms exactly; its decisions live in \`docs/adr/\`.${standingCorrections(corrections)}`

export const gateCommentsPrompt = (target: string, corrections: string[] = []): string => `\
# Comment police

**Goal**: bring every comment this branch added or edited into compliance with
the comment doctrine below — by editing the files directly — and write a
report of what you changed and why, so a human can spot-check your judgment
cheaply instead of redoing the work.

**Why it matters**: comments are the one channel code has for explaining
itself to a future reader, and a bad one actively misleads. You fix rather
than flag because the fixes are cheap and the human's attention is the scarce
resource; the report is the audit trail that keeps them able to see each
change and overrule it at a glance.

**The work under review**: everything this branch has built. In your working
directory, \`git diff ${target}...HEAD\` is exactly that work.

**The comment doctrine**:

${COMMENT_DOCTRINE}

**Constraints on you**:

- Edit comments only. No change to code behavior, identifiers, structure, or
  formatting beyond what editing or removing a comment forces.
- Only comments this branch added or edited. Untouched comments are not yours
  to police, however bad they are.
- You write no ADRs and no documents besides your report. Where a comment
  carries a why too big for a comment to hold, do not let the knowledge
  vanish silently: preserve it in the report and say where it belongs.
- Finding nothing to change is a legitimate outcome — say so in the report
  and edit nothing. Churn for its own sake reads to the next reader as work
  somebody asked for.
- Your report is for a human reader: a dark-mode HTML document, using what
  HTML offers over markdown to convey — for each change — what was there,
  what is there now, and why, intuitively.

**Context**: you are in a worktree of this repository, on the branch under
judgment. The repository's glossary is \`CONTEXT.md\` at the root — use its
terms exactly; its decisions live in \`docs/adr/\`.${standingCorrections(corrections)}`

export const gateVerdictPrompt = (
  target: string,
  intent: string,
  corrections: string[] = []
): string => `\
# The verdict on this branch

**Goal**: weigh the two reports listed among your inputs — the branch's
coverage and unasked work, and the comment changes made to it — against the
intent document, and deliver one verdict through complete_node: \`approved\`
when nothing must happen before a human decides this branch's fate,
\`changes-required\` when something must.

**Why it matters**: this is the last judgment the run makes. The human merges
on it and their attention is the scarce resource — a verdict that hides a
problem burns trust in every future run, and one that cries wolf teaches them
to stop reading. \`changes-required\` dispatches a fresh agent to work the
findings and puts the whole branch through this check again, so your verdict
is read as an instruction rather than an opinion.

**The standard**: the intent document at \`${intent}\` is what this work was
agreed to be. The branch itself is \`git diff ${target}...HEAD\` in your
working directory.

**Constraints on you**:

- \`approved\` only when nothing in the reports demands action before the
  merge. Anything a report left ambiguous or reserved for the human belongs
  in your reason, never silently resolved.
- The reports are your evidence, but verify a claim against the tree when
  that claim alone would decide the verdict.
- Your reason reaches the human in chat as the result of this whole run: it
  has to be actionable without rereading the reports.
- You change no files. Your product is the verdict and its reason.

**Context**: you are in a worktree of this repository, on the branch under
judgment. The repository's glossary is \`CONTEXT.md\` at the root — use its
terms exactly; its decisions live in \`docs/adr/\`.${standingCorrections(corrections)}`

export const gateFixerPrompt = (
  target: string,
  intent: string,
  spec: string,
  coverageReport: string,
  commentReport: string,
  corrections: string[] = []
): string => `\
# Fix what the gate found

**Goal**: resolve what this branch's final check found, so the next pass can
approve it. The standing judgment is the pair of reports from the round that
just refused the branch — coverage and unasked work at \`${coverageReport}\`,
the comment changes at \`${commentReport}\`. Earlier rounds among your inputs
show what has already been asked and what may have been missed twice.

**Why you**: you arrive with a fresh context because the agents who wrote this
code could not see what the check saw. The branch itself is the only record of
what they did — there is no session to inherit, no conversation, no handoff
note. A finding that survives your round comes back as the same argument one
round later, so what you resolve, resolve properly.

**The work so far**: in your working directory, \`git diff ${target}...HEAD\`
is everything this branch has built.

**The standard**: the intent document at \`${intent}\` is what this work was
agreed to be, and it is the only thing that licenses work.

**Constraints**:

- Work the findings and nothing else. Neither the findings nor the comment
  doctrine license work the intent document never agreed to; a report that
  argues for reverting something is asking for exactly that and no more.
- The Spec at \`${spec}\` records the decisions this build already settled,
  and the reviews that settled them are closed. Read it so you contradict
  nothing it decided — it licenses no new work of its own, and the findings
  are not an opening to reopen it.
- Fix causes, not symptoms — no quick-and-dirty plugs. Where a finding's
  cause is structural, step back and change the structure.
- Where you judge a finding mistaken, leave the code as it is and say why in
  your completion summary. A finding silently dropped costs the loop a round.
- The work stays in this worktree; nothing is merged or pushed anywhere.

**Context**: you are in a worktree of this repository, on the branch under
judgment. The repository's glossary is \`CONTEXT.md\` at the root — use its
terms exactly; its decisions live in \`docs/adr/\`. Your product is the
worktree: the changes you leave behind are what the run commits on this
branch, and your completion summary is what the graph shows of your
work.${standingCorrections(corrections)}`

export const gateCheckInPrompt = (branch: string, refusals: number): string => `\
# Check-in: is this final check on task?

**Goal**: rule on the last phase of the run building \`${branch}\`, where
${refusals} verdicts in a row have now come back \`changes-required\`. This
phase judges the finished branch at map level — coverage against the intent
document, scope creep against incidental extras, mock fidelity, input
acknowledgment, and the comments the branch left behind. The question is
whether its findings are real, whether it is holding the branch to what the
intent document actually agreed, and whether the fixers are resolving causes
or trading one patch for the next. Your answer resumes the run: continue, or
continue with a correction — a standing judgment carried into every agent of
this phase that follows.

**Why you are asked**: you hold the human's intent for this work, while the
agents here hold only the documents and each of them sees one round. A loop
that is circling looks from the inside exactly like a loop that is progressing
— a check flagging what nobody agreed to care about, a fixer patching symptoms
while the cause survives, findings that are not real. Nothing else in the run
can tell those apart, and nothing else will end it: there is no cap, and the
branch is not done until a verdict approves it.

**Constraints on your ruling**: a correction retargets the judgment — what it
weighs, what it stops flagging, what it must not let past. It never adds scope
the intent document did not agree to: changing *what* is being built is the
human's call, and so is killing the run — that is Cancel on the run, never an
answer.

**Context**: the intent document and every report this phase has produced come
with this check-in; the arc across them is what shows whether it is
converging. The branch itself carries the work, already reviewed against its
Spec at interior level — what is in question here is the map-level judgment on
top of that.`

export default workflow({
  description:
    'take an intent document to built code: a Spec, a fresh-context builder, a review loop, and ' +
    'a merge gate — a run ends with a gated branch ready for the human to merge',
  inputs: {
    intent: 'The intent document: what the work this run builds is supposed to accomplish.'
  },
  // The workflow commits per actor below, so the engine's end-of-run commit
  // would only sweep up stray droppings; still on, as the belt to the braces.
  plan: (): PlannedNode[] => [
    {
      id: 'planner',
      model: DOCUMENT_MODEL,
      outputs: {
        spec: { file: 'spec.md', desc: 'the Spec: what to build, derived from the intent document' }
      }
    },
    { id: 'builder', model: CODE_MODEL, parents: ['planner'] },
    {
      id: 'review-1',
      model: DOCUMENT_MODEL,
      parents: ['builder'],
      outputs: {
        review: { file: 'review-1.md', desc: 'the branch judged at interior-module level' }
      }
    },
    { id: 'gate-alignment-1', model: DOCUMENT_MODEL, parents: ['review-1'] },
    { id: 'gate-comments-1', model: DOCUMENT_MODEL, parents: ['gate-alignment-1'] },
    {
      id: 'gate-verdict-1',
      model: DOCUMENT_MODEL,
      parents: ['gate-alignment-1', 'gate-comments-1']
    }
  ],
  run: async (ctx) => {
    // Resolved before any node runs: a repository with no local default
    // branch has no diff target, and discovering that later would waste the
    // planner.
    const target = localDefaultBranch(ctx.cwd)
    const intent = ctx.inputs.intent

    // Every node below states what it follows. The planner is the exception
    // and the point of one: it takes only the kickoff input, so it is a root
    // and declaring anything would be an invented edge.
    const planner = await ctx.node('planner', {
      prompt: plannerPrompt(intent),
      reads: [intent],
      outputs: {
        spec: { file: 'spec.md', desc: 'the Spec: what to build, derived from the intent document' }
      },
      model: DOCUMENT_MODEL
    })
    const spec = planner.outputs.spec

    await ctx.node('builder', {
      prompt: builderPrompt(intent, spec),
      from: ['planner'],
      reads: [intent, spec],
      model: CODE_MODEL
    })
    commit(ctx.cwd, 'build: builder')

    // Every fixer is a new session reading the branch, never a revision of
    // the agent that wrote the code it repairs.
    const reviews: string[] = []
    const corrections: string[] = []
    let sinceCheckIn = 0
    // The loop leaves only through an approving review, so what the merge
    // gate follows is settled on the way out of it.
    let approvedBy: string
    for (let round = 1; ; round++) {
      const review = await ctx.node(`review-${round}`, {
        prompt: reviewerPrompt(target, intent, spec, corrections),
        // The first review follows the builder; every later one follows the
        // fixer that answered the round before it.
        from: [round === 1 ? 'builder' : `fixer-${round - 1}`],
        reads: [intent, spec, ...reviews],
        outputs: {
          review: {
            file: `review-${round}.md`,
            desc: 'the branch judged at interior-module level'
          }
        },
        verdict: VERDICT,
        model: DOCUMENT_MODEL
      })
      reviews.push(review.outputs.review)
      // A review's repro tests are findings made runnable: they land on the
      // branch like any actor's work. A review that added none commits nothing.
      commit(ctx.cwd, `build: review ${round}`)
      const { verdict } = review.verdict as { verdict: string; reason: string }
      // Approval ends the interior loop, not the run: nothing has yet judged
      // the branch against what was agreed.
      if (verdict === 'approved') {
        approvedBy = `review-${round}`
        break
      }

      // Between the review and the fixer it dispatches, so a correction
      // reaches the agent it was written for.
      sinceCheckIn += 1
      if (sinceCheckIn === REVIEWS_PER_CHECK_IN) {
        corrections.push(
          await ctx.ask({
            reason: checkInPrompt(currentBranch(ctx.cwd), round),
            artifacts: {
              intent,
              spec,
              ...Object.fromEntries(reviews.map((path, at) => [`review-${at + 1}`, path]))
            }
          })
        )
        sinceCheckIn = 0
      }

      await ctx.node(`fixer-${round}`, {
        prompt: fixerPrompt(target, intent, spec, review.outputs.review, corrections),
        from: [`review-${round}`],
        reads: [intent, spec, ...reviews],
        model: CODE_MODEL
      })
      commit(ctx.cwd, `build: fixer ${round}`)
    }

    // The gate keeps corrections of its own: interior rulings were scoped to
    // method against the Spec, and this phase answers to the intent document.
    const coverageReports: string[] = []
    const commentReports: string[] = []
    const gateCorrections: string[] = []
    let sinceGateCheckIn = 0
    for (let round = 1; ; round++) {
      // First in the round, so it judges the diff the branch's agents left
      // rather than one the police has already edited.
      const alignment = await ctx.node(`gate-alignment-${round}`, {
        prompt: gateAlignmentPrompt(target, intent, gateCorrections),
        // The gate opens on the review that approved the branch, and every
        // later round on the fixer that answered the verdict before it.
        from: [round === 1 ? approvedBy : `gate-fixer-${round - 1}`],
        reads: [intent, ...coverageReports],
        outputs: {
          report: {
            file: `gate-alignment-${round}.html`,
            desc: 'coverage and unasked work, judged against the intent document'
          }
        },
        model: DOCUMENT_MODEL
      })
      coverageReports.push(alignment.outputs.report)

      const police = await ctx.node(`gate-comments-${round}`, {
        prompt: gateCommentsPrompt(target, gateCorrections),
        from: [`gate-alignment-${round}`],
        outputs: {
          report: {
            file: `gate-comments-${round}.html`,
            desc: 'every comment change made on the branch, with the why'
          }
        },
        model: DOCUMENT_MODEL
      })
      commentReports.push(police.outputs.report)
      // Landed before the verdict judges the tree, so the fixes already read
      // as part of the branch. A round that changed nothing commits nothing.
      commit(ctx.cwd, `build: comment police ${round}`)

      const gate = await ctx.node(`gate-verdict-${round}`, {
        prompt: gateVerdictPrompt(target, intent, gateCorrections),
        from: [`gate-alignment-${round}`, `gate-comments-${round}`],
        reads: [intent, alignment.outputs.report, police.outputs.report],
        verdict: VERDICT,
        model: DOCUMENT_MODEL
      })
      const { verdict, reason } = gate.verdict as { verdict: string; reason: string }
      if (verdict === 'approved') {
        return {
          verdict,
          reason,
          // Earlier coverage rounds judged a branch that no longer exists,
          // while every comment report documents edits still on this one.
          coverageReport: alignment.outputs.report,
          commentReports: [...commentReports],
          merge: mergeCheck(ctx.cwd, target)
        }
      }

      sinceGateCheckIn += 1
      if (sinceGateCheckIn === REVIEWS_PER_CHECK_IN) {
        gateCorrections.push(
          await ctx.ask({
            reason: gateCheckInPrompt(currentBranch(ctx.cwd), round),
            artifacts: {
              intent,
              ...Object.fromEntries(
                coverageReports.map((path, at) => [`gate-alignment-${at + 1}`, path])
              ),
              ...Object.fromEntries(
                commentReports.map((path, at) => [`gate-comments-${at + 1}`, path])
              )
            }
          })
        )
        sinceGateCheckIn = 0
      }

      await ctx.node(`gate-fixer-${round}`, {
        prompt: gateFixerPrompt(
          target,
          intent,
          spec,
          alignment.outputs.report,
          police.outputs.report,
          gateCorrections
        ),
        from: [`gate-verdict-${round}`],
        reads: [intent, spec, ...coverageReports, ...commentReports],
        model: CODE_MODEL
      })
      commit(ctx.cwd, `build: gate fixer ${round}`)
    }
  }
})
