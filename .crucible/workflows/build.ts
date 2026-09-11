import { spawn } from "node:child_process";
import { workflow, type PlannedNode } from "crucible:workflow";

// Intent document to built code, the short way: one builder, then a review
// loop until a reviewer approves. Between every agent that touches the tree
// and the next judgment, the repository's own checks run without a model
// (typecheck, lint, test); a red check goes to a small fixer before any
// reviewer spends a round on a branch that does not even compile. No Spec
// phase, no merge gate: the reviewer judges both the interior and coverage
// against the intent document, because there is nobody after it.
//
// Orchestrator guidance, when a run completes:
// - Give the final review's verdict and reason in chat; the reason is written
//   to be acted on without opening anything.
// - Name the branch and worktree, and relay the merge result: `clean`,
//   `conflicts` with the files named, or `untested` with why.
// - The run never merges or pushes; pulling the branch in is the human's act.

const REVIEW_MODEL = "anthropic/claude-fable-5:high";
const CODE_MODEL = "anthropic/claude-opus-5:high";

/** Three refusals in a row is where a loop stops being worth trusting unwatched. */
const ROUNDS_PER_CHECK_IN = 3;
const CHECK_TIMEOUT_MS = 15 * 60_000;
/** What a fixer is shown of a red check: the tail, where the failures are. */
const CHECK_OUTPUT_CHARS = 20_000;

const VERDICT = {
  type: "object",
  required: ["verdict", "reason"],
  properties: {
    verdict: { enum: ["approved", "changes-required"] },
    reason: { type: "string" },
  },
};

interface Ran {
  status: number | null;
  out: string;
}

// Spawned and awaited, never spawnSync: a synchronous child holds the
// workflow host deaf to the engine for as long as the command takes.
function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<Ran> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const child = spawn(command, args, { cwd });
    const bound = setTimeout(() => {
      out += `\n${command} ${args.join(" ")} killed after ${timeoutMs}ms`;
      child.kill("SIGKILL");
    }, timeoutMs);
    const done = (status: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(bound);
      resolve({ status, out });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", (cause: Error) => {
      out += cause.message;
      done(null);
    });
    child.on("close", (code: number | null) => done(code));
  });
}

async function git(
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; status: number | null; out: string }> {
  const ran = await run("git", args, cwd, 120_000);
  return { ok: ran.status === 0, status: ran.status, out: ran.out.trim() };
}

async function currentBranch(cwd: string): Promise<string> {
  const named = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (named.ok && named.out !== "" && named.out !== "HEAD") return named.out;
  const detached = await git(["rev-parse", "--short", "HEAD"], cwd);
  return detached.ok && detached.out !== ""
    ? `detached at ${detached.out}`
    : "an unnamed branch";
}

/** Never origin: local main is the freshest truth on the machine that runs this. */
async function localDefaultBranch(cwd: string): Promise<string> {
  for (const name of ["main", "master"]) {
    if (
      (
        await git(
          ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`],
          cwd,
        )
      ).ok
    )
      return name;
  }
  throw new Error(
    `build: no local default branch in ${cwd}, nothing to diff against`,
  );
}

/** An empty worktree is a legitimate no-op, but a refused commit fails the run. */
async function commit(cwd: string, message: string): Promise<void> {
  const staged = await git(["add", "-A"], cwd);
  if (!staged.ok) throw new Error(`build: git add failed: ${staged.out}`);
  const anything = await git(["diff", "--cached", "--quiet"], cwd);
  if (anything.ok) return;
  const done = await git(["commit", "-m", message], cwd);
  if (!done.ok) throw new Error(`build: git commit failed: ${done.out}`);
}

type MergeCheck =
  | { result: "clean" }
  | { result: "conflicts"; files: string[] }
  | { result: "untested"; why: string };

// merge-tree answers without touching the worktree; a merge followed by
// --abort would rewrite the tree the run just had reviewed.
async function mergeCheck(cwd: string, target: string): Promise<MergeCheck> {
  const tried = await git(
    ["merge-tree", "--write-tree", "--name-only", target, "HEAD"],
    cwd,
  );
  if (tried.status === 0) return { result: "clean" };
  if (tried.status === 1) {
    const files: string[] = [];
    for (const line of tried.out.split("\n").slice(1)) {
      if (line.trim() === "") break;
      files.push(line.trim());
    }
    return { result: "conflicts", files };
  }
  return {
    result: "untested",
    why: `git merge-tree ended with exit ${tried.status}: ${tried.out.split("\n")[0] ?? ""}`,
  };
}

type Checked = { green: true } | { green: false; out: string };

// The repository's own bar, the same three legs `make validate` runs before
// its build. Cheapest failure first; the first red leg ends the check.
async function runChecks(cwd: string): Promise<Checked> {
  const legs: [string, string[]][] = [
    ["npm", ["run", "typecheck"]],
    ["npm", ["run", "lint"]],
    ["npm", ["test", "--", "--no-cache"]],
  ];
  for (const [command, args] of legs) {
    const ran = await run(command, args, cwd, CHECK_TIMEOUT_MS);
    if (ran.status !== 0) {
      const heading = `$ ${command} ${args.join(" ")}  (exit ${ran.status ?? "none"})\n`;
      const tail =
        ran.out.length > CHECK_OUTPUT_CHARS
          ? `…\n${ran.out.slice(-CHECK_OUTPUT_CHARS)}`
          : ran.out;
      return { green: false, out: heading + tail };
    }
  }
  return { green: true };
}

const standingCorrections = (corrections: string[]): string =>
  corrections.length === 0
    ? ""
    : `

**Standing corrections**: at this run's check-ins, the session that holds the
human's intent for this work ruled on how it is being done. Those rulings bind
you, and they never license work the intent document did not agree to. Oldest
first:

${corrections.map((correction, at) => `${at + 1}. ${correction.trim()}`).join("\n\n")}`;

export const builderPrompt = (intent: string): string => `\
# Build the intent document

**Goal**: implement what the intent document at \`${intent}\` rules, completely,
in this worktree. Done is every behavior the document describes, working, with
tests that prove it at the repository's existing seams.

**Why this document and nothing else**: you arrive with a fresh context. The
interview that produced the document is gone; the document and what its source
material section points at are the whole of what was agreed. Read that source
material before writing anything, mocks included: a cited mock binds the
visuals, and a user-visible control that appears in no cited mock is not yours
to invent. After you, a reviewer who has read the same document will judge
whether the work is done and right.

**Constraints**:

- Where the document rules something, the ruling stands. You implement
  decisions; you do not reopen them. Where it is silent, use the codebase's
  existing practice and the repository's decisions in \`docs/adr/\`.
- \`CONTEXT.md\` at the root is the glossary: use its terms exactly in every
  name you introduce.
- Design for the codebase, not the diff: deep modules behind small interfaces,
  data shapes that cannot express invalid states, tests at the seams the
  repository already tests at. When something you build fights you, change the
  structure rather than plugging around it.
- Comments say why something non-obvious was done, in a line or two, and
  reference nothing outside the code. Nothing else earns a comment.
- \`npm run typecheck\`, \`npm run lint\` and \`npm test\` must pass when you
  finish; run them.
- The work stays in this worktree; nothing is merged or pushed anywhere.

**Context**: you are in a worktree of this repository, on the branch where this
work lives. Your product is the worktree, and your completion summary is what
the graph shows of your work.`;

export const checkFixerPrompt = (
  checkOutput: string,
  corrections: string[] = [],
): string => `\
# Make the checks pass

**Goal**: make \`npm run typecheck\`, \`npm run lint\` and \`npm test\` all exit 0
in this worktree.

**Why**: no reviewer reads this branch while it is red; every red round is pure
cost. The failing output:

\`\`\`
${checkOutput}
\`\`\`

**Constraints**:

- Fix the code to satisfy the checks. Never weaken, skip or delete a check or
  a test to reach green; a check that seems wrong is a blocker to raise.
- This is a repair round, not a feature round: stay minimal.
- The work stays in this worktree; nothing is merged or pushed.

**Context**: the glossary is \`CONTEXT.md\` at the root; the repository's
decisions live in \`docs/adr/\`.${standingCorrections(corrections)}`;

export const reviewerPrompt = (
  target: string,
  intent: string,
  corrections: string[] = [],
): string => `\
# Review the branch

**Goal**: judge what this branch has built against the intent document at
\`${intent}\`, and deliver one verdict: \`approved\` when nothing must change
before a human decides this branch's fate, \`changes-required\` when something
must, with the findings written down where the agent who repairs them can
work from them.

**Why you matter**: you are the only judgment this run makes. There is no
later gate: coverage against the intent document, correctness of the interior,
fidelity to the cited mocks, and the codebase's practices are all yours. A
branch you approve goes to the human as done.

**The work under review**: in your working directory, \`git diff ${target}...HEAD\`
is the whole branch against the commit it was born from.

**The standard**: the intent document, read in full, and the source material it
names. Read the mocks it cites: a user-visible surface is judged against them.

**What a finding is**, and everything a finding must be:

- **A missing or broken promise**: the document rules X; the code as built will
  not do X. Cite the ruling and show why X will not happen.
- **A demonstrable defect**: a bug you can make happen. Every such finding
  carries its reproduction: a failing test written at a seam the repository
  already tests at and left failing on the branch, or a command. What you
  cannot reproduce is not a finding.
- **An unasked-for behavior**: the code does something the document never
  asked of it, and it is not incidental to doing what was asked.
- **A mock departure**: a user-visible control that differs from the cited
  mock, or appears in none of them and was not explicitly ruled.
- **A silent wait**: a user input with no feedback in the frame it lands, or
  work that takes real time with no waiting state. This repository has ruled
  that a defect on par with wrong data.
- **A structural cost**: a representation that can hold an invalid state, a
  second source of truth, a seam placed where behavior cannot be tested
  without editing in place, argued concretely against the codebase.
- Nits are not findings: no formatting, style or wording.

**Constraints on you**:

- Each finding is an argument, with its anchor and its reproduction, so the
  fixer can push back. A finding without them can only be obeyed or ignored.
- Where a defect's cause is structural, say so and name the cause; a fixer is
  licensed to make a big change only where a review has named the reason.
- Beyond failing tests that reproduce findings, change nothing: the code is
  the builder's.
- \`approved\` only when nothing you found must change. What you leave
  ambiguous belongs in your reason, which the human reads in chat.
- Your review is plain markdown, read by the fixer and the reviews after
  yours.

**Context**: you are in a worktree of this repository, on the branch under
judgment. The glossary is \`CONTEXT.md\` at the root; the repository's decisions
live in \`docs/adr/\`.${standingCorrections(corrections)}`;

export const fixerPrompt = (
  target: string,
  intent: string,
  latestReview: string,
  checkOutput: string | undefined,
  corrections: string[] = [],
): string => `\
# Fix the branch

**Goal**: resolve what the reviews of this branch found, so the next review
can approve the work. The latest review, \`${latestReview}\`, is the standing
judgment and comes first; earlier ones show what has already been asked and
what may have been missed twice.

**Why you**: you arrive with a fresh context because the agents who wrote this
code could not see what the reviewer saw. The branch is the only record of
what they did: \`git diff ${target}...HEAD\` in your working directory. A
finding that survives your round comes back as the same argument one review
later, so what you resolve, resolve properly.

**The standard**: the intent document at \`${intent}\` is what this work must
be. The findings are the work; neither licenses building something the
document never asked for.
${
  checkOutput === undefined
    ? ""
    : `
**The checks are red**, in part or in whole because the review left its
reproductions failing on purpose. Their output, for orientation:

\`\`\`
${checkOutput}
\`\`\`
`
}
**Constraints**:

- Fix causes, not symptoms. Where a review names a structural cause, the big
  change is the right one.
- A failing test the review left is a finding made runnable: make it pass, or
  where you judge it wrong, amend or remove it as part of your argument. Either
  way the change is visible to the next review.
- Where you judge a finding mistaken, leave the code as it is and say why in
  your completion summary. A finding silently dropped costs the loop a round.
- \`npm run typecheck\`, \`npm run lint\` and \`npm test\` must pass when you
  finish; run them.
- The work stays in this worktree; nothing is merged or pushed anywhere.

**Context**: the glossary is \`CONTEXT.md\` at the root, use its terms exactly;
the repository's decisions live in \`docs/adr/\`. Your product is the worktree,
and your completion summary is what the graph shows of your
work.${standingCorrections(corrections)}`;

export const checkInPrompt = (branch: string, round: number): string => `\
# Check-in: is this build loop on task?

**Goal**: rule on the review loop building \`${branch}\`, where ${round} reviews
have now come back \`changes-required\`. The question is whether the findings
are real, whether the reviewer is holding the branch to the intent document or
to taste, and whether the fixers are fixing causes or trading one patch for
the next. Your answer resumes the run: continue, or continue with a
correction, a standing judgment carried into every reviewer and fixer that
follows.

**Why you are asked**: you hold the human's intent for this work, while the
agents in the loop hold only the documents and each sees one round. A loop
that is circling looks from the inside exactly like one that is converging,
and nothing else will end it: there is no cap.

**Constraints on your ruling**: a correction rules on method and judgment. It
never adds scope the intent document did not agree to; changing what is being
built is the human's call, and so is killing the run, which is Cancel on the
run, never an answer.

**Context**: the intent document and every review this run has produced come
with this check-in; the arc across the reviews shows whether the loop is
converging.`;

export default workflow({
  description:
    "take an intent document to built code: a builder, the repository checks, and a review loop " +
    "until a reviewer approves — a run ends with a branch ready for the human to pull in",
  inputs: {
    intent:
      "The intent document: what the work this run builds is supposed to accomplish.",
  },
  plan: (): PlannedNode[] => [
    { id: "builder", model: CODE_MODEL },
    {
      id: "review-1",
      model: REVIEW_MODEL,
      parents: ["builder"],
      outputs: {
        review: {
          file: "review-1.md",
          desc: "the branch judged against the intent document",
        },
      },
    },
  ],
  run: async (ctx) => {
    const target = await localDefaultBranch(ctx.cwd);
    const intent = ctx.inputs.intent;
    const corrections: string[] = [];

    // The graph parent of whatever runs next: the last node that touched or
    // judged the tree.
    let head = "builder";

    // Runs the checks after a node that changed the tree; a red result goes to
    // a fixer that has only the output, then the checks run again.
    async function greenAfter(label: string): Promise<void> {
      for (let attempt = 1; ; attempt++) {
        const checked = await runChecks(ctx.cwd);
        if (checked.green) return;
        const id = `${label}-check-fixer-${attempt}`;
        await ctx.node(id, {
          prompt: checkFixerPrompt(checked.out, corrections),
          from: [head],
          model: CODE_MODEL,
        });
        await commit(ctx.cwd, `build: ${id}`);
        head = id;
      }
    }

    await ctx.node("builder", {
      prompt: builderPrompt(intent),
      reads: [intent],
      model: CODE_MODEL,
    });
    await commit(ctx.cwd, "build: builder");
    await greenAfter("builder");

    const reviews: string[] = [];
    let sinceCheckIn = 0;
    for (let round = 1; ; round++) {
      const review = await ctx.node(`review-${round}`, {
        prompt: reviewerPrompt(target, intent, corrections),
        from: [head],
        reads: [intent, ...reviews],
        outputs: {
          review: {
            file: `review-${round}.md`,
            desc: "the branch judged against the intent document",
          },
        },
        verdict: VERDICT,
        model: REVIEW_MODEL,
      });
      reviews.push(review.outputs.review);
      // A review's reproduction tests land on the branch like anyone's work.
      await commit(ctx.cwd, `build: review ${round}`);
      head = `review-${round}`;
      const { verdict, reason } = review.verdict as {
        verdict: string;
        reason: string;
      };

      if (verdict === "approved") {
        // A reviewer's own tests must not have broken the build.
        await greenAfter(`review-${round}`);
        return {
          verdict,
          reason,
          review: review.outputs.review,
          rounds: round,
          branch: await currentBranch(ctx.cwd),
          merge: await mergeCheck(ctx.cwd, target),
        };
      }

      // Red by design after a refusal: the reviewer leaves its reproductions
      // failing, so the output goes to the fixer who holds the review rather
      // than to a check-fixer that never read it.
      const standing = await runChecks(ctx.cwd);

      sinceCheckIn += 1;
      if (sinceCheckIn === ROUNDS_PER_CHECK_IN) {
        corrections.push(
          await ctx.ask({
            reason: checkInPrompt(await currentBranch(ctx.cwd), round),
            artifacts: {
              intent,
              ...Object.fromEntries(
                reviews.map((path, at) => [`review-${at + 1}`, path]),
              ),
            },
          }),
        );
        sinceCheckIn = 0;
      }

      const fixer = `fixer-${round}`;
      await ctx.node(fixer, {
        prompt: fixerPrompt(
          target,
          intent,
          review.outputs.review,
          standing.green ? undefined : standing.out,
          corrections,
        ),
        from: [head],
        reads: [intent, ...reviews],
        model: CODE_MODEL,
      });
      await commit(ctx.cwd, `build: ${fixer}`);
      head = fixer;
      await greenAfter(fixer);
    }
  },
});
