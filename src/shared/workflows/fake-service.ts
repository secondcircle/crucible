import type { SessionId, TranscriptItem, Unsubscribe } from '../agent/port'
import type { RunTools } from '../agent/run-tools'
import { artifactKind, artifactName, recordNamesPath } from './artifacts'
import {
  dismissRefusal,
  INTERRUPTED_MESSAGE,
  interruptedNodes,
  resumeRefusal,
  runMessageHeader,
  type RunArtifact,
  type RunNode,
  type RunRecord,
  type WorkflowRunId
} from './run'
import {
  createTurnStart,
  describeRun,
  interruptionNotice,
  resumeAnswer
} from './status'
import type {
  ArtifactView,
  MainWorkflowRunService,
  RunsSnapshot,
  ScheduledFireRequest,
  WorkflowRunListener
} from './service'

// The fake flavor's runs: scripted, deterministic, free. A `crucible_run`
// tool call starts a run that walks its nodes on a timer, parks once when
// the workflow is `build` (so the routed-question surfaces are exercisable),
// and completes with the same message-to-the-orchestrator the engine sends.
// Four canned records seed the global view — one waiting on a person, one
// finished, one failed whose orchestrator session is gone, and one the app
// quit out from under — so ⌘R shows its bands, and Dismiss, Investigate and
// Resume all have something to act on, without anything having been started.
//
// Scripted nodes declare the artifacts they will write and then write them,
// so the artifact rail, the reader and the exhibit-run route are all
// exercised under `npm run dev`.

/** The workspace the canned records claim to have run in. */
export interface CannedWorkspace {
  readonly path: string
  readonly name: string
}

// Only a fallback, and only for tests: Investigate needs the run's workspace
// open in the sidebar, and a made-up path never can be. A launch hands in a
// real directory instead, so the canned rows stay investigable.
const FALLBACK_WORKSPACE: CannedWorkspace = { path: '/fake/resume-site', name: 'resume-site' }

/** The parked-with-no-one-to-ask run, named because its answer path is wired. */
const CANNED_UNATTENDED_ID = 'g8x2'

/** The interrupted run, whose Resume walks the rest of the way on the beat. */
const CANNED_INTERRUPTED_ID = '45c8'

// The orchestrator the interrupted run reports to. No sidebar session can ever
// carry this id, so its notice waits until a session adopts the run — which is
// the whole path a test drives: adopt, then take a turn.
const CANNED_INTERRUPTED_SESSION = 'fake-interrupted-orchestrator'

/** Slow enough to watch under `npm run dev`; tests pass zero. */
const DEFAULT_BEAT_MS = 700

const FAKE_QUESTION =
  'Third review round on the same argument — where should the merge helper live? ' +
  'The spec is silent and the reviewers disagree.'

// This module is compiled into the renderer bundle too, so it takes no
// `node:` import: main hands it the file access, and a test hands it a map.
export interface FakeArtifactFiles {
  /** The run's artifact directory, created on first ask. */
  dir(runId: WorkflowRunId): string
  write(path: string, body: string): void
  /** The file's text, or nothing when there is no file. */
  read(path: string): string | undefined
  /** Size in bytes, or nothing when there is no file. */
  size(path: string): number | undefined
}

/** What a test hands in: the same capability with nothing on disk. */
export function memoryArtifactFiles(
  root = '/fake/state/workflow-runs'
): FakeArtifactFiles & { readonly written: Map<string, string> } {
  const written = new Map<string, string>()
  return {
    written,
    dir: (runId) => `${root}/${runId}/artifacts`,
    write: (path, body) => {
      written.set(path, body)
    },
    read: (path) => written.get(path),
    size: (path) => {
      const body = written.get(path)
      return body === undefined ? undefined : body.length
    }
  }
}

interface LiveNode {
  id: string
  status: RunNode['status']
  parents: string[]
  model?: string
  reads: RunArtifact[]
  artifacts: RunArtifact[]
  verdict?: unknown
  error?: string
  summary?: string
  startedAt?: string
  endedAt?: string
  lastActivityAt?: string
  now?: string
  toolCalls?: number
  contextPercent?: number
  cost?: number
}

interface LiveRun {
  id: WorkflowRunId
  workflow: string
  status: RunRecord['status']
  workspacePath: string
  workspaceName: string
  sessionId?: SessionId
  scheduled?: true
  worktreePath?: string
  branch?: string
  baseCommit?: string
  finalCommit?: string
  inputs: Record<string, string>
  inputDescs?: Record<string, string>
  question?: { reason: string; nodeId?: string; raisedAt: string; answeredAt?: string; answer?: string }
  waiting?: boolean
  nodes: LiveNode[]
  outputs?: Record<string, unknown>
  error?: string
  createdAt: string
  startedAt?: string
  endedAt?: string
  dismissedAt?: string
  dir?: string
  noticePending?: true
}

/** One output of a scripted node: what it declares, and what it writes. */
interface ScriptedOutput {
  readonly name: string
  readonly file: string
  readonly desc: string
  readonly body: string
}

interface ScriptedNode {
  readonly id: string
  readonly parents: readonly string[]
  readonly model: string
  // Whether the plan already knows about the outputs. A planned node shows its
  // expected artifacts as a ghost; the rest declare theirs when they start.
  readonly planned: boolean
  readonly outputs: readonly ScriptedOutput[]
  /** Input names this node reads, then artifact files of earlier nodes. */
  readonly readsInputs: readonly string[]
  readonly readsFiles: readonly string[]
  /** What the node concludes, for the nodes that conclude anything. */
  readonly verdict?: { readonly verdict: string; readonly reason: string }
}

// Deliberately long so the reader's scrolling is checkable in the fake flavor;
// every other canned body stays short, keeping the no-scrollbar case checkable.
const SPEC_BODY = `# Spec — the scripted build

The planner's product: what the builder implements and the reviewer judges.

## What done means

- The rail lists every artifact this run touched, inputs first.
- Clicking one opens it here, in place of the node transcript.
- Nothing in the view writes, deletes or re-runs anything.

## The defect this run was started for

A run's artifacts were reachable only through the node that produced them.
Open a run, pick the node, read the strip at its foot, click the file. Three
steps to answer "what did this run actually write", and the answer was
scattered across as many nodes as the graph had. Nothing showed the run's
product as one list.

The rail is that list. It stands to the right of the detail pane for as long
as the window has room for it, and it names every file the record knows
about, in the order the run first mentioned each one.

## The rail

### What it holds

1. The run's inputs, in the order the kickoff named them.
2. Every artifact any node declared, whether or not it was written.
3. Nothing else. A file a node touched without declaring is not the run's product and does not appear.

### Ordering

First appearance, and first appearance only. A node that starts late and
declares a path the record has not seen puts that path at the end of the
list. A path that was already there stays where it was, even if a later node
rewrites it. The order is remembered for as long as the run view is open;
reopening the run derives it from record order again.

The alternative, sorting by write time, was rejected: rows would jump under
the pointer while a run walks, and a rail that reorders itself mid-read is
worse than one that occasionally looks stale.

### Row states

- **Written.** The file exists and has a stamp. The row is fully lit and clicking it opens the reader.
- **Pending.** A node declared it and has not written it yet. The row is dimmed with a dashed marker.
- **Never.** The node that owed it failed. The row stays, dimmed, marked never written. It does not disappear: a file that was promised and never arrived is a fact about the run, and dropping the row hides it.

A pruned ghost is the one row that leaves. When the record stops naming a
path the plan had only guessed at, its row goes and, if the reader was
showing it, the node's transcript comes back by itself.

### The count

The rail's header counts artifacts, not nodes. Six files across three nodes
reads "6 artifacts". The count gives way before the controls do: at the
pane's narrowest the number is what gets ellipsized.

## The reader

### Opening

A rail row opens the reader. So does a chip in the node strip, and so does
the artifact name anywhere else in the view. The reader takes the detail
pane, in place of the node transcript. The graph does not move. The rail does
not move. The run view's header does not move.

### Its header

One row: the file's name, then where it came from and when, then the two
actions, then the way out.

- The name, in the mono face, accented.
- The provenance line: written by which node, how long ago, how large. An input reads "handed in at kickoff" instead. A never-written file reads "never written" and names the node that failed.
- **Reveal in Finder**, on written files only. There is nothing to reveal for a file that does not exist.
- **Copy path**, on every state. It says "Copied" for a moment and then says what it does again.
- **esc back to the node**, right-aligned, which is also what the Escape key does.

Below the header, the full path on its own row, ellipsized from the right
when the pane is narrow.

### The body

Three kinds, one container.

| Kind | Rendered as | Notes |
| --- | --- | --- |
| Markdown | The app's own renderer | No HTML is parsed from the string |
| Plain text | Preformatted, wrapped | Long tokens break rather than overflow |
| HTML | A sandboxed frame | Served under its own origin, never inlined |

The body scrolls. The header and the path row do not. This holds for a file
of any length, which is the whole point of a reader: a spec of two hundred
lines is read by scrolling, not by resizing the window and hoping.

HTML is the exception to the container, not to the rule. It fills the space
below the path row and scrolls inside its own frame, because a document from
another origin scrolls itself.

### Placeholders

- Not written yet: "This file has not been written yet."
- Never written: "This file was never written."
- In flight: "Reading…".
- Refused or unreadable: whatever the read said went wrong, in the body, with the rail row left alone.

None of these is an error dialog. A file that is not there yet is an ordinary
state of a running run.

### Read-only, without exception

The reader shows. It does not edit, it does not delete, it does not re-run
the node that wrote the file. The two header actions are about the file on
disk and never about the run. This is not a matter of what is convenient to
build; it is what the view is for.

## The gate

Every read is checked against the run's own record, by exact string equality
against the paths the record names. Not by resolving against the filesystem,
not by prefix matching a directory. A path the record does not name is
refused with "That file is not one this run touched", and the refusal reads
the same in both flavors of the service because both ask the same function.

What this buys: a relative path climbing out of the artifact directory
matches no entry, so it is refused for the same reason any other unknown path
is. There is no separate traversal check to keep correct.

## Refresh

A written artifact is read when the reader opens it and again when a slot the
reader is watching fills. Nothing tails the file. The key carries the run,
the path and the write stamp, so a rewrite refetches and a quiet file does
not.

While a read is in flight, nothing of another artifact is ever shown under
this one's name. The answer that arrives is matched against the key that was
asked for and dropped if they disagree.

## Keyboard

Escape unwinds one layer at a time, outermost last: full screen, then the
reader, then the run view. Nothing else in the reader binds a key. There is
no scroll shortcut, no jump-to-top, no find. The platform's own scrolling is
what the mocks draw and it is what ships.

## Geometry

The graph pane starts at 640px and is dragged wider by the splitter. The
splitter's width is remembered for the whole app, in the profile's own
storage, so a dev launch and the installed app cannot move each other's
divider.

Room is given up in a fixed order as the window narrows: the rail goes first,
then the graph is clamped, and the detail pane keeps a floor of 400px because
below that it stops being a reading surface. Full screen puts the detail
column away without taking it apart, so leaving full screen lands on the same
transcript, scrolled where it was.

## What this does not do

These bind as strongly as the list above.

- No editing, no deleting, no re-running from the rail or the reader.
- No search across a run's artifacts. One file at a time.
- No diff between two versions of the same file. The reader shows what is on disk now.
- No download, no export, no share. Reveal in Finder is the door out.
- No scroll-position memory. Closing and reopening a file starts at the top.
- No new IPC. Every read rides the channel the run service already has.

## Testing intent

The rail's ordering, the row states, the gate's refusals and the reader's
placeholders are all unit-testable and are tested at the shell seam against
the fake service. Layout is not: the test environment computes none, so what
a pane does with a tall child is checked in the running app under the fake
flavor and nowhere else.

This file is itself a fixture for that check. It is long on purpose.

## Rejected alternatives

**A modal over the graph.** Reading an artifact and looking at the node that
wrote it are the same thought; a modal makes them alternatives.

**A fourth column.** The window does not have the room, and the reader would
be a column of forty characters on any laptop.

**Rendering HTML inline after sanitizing it.** A sanitizer is a thing you can
misconfigure. A frame under its own origin is a thing you cannot.

**Tailing written files.** Interesting for a log, wrong for an artifact:
artifacts are written once, at the end of a node, and a tail would spend its
life idle.

## Open questions

None. The intent document ruled on every one of them, and the ones it did not
reach were decided here and marked for veto.
`

const CHANGES_BODY = `# Changes

- \`src/renderer/src/components/ArtifactRail.tsx\` — the run view's third column.
- \`src/renderer/src/components/ArtifactReader.tsx\` — one artifact, rendered.
- \`src/main/workflows/engine.ts\` — declared outputs recorded at node start.
`

const REVIEW_BODY = `# Review — changes required

The branch does what the spec asked, with one finding that must land first:

1. The rail's count reads artifacts, not nodes, which is what the mock draws.
2. A failed node keeps its row, marked never written — this one drops it.
`

const REVIEW_TESTS_BODY = `# Review (tests) — approved

Ran against the same branch as the code review, at the same time.

- Every seam the spec named has a test at it.
- Nothing here needs the code review's finding resolved first.
`

const FIXES_BODY = `# Fixes

What the code review asked for, done:

- A failed node keeps its declared row and is marked never written.
- The regression the review left failing now passes.
`

const REVIEW_R1_BODY = `# Review — approved

The finding is resolved and the reproduction passes. Nothing else changed.
`

const REPORT_BODY = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Scripted run report</title>
<style>
  body{background:#191419;color:#e8dfe2;font:14px/1.6 -apple-system,sans-serif;padding:28px}
  h1{font-size:17px;color:#f0a37c;margin:0 0 12px}
  li{margin-bottom:6px}
  code{font:12px ui-monospace,Menlo,monospace;color:#f0a37c}
</style></head>
<body>
  <h1>What this scripted run did</h1>
  <p>Nothing was sent anywhere and nothing cost money. This page is an
  artifact of the fake flavor, served under its own origin.</p>
  <ul>
    <li>Walked its nodes on a timer.</li>
    <li>Wrote every artifact it declared, <code>report.html</code> included.</li>
    <li>Reported back to the session that started it.</li>
  </ul>
</body></html>
`

/** What a canned run's artifacts hold, by file name. */
const CANNED_BODIES: Readonly<Record<string, string>> = {
  'spec.md': SPEC_BODY,
  'changes.md': CHANGES_BODY,
  'review.md': REVIEW_BODY,
  'review-tests.md': REVIEW_TESTS_BODY,
  'fixes.md': FIXES_BODY,
  'report.html': REPORT_BODY
}

const CANNED_BODY = 'A canned artifact of the fake flavor.\n'

/** The scripted graph of a workflow: what its nodes read, declare and write. */
function scriptOf(workflow: string): readonly ScriptedNode[] {
  if (workflow !== 'build') {
    return [
      {
        id: 'work',
        parents: [],
        model: 'anthropic/claude-opus-5:high',
        planned: true,
        outputs: [
          {
            name: 'report',
            file: 'report.html',
            desc: "the node's report of what it did and why, for the human",
            body: REPORT_BODY
          }
        ],
        readsInputs: ['prompt'],
        readsFiles: []
      }
    ]
  }
  return [
    {
      id: 'planner',
      parents: [],
      model: 'anthropic/claude-fable-5:high',
      planned: true,
      outputs: [
        {
          name: 'spec',
          file: 'spec.md',
          desc: 'the Spec: what to build, derived from the intent document',
          body: SPEC_BODY
        }
      ],
      readsInputs: ['intent'],
      readsFiles: []
    },
    {
      id: 'builder',
      parents: ['planner'],
      model: 'anthropic/claude-opus-5:high',
      planned: false,
      outputs: [
        {
          name: 'changes',
          file: 'changes.md',
          desc: 'every file the builder touched, with reasons',
          body: CHANGES_BODY
        }
      ],
      readsInputs: ['intent'],
      readsFiles: ['spec.md']
    },
    // Two reviewers on one builder, so the graph has a fan-out to draw.
    {
      id: 'review-1',
      parents: ['builder'],
      model: 'anthropic/claude-fable-5:high',
      planned: true,
      outputs: [
        {
          name: 'review',
          file: 'review.md',
          desc: "the reviewer's verdict and its evidence",
          body: REVIEW_BODY
        }
      ],
      readsInputs: [],
      readsFiles: ['spec.md', 'changes.md'],
      verdict: { verdict: 'changes-required', reason: 'one finding, with its reproduction' }
    },
    {
      id: 'review-tests',
      parents: ['builder'],
      model: 'anthropic/claude-fable-5:high',
      planned: true,
      outputs: [
        {
          name: 'review',
          file: 'review-tests.md',
          desc: 'the branch judged at its test seams',
          body: REVIEW_TESTS_BODY
        }
      ],
      readsInputs: [],
      readsFiles: ['changes.md'],
      verdict: { verdict: 'approved', reason: 'every seam the spec named has a test at it' }
    },
    // Both reviews arrive at one fixer: the fan-in.
    {
      id: 'fixer-1',
      parents: ['review-1', 'review-tests'],
      model: 'anthropic/claude-opus-5:high',
      planned: false,
      outputs: [
        {
          name: 'fixes',
          file: 'fixes.md',
          desc: 'what the review asked for, and what was done about it',
          body: FIXES_BODY
        }
      ],
      readsInputs: [],
      readsFiles: ['review.md', 'review-tests.md']
    },
    // The send-back: the same reviewer's session, one round on, re-declaring
    // the file it wrote the first time. Parents as revise() writes them: the
    // base, a whole round up, so one edge in the fake spans layers.
    {
      id: 'review-1·r1',
      parents: ['review-1', 'fixer-1'],
      model: 'anthropic/claude-fable-5:high',
      planned: true,
      outputs: [
        {
          name: 'review',
          file: 'review.md',
          desc: "the reviewer's verdict and its evidence",
          body: REVIEW_R1_BODY
        }
      ],
      readsInputs: [],
      readsFiles: ['fixes.md'],
      verdict: { verdict: 'approved', reason: 'the finding is resolved and its repro passes' }
    }
  ]
}

export interface FakeWorkflowRunOptions {
  /** Zero advances the script on immediate timers. */
  readonly beatMs?: number
  /** How a run speaks to its orchestrator; absent leaves runs silent. */
  readonly deliver?: (sessionId: SessionId, text: string) => void
  // Where scripted artifacts are written and read. Absent keeps the records
  // right and leaves `artifact()` with nothing to answer from.
  readonly files?: FakeArtifactFiles
  // The workspace the three canned records sit in. It must be a directory the
  // user can have open, since that is what Investigate needs to make a session
  // in; absent leaves the canned rows with a path no sidebar can match.
  readonly workspace?: CannedWorkspace
  /** Shows a file in the OS file manager; absent leaves Reveal unable to act. */
  readonly reveal?: (path: string) => void
}

export function createFakeWorkflowRunService({
  beatMs = DEFAULT_BEAT_MS,
  deliver,
  files,
  workspace = FALLBACK_WORKSPACE,
  reveal
}: FakeWorkflowRunOptions = {}): MainWorkflowRunService {
  const listeners = new Set<WorkflowRunListener>()
  const timers = new Map<WorkflowRunId, ReturnType<typeof setTimeout>>()
  const waiting = new Map<WorkflowRunId, (answer: string) => void>()
  const paused = new Set<WorkflowRunId>()
  let minted = 0

  const nowIso = (): string => new Date().toISOString()

  const artifactDir = (runId: WorkflowRunId): string =>
    files?.dir(runId) ?? `/fake/state/workflow-runs/${runId}/artifacts`

  // The run's own directory, which is the artifact directory's parent — the
  // same `<root>/<runId>/` the live store lays out. It is what the
  // Investigate prompt names as the place to read run.json and transcripts.
  const runDir = (runId: WorkflowRunId): string =>
    artifactDir(runId).replace(/[\\/]artifacts$/, '')

  const records: LiveRun[] = [
    cannedUnattended(workspace, artifactDir, runDir),
    cannedInterrupted(workspace, artifactDir, runDir),
    cannedFailed(workspace, artifactDir, runDir),
    cannedFinished(workspace, artifactDir, runDir)
  ]
  // The canned runs' files exist from the moment the service does, so opening
  // one in the reader shows real content without anything having been started.
  for (const run of records) {
    for (const node of run.nodes) {
      for (const artifact of node.artifacts) {
        if (artifact.writtenAt === undefined) continue
        files?.write(artifact.path, CANNED_BODIES[artifactName(artifact.path)] ?? CANNED_BODY)
      }
    }
  }
  // The canned parked run is answerable, not just observable: once a session
  // has adopted it, crucible_answer from there unblocks its builder and the
  // script walks the rest of the run home. That is the unstick demo, free.
  const stuck = records.find((run) => run.id === CANNED_UNATTENDED_ID)
  if (stuck !== undefined) {
    waiting.set(stuck.id, (answer) => {
      waiting.delete(stuck.id)
      resumeCannedParked(stuck, answer)
    })
  }

  function changed(): void {
    const event = { type: 'runs', snapshot: snapshotNow() } as const
    for (const listener of [...listeners]) listener(event)
  }

  function snapshotNow(): RunsSnapshot {
    return { runs: records as readonly RunRecord[] }
  }

  function tell(run: LiveRun, text: string): void {
    if (run.sessionId === undefined || deliver === undefined) return
    try {
      deliver(run.sessionId, text)
    } catch {
      // A message that did not land leaves whatever it was owed still owed,
      // exactly as the engine leaves it.
      return
    }
    // Any message that reaches the orchestrator is the wake-up an interruption
    // notice was owed.
    if (run.noticePending === true) {
      delete run.noticePending
      changed()
    }
  }

  // Every run of this session that is owed an interruption notice says it now,
  // composed from the record as it stands — the engine's `wake`, in the fake.
  function wake(sessionId: SessionId): void {
    for (const run of records) {
      if (run.noticePending !== true || run.sessionId !== sessionId) continue
      tell(run, interruptionNotice(run as RunRecord))
    }
  }

  const turnStart = createTurnStart({
    runs: () => records as readonly RunRecord[],
    wake
  })

  function requireRun(runId: WorkflowRunId): LiveRun {
    const found = records.find((candidate) => candidate.id === runId)
    if (found === undefined) throw new Error(`No run is named "${runId}".`)
    return found
  }

  // One scripted run, however it was asked for: an agent's crucible_run, or a
  // schedule firing with no session and nothing handed in.
  function beginRun({
    workingDir,
    workflow,
    inputs,
    sessionId,
    scheduled
  }: {
    readonly workingDir: string
    readonly workflow: string
    readonly inputs: Readonly<Record<string, string>>
    readonly sessionId?: SessionId
    readonly scheduled?: true
  }): LiveRun {
    minted += 1
    const id = `fk${minted}${Math.floor(Math.random() * 90 + 10)}`
    const dir = artifactDir(id)
    const nodes: LiveNode[] = scriptOf(workflow).map((script) => ({
      id: script.id,
      status: 'pending',
      parents: [...script.parents],
      model: script.model,
      reads: [],
      artifacts: script.planned
        ? script.outputs.map((output) => ({
            name: output.name,
            path: `${dir}/${output.file}`,
            desc: output.desc
          }))
        : []
    }))
    const run: LiveRun = {
      id,
      workflow,
      status: 'running',
      workspacePath: workingDir,
      workspaceName: lastSegment(workingDir),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(scheduled === undefined ? {} : { scheduled }),
      worktreePath: `${workingDir}/.crucible/worktrees/run-${id}`,
      branch: `crucible/run-${id}`,
      baseCommit: '6c90bb0fake',
      inputs: { ...inputs },
      inputDescs: describeInputs(workflow, inputs),
      nodes,
      createdAt: nowIso(),
      startedAt: nowIso(),
      dir: runDir(id)
    }
    records.unshift(run)
    changed()
    startNode(run, 0, 0.61)
    return run
  }

  /** One beat later — unless the run is paused, in which case wait it out. */
  function beat(run: LiveRun, then: () => void): void {
    const tick = (): void => {
      if (run.status === 'cancelled') return
      if (paused.has(run.id)) {
        timers.set(run.id, setTimeout(tick, Math.max(beatMs, 10)))
        return
      }
      then()
    }
    timers.set(run.id, setTimeout(tick, beatMs))
  }

  function startNode(run: LiveRun, index: number, cost: number): void {
    const node = run.nodes[index]
    if (node === undefined) {
      finish(run)
      return
    }
    const script = scriptOf(run.workflow).find((candidate) => candidate.id === node.id)
    const dir = artifactDir(run.id)
    node.status = 'running'
    node.startedAt = nowIso()
    node.lastActivityAt = nowIso()
    node.now = 'running bash…'
    node.toolCalls = 0
    // What the node takes and what it will make, both known the moment it
    // starts: the rail fills its slots from here.
    node.reads = (script?.readsInputs ?? [])
      .map((name) => run.inputs[name])
      .filter((path): path is string => path !== undefined)
      .map((path) => ({ name: artifactName(path), path, desc: 'input' }))
      .concat(
        (script?.readsFiles ?? []).map((file) => ({
          name: file,
          path: `${dir}/${file}`,
          desc: 'input'
        }))
      )
    node.artifacts = (script?.outputs ?? []).map((output) => ({
      name: output.name,
      path: `${dir}/${output.file}`,
      desc: output.desc
    }))
    changed()
    beat(run, () => {
      node.toolCalls = 7
      node.contextPercent = 14 + index * 8
      node.cost = cost
      node.lastActivityAt = nowIso()
      node.now = 'writing response…'
      changed()
      beat(run, () => {
        node.status = 'complete'
        node.endedAt = nowIso()
        delete node.now
        node.summary = `Scripted completion of ${node.id}; nothing was sent anywhere.`
        // The declared files land at the beat the node completes, and the
        // record stamps them written, exactly as the engine does.
        node.artifacts = node.artifacts.map((artifact, at) => {
          const body = script?.outputs[at]?.body ?? ''
          files?.write(artifact.path, body)
          return { ...artifact, writtenAt: nowIso() }
        })
        if (script?.verdict !== undefined) node.verdict = script.verdict
        changed()

        // The build script parks once after its builder node: the question
        // routes to the orchestrator, exactly as the engine would.
        if (run.workflow === 'build' && node.id === 'builder') {
          run.question = { reason: FAKE_QUESTION, nodeId: node.id, raisedAt: nowIso() }
          run.waiting = true
          const next = run.nodes[index + 1]
          if (next !== undefined) next.status = 'blocked'
          changed()
          tell(
            run,
            `${runMessageHeader(run)} is checking in:\n\n${FAKE_QUESTION}\n\n` +
              `Answer with the crucible_answer tool (runId "${run.id}").`
          )
          waiting.set(run.id, (answer) => {
            waiting.delete(run.id)
            run.waiting = false
            if (run.question !== undefined) {
              run.question.answeredAt = nowIso()
              run.question.answer = answer
            }
            if (next !== undefined) next.status = 'pending'
            changed()
            startNode(run, index + 1, cost + 0.31)
          })
          return
        }

        startNode(run, index + 1, cost + 0.31)
      })
    })
  }

  // The canned parked run's own resume path. It has no script behind it — it
  // was born mid-run — so its blocked node is completed here, and the script
  // takes over from the node after it.
  function resumeCannedParked(run: LiveRun, answer: string): void {
    run.waiting = false
    if (run.question !== undefined) {
      run.question.answeredAt = nowIso()
      run.question.answer = answer
    }
    const blocked = run.nodes.find((node) => node.status === 'blocked')
    if (blocked !== undefined) {
      blocked.status = 'complete'
      blocked.endedAt = nowIso()
      blocked.summary = 'Unblocked by the answer; finished what it was holding.'
      delete blocked.now
      blocked.artifacts = blocked.artifacts.map((artifact) => {
        files?.write(artifact.path, CANNED_BODIES[artifactName(artifact.path)] ?? CANNED_BODY)
        return { ...artifact, writtenAt: nowIso() }
      })
    }
    changed()
    const next = run.nodes.findIndex((node) => node.status === 'pending')
    beat(run, () => {
      if (next < 0) finish(run)
      // The cost the resumed node bills, in the same scale the script uses.
      else startNode(run, next, 0.42)
    })
  }

  // The interrupted run's own resume walk: the reverted node runs again on the
  // beat, writing what it declared, and the rest of the graph follows until
  // the run completes and says so — the whole resume arc, watchable and free.
  function walkResumed(run: LiveRun): void {
    const next = run.nodes.findIndex((node) => node.status === 'pending')
    if (next < 0) {
      finish(run)
      return
    }
    const node = run.nodes[next]
    node.status = 'running'
    node.startedAt = nowIso()
    node.lastActivityAt = nowIso()
    node.now = 'reading the worktree it left behind…'
    changed()
    beat(run, () => {
      node.status = 'complete'
      node.endedAt = nowIso()
      node.lastActivityAt = nowIso()
      delete node.now
      node.toolCalls = (node.toolCalls ?? 0) + 6
      // Added to what this node already burned, never replacing it: the money
      // the first attempt spent was really spent.
      node.cost = Number(((node.cost ?? 0) + 0.28).toFixed(2))
      node.summary = `Re-ran ${node.id} from its beginning after the app quit; nothing was sent anywhere.`
      node.artifacts = node.artifacts.map((artifact) => {
        files?.write(artifact.path, CANNED_BODIES[artifactName(artifact.path)] ?? CANNED_BODY)
        return { ...artifact, writtenAt: nowIso() }
      })
      changed()
      walkResumed(run)
    })
  }

  // Total over the two stopped states, refusing every other one with the live
  // service's own sentence.
  function resumeRun(runId: WorkflowRunId): void {
    const run = requireRun(runId)
    if (run.status === 'paused') {
      paused.delete(runId)
      run.status = 'running'
      changed()
      return
    }
    if (run.status !== 'interrupted') throw new Error(resumeRefusal(runId, run.status))
    // The record goes back to working and every cut node back to the ghost the
    // plan drew, keeping what it spent — the engine's own reversion.
    run.status = 'running'
    delete run.error
    delete run.endedAt
    delete run.dismissedAt
    for (const node of run.nodes) {
      if (node.status !== 'interrupted') continue
      node.status = 'pending'
      node.artifacts = node.artifacts.map(({ name, path, desc }) => ({ name, path, desc }))
      delete node.error
      delete node.summary
      delete node.startedAt
      delete node.endedAt
      delete node.lastActivityAt
      delete node.now
    }
    changed()
    walkResumed(run)
  }

  function finish(run: LiveRun): void {
    run.status = 'complete'
    run.endedAt = nowIso()
    run.finalCommit = 'f4kec0mm17'
    run.outputs = { summary: 'the scripted run finished; nothing was sent anywhere' }
    changed()
    tell(
      run,
      `${runMessageHeader(run)} completed · branch ${run.branch} · ` +
        `worktree ${run.worktreePath}.\n\nIts work is committed on that branch — pull it in ` +
        'when you judge the moment right. Tell the user what came back.'
    )
  }

  // A file is reachable through here because the named run's record names it,
  // and for no other reason.
  function fileOf(runId: WorkflowRunId, path: string): { readonly path: string } | undefined {
    const run = records.find((candidate) => candidate.id === runId)
    if (run === undefined || !recordNamesPath(run as RunRecord, path)) return undefined
    return { path }
  }

  function gate(runId: WorkflowRunId, path: string): void {
    if (fileOf(runId, path) === undefined) {
      throw new Error('That file is not one this run touched.')
    }
  }

  /** Stops a live scripted run where it stands. */
  function cancelRun(runId: WorkflowRunId): void {
    const run = requireRun(runId)
    if (run.status !== 'running' && run.status !== 'paused') return
    run.status = 'cancelled'
    run.endedAt = nowIso()
    paused.delete(runId)
    waiting.delete(runId)
    const timer = timers.get(runId)
    if (timer !== undefined) clearTimeout(timer)
    for (const node of run.nodes) {
      if (node.status === 'running' || node.status === 'blocked') {
        node.status = 'failed'
        node.endedAt = nowIso()
        delete node.now
      }
    }
    changed()
  }

  const tools: RunTools = {
    async workflows(): Promise<string> {
      return [
        '- adhoc (workspace) — one node running a prompt file, in a worktree',
        '  inputs: prompt: A file containing the node\'s task, used verbatim.',
        '- build (workspace) — take an intent document to built code: a Spec, a builder, and a review loop',
        '  inputs: intent: The intent document for the work.'
      ].join('\n')
    },

    async start(
      sessionId: SessionId,
      workingDir: string,
      workflow: string,
      inputs: Readonly<Record<string, string>>
    ): Promise<string> {
      const run = beginRun({ workingDir, workflow, inputs, sessionId })
      return (
        `Run ${run.id} of "${workflow}" started · branch ${run.branch} · worktree ` +
        `${run.worktreePath} · base 6c90bb0.\nIt works unattended and reports back to this ` +
        'session. Ending your turn now is the normal thing to do. (Scripted: no cost.)'
      )
    },

    async list(sessionId: SessionId): Promise<string> {
      const mine = records.filter((run) => run.sessionId === sessionId)
      if (mine.length === 0) return 'This session has no workflow runs.'
      // The live service's own line, so what an agent reads of a run is the
      // same sentence in both flavors.
      return mine.map((run) => describeRun(run as RunRecord)).join('\n')
    },

    async answer(_sessionId: SessionId, runId: string, message: string): Promise<string> {
      const resume = waiting.get(runId)
      if (resume === undefined) throw new Error(`The run "${runId}" is not waiting on an answer.`)
      resume(message)
      return `Answer delivered to run ${runId}; it resumes from here.`
    },

    async resume(_sessionId: SessionId, runId: string): Promise<string> {
      // Named before the act: resuming reverts the cut nodes to ghosts.
      const cut = interruptedNodes(requireRun(runId) as RunRecord).map((node) => node.id)
      resumeRun(runId)
      return resumeAnswer(requireRun(runId) as RunRecord, cut)
    }
  }

  return {
    async snapshot(): Promise<RunsSnapshot> {
      return snapshotNow()
    },

    onEvent(listener: WorkflowRunListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async pause(runId: WorkflowRunId): Promise<void> {
      const run = requireRun(runId)
      if (run.status !== 'running') return
      paused.add(runId)
      run.status = 'paused'
      changed()
    },

    async resume(runId: WorkflowRunId): Promise<void> {
      resumeRun(runId)
    },

    async dismiss(runId: WorkflowRunId): Promise<void> {
      const run = requireRun(runId)
      if (run.status === 'running' || run.status === 'paused') {
        // With an orchestrator listening, a live run is stopped from the run
        // view rather than cleared. With none, dismissing is the whole act:
        // the run stops and is cleared in one go.
        if (run.sessionId !== undefined) throw new Error(dismissRefusal(runId))
        if (run.dismissedAt === undefined) run.dismissedAt = nowIso()
        cancelRun(runId)
        return
      }
      if (run.dismissedAt !== undefined) return
      run.dismissedAt = nowIso()
      changed()
    },

    async adopt(runId: WorkflowRunId, sessionId: SessionId): Promise<void> {
      const run = requireRun(runId)
      if (run.sessionId === sessionId) return
      // Every later message follows the record, so the new session gets the
      // check-ins, the completion and the run in its crucible_runs list.
      run.sessionId = sessionId
      changed()
    },

    async cancel(runId: WorkflowRunId): Promise<void> {
      cancelRun(runId)
    },

    async nodeTranscript(): Promise<readonly TranscriptItem[]> {
      return CANNED_NODE_TRANSCRIPT
    },

    async artifact(runId: WorkflowRunId, path: string): Promise<ArtifactView> {
      gate(runId, path)
      const body = files?.read(path)
      if (body === undefined) {
        throw new Error(`That artifact could not be read: ${artifactName(path)}.`)
      }
      const kind = artifactKind(path)
      const bytes = files?.size(path) ?? body.length
      return kind === 'html' ? { kind, bytes } : { kind, body, bytes }
    },

    async revealArtifact(runId: WorkflowRunId, path: string): Promise<void> {
      gate(runId, path)
      if (reveal === undefined) throw new Error('This launch cannot open a file manager.')
      reveal(path)
    },

    tools,

    turnStart,

    async startScheduled(fire: ScheduledFireRequest): Promise<RunRecord> {
      return beginRun({
        workingDir: fire.workspacePath,
        workflow: fire.workflow,
        inputs: {},
        scheduled: true
      }) as RunRecord
    },

    toggleOverview(): void {
      for (const listener of [...listeners]) listener({ type: 'toggle-overview' })
    },

    dispose(): void {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      listeners.clear()
    }
  }
}

function describeInputs(
  workflow: string,
  inputs: Readonly<Record<string, string>>
): Record<string, string> {
  const known: Record<string, string> = {
    intent: 'The intent document for the work.',
    prompt: "A file containing the node's task, used verbatim."
  }
  return Object.fromEntries(
    Object.keys(inputs).map((name) => [name, known[name] ?? `An input of the "${workflow}" run.`])
  )
}

function lastSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString()
}

/** A run that finished hours ago: the Done band, with nothing left to ask. */
function cannedFinished(
  workspace: CannedWorkspace,
  artifactDir: (runId: WorkflowRunId) => string,
  runDir: (runId: WorkflowRunId) => string
): LiveRun {
  const dir = artifactDir('d3p8')
  const intent = `${workspace.path}/docs/intent/og-images.md`
  const read = (path: string): RunArtifact => ({ name: artifactName(path), path, desc: 'input' })
  const spec = `${dir}/spec.md`
  const changes = `${dir}/changes.md`
  const review = `${dir}/review.md`
  const report = `${dir}/report.html`
  return {
    id: 'd3p8',
    workflow: 'build',
    status: 'complete',
    workspacePath: workspace.path,
    workspaceName: workspace.name,
    // Fired by the workspace's `build` schedule, so the fake flavor's board
    // has a clean run to read a report from.
    scheduled: true,
    worktreePath: `${workspace.path}/.crucible/worktrees/run-d3p8`,
    branch: 'crucible/run-d3p8',
    baseCommit: 'a11ce0fake',
    finalCommit: 'b0bfake',
    inputs: { intent },
    inputDescs: { intent: 'The intent document for the work.' },
    nodes: [
      {
        id: 'planner',
        status: 'complete',
        parents: [],
        model: 'anthropic/claude-fable-5:high',
        reads: [read(intent)],
        artifacts: [
          {
            name: 'spec',
            path: spec,
            desc: 'the Spec: what to build, derived from the intent document',
            writtenAt: hoursAgo(3.8)
          }
        ],
        summary: 'Wrote the spec.',
        cost: 0.61,
        toolCalls: 12,
        startedAt: hoursAgo(4),
        endedAt: hoursAgo(3.8)
      },
      {
        id: 'builder',
        status: 'complete',
        parents: ['planner'],
        model: 'anthropic/claude-opus-5:high',
        reads: [read(intent), read(spec)],
        artifacts: [
          {
            name: 'changes',
            path: changes,
            desc: 'every file the builder touched, with reasons',
            writtenAt: hoursAgo(2.4)
          }
        ],
        summary: 'Built the pipeline.',
        cost: 4.87,
        toolCalls: 41,
        startedAt: hoursAgo(3.8),
        endedAt: hoursAgo(2.4)
      },
      {
        id: 'review-1',
        status: 'complete',
        parents: ['builder'],
        model: 'anthropic/claude-fable-5:high',
        reads: [read(spec), read(changes)],
        artifacts: [
          {
            name: 'review',
            path: review,
            desc: "the reviewer's verdict and its evidence",
            writtenAt: hoursAgo(2.1)
          }
        ],
        summary: 'Approved.',
        verdict: { verdict: 'approved', reason: 'matches the spec' },
        cost: 0.42,
        toolCalls: 9,
        startedAt: hoursAgo(2.4),
        endedAt: hoursAgo(2.1)
      },
      {
        id: 'report',
        status: 'complete',
        parents: ['review-1'],
        model: 'anthropic/claude-fable-5:high',
        reads: [read(review)],
        artifacts: [
          {
            name: 'report',
            path: report,
            desc: "the run's summary for the human",
            writtenAt: hoursAgo(2)
          }
        ],
        summary: 'Wrote the report.',
        cost: 0.18,
        toolCalls: 4,
        startedAt: hoursAgo(2.1),
        endedAt: hoursAgo(2)
      }
    ],
    outputs: { verdict: 'approved' },
    createdAt: hoursAgo(4),
    startedAt: hoursAgo(4),
    endedAt: hoursAgo(2),
    dir: runDir('d3p8')
  }
}

// A failed build whose orchestrator session has been removed from the
// sidebar, so the row has no Go to session and nothing that can end it.
// Dismiss clears it into Done; Investigate adopts it and asks what happened.
function cannedFailed(
  workspace: CannedWorkspace,
  artifactDir: (runId: WorkflowRunId) => string,
  runDir: (runId: WorkflowRunId) => string
): LiveRun {
  const dir = artifactDir('b1n7')
  const intent = `${workspace.path}/docs/intent/og-images.md`
  const spec = `${dir}/spec.md`
  return {
    id: 'b1n7',
    workflow: 'build',
    status: 'failed',
    workspacePath: workspace.path,
    workspaceName: workspace.name,
    scheduled: true,
    // A session that is not in the sidebar and never will be again. Adopted
    // and then failed, which is why the board files it under Recent runs.
    sessionId: 'fake-removed-session',
    worktreePath: `${workspace.path}/.crucible/worktrees/run-b1n7`,
    branch: 'crucible/run-b1n7',
    baseCommit: 'd00d1efake',
    inputs: { intent },
    inputDescs: { intent: 'The intent document for the work.' },
    nodes: [
      {
        id: 'planner',
        status: 'complete',
        parents: [],
        model: 'anthropic/claude-fable-5:high',
        reads: [{ name: artifactName(intent), path: intent, desc: 'input' }],
        artifacts: [
          {
            name: 'spec',
            path: spec,
            desc: 'the Spec: what to build, derived from the intent document',
            writtenAt: hoursAgo(5.4)
          }
        ],
        summary: 'Wrote the spec.',
        cost: 0.58,
        toolCalls: 11,
        startedAt: hoursAgo(5.6),
        endedAt: hoursAgo(5.4)
      },
      {
        id: 'builder',
        status: 'failed',
        parents: ['planner'],
        model: 'anthropic/claude-opus-5:high',
        reads: [
          { name: artifactName(intent), path: intent, desc: 'input' },
          { name: 'spec.md', path: spec, desc: 'input' }
        ],
        artifacts: [
          {
            name: 'changes',
            path: `${dir}/changes.md`,
            desc: 'every file the builder touched, with reasons'
          }
        ],
        error:
          'output validation failed 3x: required output "changes" is missing or empty',
        cost: 1.3,
        toolCalls: 34,
        startedAt: hoursAgo(5.4),
        endedAt: hoursAgo(5),
        lastActivityAt: hoursAgo(5)
      }
    ],
    error: 'node "builder" failed validation: required output "changes" is missing or empty',
    createdAt: hoursAgo(5.6),
    startedAt: hoursAgo(5.6),
    endedAt: hoursAgo(5),
    dir: runDir('b1n7')
  }
}

// A build the app quit out from under, shaped like the approved mock's row:
// four nodes done, the gate cut down mid-flight, an orchestrator that is owed
// the news, and $3.62 already spent. Resume re-runs the cut node alone.
function cannedInterrupted(
  workspace: CannedWorkspace,
  artifactDir: (runId: WorkflowRunId) => string,
  runDir: (runId: WorkflowRunId) => string
): LiveRun {
  const dir = artifactDir(CANNED_INTERRUPTED_ID)
  const intent = `${workspace.path}/docs/intent/archexplorer-diff-mode.md`
  const read = (path: string): RunArtifact => ({ name: artifactName(path), path, desc: 'input' })
  const spec = `${dir}/spec.md`
  const changes = `${dir}/changes.md`
  const tests = `${dir}/review-tests.md`
  return {
    id: CANNED_INTERRUPTED_ID,
    workflow: 'build',
    status: 'interrupted',
    workspacePath: workspace.path,
    workspaceName: workspace.name,
    sessionId: CANNED_INTERRUPTED_SESSION,
    worktreePath: `${workspace.path}/.crucible/worktrees/run-${CANNED_INTERRUPTED_ID}`,
    branch: `crucible/run-${CANNED_INTERRUPTED_ID}`,
    baseCommit: 'ab3d19fake',
    inputs: { intent },
    inputDescs: { intent: 'The intent document for the work.' },
    nodes: [
      {
        id: 'requirements',
        status: 'complete',
        parents: [],
        model: 'anthropic/claude-fable-5:high',
        reads: [read(intent)],
        artifacts: [
          {
            name: 'spec',
            path: spec,
            desc: 'the Spec: what to build, derived from the intent document',
            writtenAt: hoursAgo(2.7)
          }
        ],
        summary: 'Wrote the spec.',
        cost: 0.42,
        toolCalls: 9,
        startedAt: hoursAgo(3),
        endedAt: hoursAgo(2.7)
      },
      {
        id: 'architect',
        status: 'complete',
        parents: ['requirements'],
        model: 'anthropic/claude-opus-5:high',
        reads: [read(spec)],
        artifacts: [],
        summary: 'Settled the module boundaries.',
        cost: 0.68,
        toolCalls: 14,
        startedAt: hoursAgo(2.7),
        endedAt: hoursAgo(2.2)
      },
      {
        id: 'builder',
        status: 'complete',
        parents: ['architect'],
        model: 'anthropic/claude-opus-5:high',
        reads: [read(intent), read(spec)],
        artifacts: [
          {
            name: 'changes',
            path: changes,
            desc: 'every file the builder touched, with reasons',
            writtenAt: hoursAgo(1.3)
          }
        ],
        summary: 'Built the diff mode.',
        cost: 1.74,
        toolCalls: 38,
        startedAt: hoursAgo(2.2),
        endedAt: hoursAgo(1.3)
      },
      {
        id: 't2-review',
        status: 'complete',
        parents: ['builder'],
        model: 'anthropic/claude-fable-5:high',
        reads: [read(changes)],
        artifacts: [
          {
            name: 'review',
            path: tests,
            desc: 'the branch judged at its test seams',
            writtenAt: hoursAgo(0.9)
          }
        ],
        summary: 'Approved at the seams.',
        verdict: { verdict: 'approved', reason: 'every seam the spec named has a test at it' },
        cost: 0.39,
        toolCalls: 11,
        startedAt: hoursAgo(1.3),
        endedAt: hoursAgo(0.9)
      },
      // The node the quit cut down: what it declared is still unwritten, and
      // its error is the one sentence the sweep writes.
      {
        id: 'gate-alignment',
        status: 'interrupted',
        parents: ['t2-review'],
        model: 'anthropic/claude-opus-5:high',
        reads: [read(intent), read(changes), read(tests)],
        artifacts: [
          {
            name: 'review',
            path: `${dir}/review.md`,
            desc: "the gate's verdict and its evidence"
          }
        ],
        error: INTERRUPTED_MESSAGE,
        cost: 0.39,
        toolCalls: 7,
        startedAt: hoursAgo(0.9),
        lastActivityAt: hoursAgo(0.67),
        endedAt: hoursAgo(0.67)
      }
    ],
    error: INTERRUPTED_MESSAGE,
    // Owed to its orchestrator, and still owed: nothing has woken that session
    // since the quit.
    noticePending: true,
    createdAt: hoursAgo(3),
    startedAt: hoursAgo(3),
    endedAt: hoursAgo(0.67),
    dir: runDir(CANNED_INTERRUPTED_ID)
  }
}

/** A session-less parked run: the unattended kind, parked with no one to ask
 *  until a session investigates it and adopts it. */
function cannedUnattended(
  workspace: CannedWorkspace,
  artifactDir: (runId: WorkflowRunId) => string,
  runDir: (runId: WorkflowRunId) => string
): LiveRun {
  const dir = artifactDir(CANNED_UNATTENDED_ID)
  const intent = `${workspace.path}/docs/intent/quota-flicker.md`
  const spec = `${dir}/spec.md`
  return {
    id: CANNED_UNATTENDED_ID,
    workflow: 'build',
    status: 'running',
    workspacePath: workspace.path,
    workspaceName: workspace.name,
    // Parked: fired by a schedule, waiting with no orchestrator to hear it.
    scheduled: true,
    worktreePath: `${workspace.path}/.crucible/worktrees/run-g8x2`,
    branch: 'crucible/run-g8x2',
    baseCommit: 'c4rl0fake',
    inputs: { intent },
    inputDescs: { intent: 'The intent document for the work.' },
    question: {
      reason: 'check-in: no one to ask — the run has no orchestrator session',
      nodeId: 'builder',
      raisedAt: hoursAgo(0.7)
    },
    waiting: true,
    nodes: [
      {
        id: 'planner',
        status: 'complete',
        parents: [],
        model: 'anthropic/claude-fable-5:high',
        reads: [{ name: artifactName(intent), path: intent, desc: 'input' }],
        artifacts: [
          {
            name: 'spec',
            path: spec,
            desc: 'the Spec: what to build, derived from the intent document',
            writtenAt: hoursAgo(1)
          }
        ],
        summary: 'Wrote the spec.',
        cost: 0.55,
        toolCalls: 10,
        startedAt: hoursAgo(1.2),
        endedAt: hoursAgo(1)
      },
      {
        id: 'builder',
        status: 'blocked',
        parents: ['planner'],
        model: 'anthropic/claude-opus-5:high',
        reads: [
          { name: artifactName(intent), path: intent, desc: 'input' },
          { name: 'spec.md', path: spec, desc: 'input' }
        ],
        // Declared and not written: what an expected artifact looks like while
        // the node that owes it is parked.
        artifacts: [
          {
            name: 'changes',
            path: `${dir}/changes.md`,
            desc: 'every file the builder touched, with reasons'
          }
        ],
        cost: 1.5,
        toolCalls: 22,
        startedAt: hoursAgo(1),
        lastActivityAt: hoursAgo(0.7)
      },
      // Waiting its turn, so answering the check-in has somewhere to walk to.
      {
        id: 'review-1',
        status: 'pending',
        parents: ['builder'],
        model: 'anthropic/claude-fable-5:high',
        reads: [],
        artifacts: []
      },
      // A node that failed and did not take the run with it: the failed card,
      // its reason, and the walked edge into it, without staging anything.
      {
        id: 'spec-audit',
        status: 'failed',
        parents: ['planner'],
        model: 'anthropic/claude-fable-5:high',
        reads: [{ name: 'spec.md', path: spec, desc: 'input' }],
        artifacts: [],
        error: 'the audit ran out of context re-reading the spec, twice',
        cost: 0.34,
        toolCalls: 7,
        startedAt: hoursAgo(1),
        endedAt: hoursAgo(0.9)
      }
    ],
    createdAt: hoursAgo(1.2),
    startedAt: hoursAgo(1.2),
    dir: runDir(CANNED_UNATTENDED_ID)
  }
}

/** What a node dig shows in the fake flavor: the chat pane's own shapes. */
const CANNED_NODE_TRANSCRIPT: readonly TranscriptItem[] = [
  {
    kind: 'thinking',
    text: 'The spec pins the handoff to the agent port; checking the channel tests cover the reconnect path before anything else.',
    seconds: 4
  },
  { kind: 'tool', name: 'bash', summary: 'npm test', ok: true, output: 'Tests 42 passed (42)\n' },
  {
    kind: 'tool',
    name: 'read',
    summary: 'src/shared/agent/port.ts',
    ok: true,
    output: '// This module imports nothing on purpose\n'
  },
  {
    kind: 'assistant',
    markdown:
      'Reconnect is covered. The preload surface matches the spec\u2019s boundary list; writing the review now.'
  }
]
