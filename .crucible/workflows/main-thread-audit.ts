import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { workflow, type OutputSpec, type PlannedNode } from 'crucible:workflow'

// Orchestrator guidance: this run audits the main process for anything that
// can hold its event loop, fixes what is safe to fix in place, and leaves a
// branch plus a report. The report names what it fixed, what it measured,
// and what only a structural change (moving the agent host out of the main
// process) would cure. Relay the report; the human decides on the structural
// part. Merge the branch only after reading `fixes.md`: every fix there
// passed lint, typecheck and the test suite, but the human owns the
// judgment on the ones marked as changing timing or ordering.

// Four auditors in parallel, each over one slice of the main process, then
// one fixer with all four findings in hand, a gate, and a report. The
// auditors only read; the fixer is the one node that edits. Everything this
// file itself does in `run()` executes in a workflow host, not the thread
// under audit — but a blocked host is deaf to the engine and dies mid-call
// on a cancel, so it spawns and never spawnSyncs.

const AREAS = {
  'sdk-host': `\
The SDK host: \`src/main/agent/\` entire (the SDK adapter, its event mapper,
transcript and tree builders, cache-miss detection, logging wrapper),
\`src/main/shell/\`, and \`src/main/workflows/sdk-node-session.ts\`. Follow
every call these make into the π SDK under
\`node_modules/@earendil-works/pi-coding-agent/dist/core/\` (session-manager,
agent-session, agent-session-runtime, resource-loader, auth-storage,
settings-manager, skills, and the tools under \`tools/\`) and
\`node_modules/@earendil-works/pi-ai/dist/\`. The SDK is not ours to edit,
but what we call, when, and how often is. Concentrate on cost that scales
with the length of a session (its JSONL file, its message count, its tree),
on work that runs per streamed event, and on what happens when a session
is opened, resumed, jumped or titled.`,

  engine: `\
The workflow engine and everything that fires on its own: \`src/main/workflows/\`
(engine, loader, service, store, worktree, select-service, channel),
\`src/main/schedules/\`, \`src/main/monitors/\`, and the shared pieces they
lean on under \`src/shared/workflows/\` and \`src/shared/monitors/\`. Two
facts to hold in mind. First, a workflow file's own code — \`run()\`,
\`plan()\`, a node's \`check\`, a schedule's \`check\` — executes in a
workflow host, a utility process per file, so an author's synchronous call
cannot hold the window; what CAN hold it is \`src/main/workflows/host/\` and
the engine's own side of that wire, plus anything the engine does per
message. Second, every node of every
run is a full SDK session in this same process, so N concurrent nodes are N
agents' worth of whatever the SDK does synchronously. The scheduler's
per-minute evaluation, the monitor loop, run record persistence and the
loader's TypeScript transform are all on the clock.`,

  'workspace-and-stores': `\
The OS-facing services and the stores: \`src/main/workspace/\` (the service,
board collection and facts, file listing, capture, research processes,
worktree creation and its scripts), \`src/main/panel/\`, \`src/main/shell/store.ts\`,
\`src/main/quota/\`, \`src/main/cache/\`, \`src/main/log/\`, \`src/main/commands/\`,
\`src/main/skills/\`, \`src/main/app-update/\`, \`src/main/shipped.ts\` and
\`src/main/index.ts\`. Concentrate on what runs on every write (the shell
store persists the whole state on each change; the log sink writes
synchronously on every record), on anything that walks a directory or a
repository, on anything that scales with the size of a workspace or the
number of its worktrees, and on git and other child processes: which are
spawned and which are waited on synchronously.`,

  'ipc-and-renderer': `\
The seam to the window and the window itself. Main side: every
\`serve*Channel\` under \`src/main/*/channel.ts\`, what each sends, how large
the payloads get and how often they are sent while a turn streams or a run
progresses; the preload in \`src/preload/\`. Renderer side:
\`src/renderer/src/Shell.tsx\`, \`state/\`, \`components/\` (the transcript,
markdown rendering, the run graph, the boards) and \`runs/graph.ts\`. A
renderer long task freezes the window without a beachball, and main pays
for every \`webContents.send\` it serializes, so both halves are in scope.
Concentrate on work that repeats per streamed delta, on anything that
rebuilds a whole transcript or graph from scratch on each event, and on
payloads that carry more than the receiver reads.`
} as const

type Area = keyof typeof AREAS

const CONTEXT = `\
**Context you cannot find in the code**: on a Mac the app shows the beachball
for long stretches, intermittently, and nobody has caught it in the act.
Electron's main process runs Node and the window's own message loop on one
thread, so any synchronous work in main is the window not responding, and
today main hosts every agent: the user's sessions through the SDK adapter,
every node of every workflow run through the same SDK, every workflow's
\`run()\` body and every schedule's \`check\`. The human's standard is that
nothing any agent can do, from any of those places, may ever hold that
thread. Moving the whole agent host into a separate process is being weighed
separately; what this run owes them is a true picture of what holds the
thread now, so that decision is made on evidence rather than on a feeling.

Since commit 45a5405 the main process watches itself: \`src/main/watchdog/stalls.ts\`
writes a \`main_stalled\` record to the run log for every stall of 250ms or
more, with the frames that held the loop. Read it to understand what the
log will show from now on; any log files under \`logs/\` in this worktree's
parent checkout are from before it existed. The repository's glossary is
\`CONTEXT.md\` at the root; \`AGENTS.md\` says how the app is launched and
which launches are forbidden to you. Never launch, read from or write to the
installed app or its state.`

const auditPrompt = (area: Area): string => `\
# Find what holds the main thread: ${area}

**Goal**: a findings file naming every place in your slice where the main
process's event loop can be held, with evidence of how long and how often,
ranked so that a reader with an hour fixes the right thing first.

**Why it matters**: ${CONTEXT.replace('**Context you cannot find in the code**: ', '')}

**Your slice**: ${AREAS[area]}

**What counts as a finding**: a synchronous file, network or child-process
call; CPU-bound work whose cost grows with something a user can make large
(a session's length, a repository's size, the number of runs or worktrees,
the number of open sessions); work that runs on every streamed event or on
every timer tick where once would do; a payload serialized across the IPC
boundary that is larger than what the receiver uses; and any path where an
agent's action (a tool call, a workflow's own code, a schedule's check)
runs arbitrary synchronous work in this process. A call that is synchronous
but bounded and rare, a one-time read of a small file at launch for
instance, is worth a line so the reader knows you saw it, and no more.

**Evidence over estimate**: where the cost depends on size, measure it.
A short script run against a large real input (a multi-megabyte session
JSONL, a workspace with many worktrees, a transcript of thousands of items)
and its numbers in the findings beat any adjective. The fake flavor of the
app (\`npm run dev\`) is yours to drive and is free; the SDK flavor costs
money and is not authorized here. Do not edit any source file: this node
reads and measures, and the fixer that follows works from what you write.

**Findings file shape**: one entry per finding, ranked, each with the file
and line, the trigger (what user or agent action reaches it), how the cost
scales and what you measured or why you could not, and the fix shape with
its risk: safe to change in place, changes timing or ordering, or reachable
only by moving the work out of this process. Close with a short section on
what in your slice is fine and why, so the fixer does not re-audit it.
This is the shape of one entry, about a different subject:

> **3. The issue board re-parses every label file on each keystroke.**
> \`src/main/issues/labels.ts:88\`, reached from the board's filter box on
> every input event. Cost is linear in the label file count: 400 files
> measured at 140ms per keystroke, 40 files at 12ms. Fix: parse once per
> board open and invalidate on the watcher; safe in place, the parse is pure.

**Done** is the findings file written, with every finding carrying a
location and a trigger, and a verdict counting the findings by fix shape.`

const AUDIT_VERDICT = {
  type: 'object',
  required: ['inPlace', 'timing', 'structural'],
  properties: {
    inPlace: { type: 'number' },
    timing: { type: 'number' },
    structural: { type: 'number' }
  }
}

const fixPrompt = (findings: readonly string[]): string => `\
# Take the main thread back

**Goal**: apply every fix from the four findings files that is safe to
make in this worktree, so that what remains on the main thread is either
bounded and rare or genuinely needs a different process, and write the
fixes file that accounts for every finding either way.

**Why it matters**: ${CONTEXT.replace('**Context you cannot find in the code**: ', '')}

**The findings**, one file per slice, each ranked by its author:
${findings.map((path) => `- ${path}`).join('\n')}

Read all four before touching anything; the same store or seam often shows
up in two of them from different sides, and one change should serve both.

**What you may do**: turn a synchronous call into its asynchronous form
where the caller is already asynchronous and nothing depends on the old
ordering; move a bounded transform off a hot path (once per turn instead of
once per delta, cached instead of rebuilt); make a payload carry what its
receiver reads; replace a \`spawnSync\` with a \`spawn\` that is awaited;
shrink a per-tick or per-event cost the findings measured. Where a finding
in \`.crucible/workflows/\` or in the authoring doc concerns what workflow
authors are told to do in \`run()\`, fix the shipped example and the doc.
Keep every seam's interface as it is: the agent port, the channels, the
fake adapter's behavior. Every test that exists near a change is yours to
keep green and to extend when the change adds a case it would not catch.

**What you must not do**: edit anything under \`node_modules\`; introduce a
worker or a utility process for the agent host (that is the separate
decision); change what any agent, node or run observes beyond timing; add a
dependency; touch \`.crucible/align/\` or \`.crucible/runs/\`. A fix the
findings mark as changing timing or ordering is yours to make only where you
can show, in the fixes file, what ordering the change preserves and what
test proves it; otherwise leave it and say so.

**At the edge**: a finding that would take more than a contained change
stays unfixed and goes in the fixes file with what it would take. Fix what
fits; list the rest. Prefer three fixes the reader can trust over ten they
have to re-derive.

**Fixes file shape**: one entry per finding across all four files, in the
findings' own numbering, saying fixed (with the commit and the test that
holds it), left (with why), or not a finding on reflection (with why). Then
the list of findings only a structural change reaches, gathered from all
four, as one ranked list: this is what the human reads to decide that
question.

**Done** is lint, typecheck and the test suite passing on the branch, the
fixes file written, and the worktree committed in stages whose messages a
reader could follow. The mechanical gate runs after you finish and sends
its failures back to you.`

const reportPrompt = (findings: readonly string[], fixes: string): string => `\
# Write the report

**Goal**: one HTML page a human reads in five minutes that says what held
the main thread, what this run fixed and how it proved the fix, what it
measured and left, and what only a structural change would cure, ranked by
how much of the beachball it would buy back.

**Why it matters**: the human has been staring at a spinner for weeks and
is deciding whether to move the agent host into its own process. The report
is the evidence that decision rests on. It must not overstate: a fix that
was reasoned but not measured says so.

**Sources**: the four findings files and the fixes file, plus the branch
itself.
${[...findings, fixes].map((path) => `- ${path}`).join('\n')}

**Shape**: a short verdict at the top in plain prose, then the fixes with
their evidence, then what is left in this process ranked, then the
structural list. Plain HTML with a little inline CSS, readable in a
webview; no scripts, no external assets. Write the way a careful engineer
writes to a peer: plain words, concrete numbers, no cheerleading.`

const FIXES: OutputSpec = { file: 'fixes.md', desc: 'every finding accounted for' }

const REPORT: OutputSpec = {
  file: 'report.html',
  desc: 'what held the main thread, what was fixed, what is left, and what needs a new process'
}

// Async on purpose: this body runs in the very process under audit.
function run(
  command: string,
  args: readonly string[],
  cwd: string
): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { cwd, env: process.env })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()))
    child.on('error', (cause) => resolve({ ok: false, out: `${out}\n${cause.message}`.trim() }))
    child.on('close', (status) => resolve({ ok: status === 0, out: out.trim() }))
  })
}

async function commit(cwd: string, message: string): Promise<void> {
  const staged = await run('git', ['add', '-A'], cwd)
  if (!staged.ok) throw new Error(`main-thread-audit: git add failed: ${staged.out}`)
  if ((await run('git', ['diff', '--cached', '--quiet'], cwd)).ok) return
  const done = await run('git', ['commit', '-m', message], cwd)
  if (!done.ok) throw new Error(`main-thread-audit: git commit failed: ${done.out}`)
}

/** The gate: what CI runs before it publishes, in the same order. */
async function gate(cwd: string): Promise<{ ok: boolean; out: string }> {
  for (const script of ['lint', 'typecheck', 'test']) {
    const ran = await run('npm', ['run', script, '--silent'], cwd)
    if (!ran.ok) return { ok: false, out: `npm run ${script} failed:\n${ran.out.slice(-6000)}` }
  }
  return { ok: true, out: '' }
}

const findingsOutput = (area: Area): OutputSpec => ({
  file: `findings-${area}.md`,
  desc: `every place in the ${area} slice that can hold the main thread, ranked, with evidence`
})

export default workflow({
  description:
    'audit the main process for anything that can hold its event loop, fix what is safe in place, report the rest',
  inputs: {},
  plan: (): PlannedNode[] => [
    ...(Object.keys(AREAS) as Area[]).map((area) => ({
      id: `audit-${area}`,
      outputs: { findings: findingsOutput(area) }
    })),
    { id: 'fix', outputs: { fixes: FIXES } },
    { id: 'report', outputs: { report: REPORT } }
  ],
  run: async (ctx) => {
    const areas = Object.keys(AREAS) as Area[]
    const audits = await Promise.all(
      areas.map((area) =>
        ctx.node(`audit-${area}`, {
          prompt: auditPrompt(area),
          outputs: { findings: findingsOutput(area) },
          verdict: AUDIT_VERDICT
        })
      )
    )
    const findings = audits.map((audit) => audit.outputs.findings)

    const fixer = await ctx.openNode('fix', {
      prompt: fixPrompt(findings),
      reads: findings,
      outputs: { fixes: FIXES }
    })
    let fixed = fixer.result
    try {
      for (let round = 1; round <= 3; round++) {
        await commit(ctx.cwd, `main-thread-audit: fixes, round ${round}`)
        const checked = await gate(ctx.cwd)
        if (checked.ok) break
        if (round === 3) {
          throw new Error(`main-thread-audit: the gate still fails after ${round} rounds:\n${checked.out}`)
        }
        fixed = await fixer.revise(
          `The mechanical gate failed on the branch as you left it. Make it pass without ` +
            `giving up a fix you can defend; if a fix cannot be made to pass, revert it and ` +
            `say so in the fixes file.\n\n${checked.out}`,
          { from: [] }
        )
      }
    } finally {
      fixer.close()
    }

    const report = await ctx.node('report', {
      prompt: reportPrompt(findings, fixed.outputs.fixes),
      reads: [...findings, fixed.outputs.fixes],
      outputs: { report: REPORT },
      tools: ['read', 'write', 'bash', 'grep', 'find', 'ls']
    })
    await commit(ctx.cwd, 'main-thread-audit: report')

    return {
      summary: report.summary,
      report: report.outputs.report,
      fixes: fixed.outputs.fixes,
      findings: Object.fromEntries(areas.map((area, index) => [area, findings[index]])),
      artifactDir: join(ctx.artifactDir)
    }
  }
})
