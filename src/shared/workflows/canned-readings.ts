import type { WorkflowReadRequest, WorkflowSourceFile } from './catalog'
import { constantString, declarationRange } from './source-scan'

// The fake flavor's reader: no model, no network, no cost. Its prose is
// canned, written for the workflows this repository ships, and its citations
// are found in the file as it stands, by the name each one is bound to, so an
// edit that moves a prompt moves the quote with it and the reply still has to
// pass the same check a model's does. A file it has no prose for gets a plain
// reading assembled from its node calls.

interface CannedAgent {
  readonly role: string
  readonly nodes: readonly string[]
  readonly does: string
  /** The constant the model string is written in; absent takes the engine default. */
  readonly model?: string
  readonly system?: string
  readonly prompt?: string
}

interface Canned {
  readonly summary: string
  readonly agents: readonly CannedAgent[]
  readonly steps: readonly string[]
  readonly stops: readonly string[]
  readonly returns: {
    readonly artifacts: readonly { readonly file: string; readonly what: string }[]
    readonly branch: string | null
    readonly report: string
  }
}

const CANNED: Readonly<Record<string, Canned>> = {
  adhoc: {
    summary:
      'Runs one agent on a task you write in a file, in a worktree of its own. The agent ' +
      'works unattended and leaves its changes on the run’s branch with a report of what it ' +
      'did and why.',
    agents: [
      {
        role: 'Worker',
        nodes: ['work'],
        does: 'Carries out the task in the prompt file, verbatim, and writes a report for the human.',
        system: 'NODE_SYSTEM',
        prompt: 'taskPrompt'
      }
    ],
    steps: [
      'Kickoff takes the prompt file you name and gives the run a worktree of its own.',
      'One agent reads the task from that file and does it in the worktree.',
      'It writes its report to report.html in the run’s own directory and completes.',
      'The engine commits whatever the worktree holds and reports back to the session that started it.'
    ],
    stops: [],
    returns: {
      artifacts: [{ file: 'report.html', what: 'what the agent did and why, for the human' }],
      branch: 'whatever the agent changed, committed by the engine when the run ends',
      report: 'the agent’s completion summary and where its report is'
    }
  },

  build: {
    summary:
      'Takes an intent document to built code. A builder implements it, the repository’s own ' +
      'checks run between every change, and a reviewer judges the branch round after round until ' +
      'it approves. The run ends with a branch ready for the human to pull in; it never merges or pushes.',
    agents: [
      {
        role: 'Builder',
        nodes: ['builder'],
        does: 'Implements everything the intent document rules, with tests at the repository’s seams.',
        model: 'CODE_MODEL',
        system: 'NODE_SYSTEM',
        prompt: 'builderPrompt'
      },
      {
        role: 'Check fixer',
        nodes: ['<after>-check-fixer-<attempt>'],
        does: 'Makes typecheck, lint and the tests pass again from their failing output alone.',
        model: 'CODE_MODEL',
        system: 'NODE_SYSTEM',
        prompt: 'checkFixerPrompt'
      },
      {
        role: 'Reviewer',
        nodes: ['review-<round>'],
        does: 'Judges the branch against the intent document and either approves it or writes findings.',
        model: 'REVIEW_MODEL',
        system: 'NODE_SYSTEM',
        prompt: 'reviewerPrompt'
      },
      {
        role: 'Fixer',
        nodes: ['fixer-<round>'],
        does: 'Resolves what the latest review found, with the earlier reviews for context.',
        model: 'CODE_MODEL',
        system: 'NODE_SYSTEM',
        prompt: 'fixerPrompt'
      }
    ],
    steps: [
      'The builder implements the intent document in the run’s worktree, and its work is committed.',
      'Typecheck, lint and the tests run with no model. While any is red, a check fixer is handed the failing output, and the checks run again.',
      'A reviewer judges the branch against the intent document, writes review-<round>.md and gives a verdict: approved or changes-required.',
      'On changes-required a fixer works from the reviews, the checks run again, and a fresh reviewer takes the next round.',
      'On approved the checks run one last time, and the run ends with the verdict, the branch and whether it merges cleanly.'
    ],
    stops: [
      'After every third review in a row that comes back changes-required, it asks the session that started it whether the loop is on task. The answer becomes a standing correction every later reviewer and fixer is given.'
    ],
    returns: {
      artifacts: [
        { file: 'review-<round>.md', what: 'each review of the branch against the intent document' }
      ],
      branch: 'the built work, committed after every agent, ready for the human to pull in',
      report:
        'the final verdict and its reason, how many rounds it took, the branch, and whether it merges cleanly into the local default branch'
    }
  },

  'adr-audit': {
    summary:
      'Audits docs/adr/ so it records only what is currently decided: deletes dead ADRs, folds ' +
      'overlapping ones, strengthens or flags the rest, then strips numbered ADR citations from ' +
      'everything outside the folder. It leaves a branch and a report.',
    agents: [
      {
        role: 'Auditor',
        nodes: ['audit'],
        does: 'Judges every ADR alone and against the others, and deletes, folds, strengthens or flags each one.',
        model: 'DOCUMENT_MODEL',
        system: 'NODE_SYSTEM',
        prompt: 'auditPrompt'
      },
      {
        role: 'Citation sweeper',
        nodes: ['sweep'],
        does: 'Removes every reference to one specific ADR from the worktree outside docs/adr/.',
        model: 'DOCUMENT_MODEL',
        system: 'NODE_SYSTEM',
        prompt: 'sweepPrompt'
      },
      {
        role: 'Reporter',
        nodes: ['report'],
        does: 'Writes the one document the human reads to judge the run.',
        model: 'DOCUMENT_MODEL',
        system: 'NODE_SYSTEM',
        prompt: 'reportPrompt'
      }
    ],
    steps: [
      'The auditor judges every ADR in docs/adr/, acts on each, and writes its findings; the branch is committed.',
      'The sweeper strips numbered ADR citations from everything outside the folder and lists each site; the branch is committed again.',
      'The reporter turns both findings files into one HTML report.',
      'The run ends with the four disposition counts and how many citations were removed.'
    ],
    stops: [],
    returns: {
      artifacts: [
        { file: 'audit-findings.md', what: 'every ADR, its disposition and the reasoning behind it' },
        { file: 'sweep-findings.md', what: 'every citation site the sweep edited' },
        { file: 'report.html', what: 'the run judged in one document' }
      ],
      branch: 'the audited decision record and the stripped citations, committed after each phase',
      report: 'where the report is, the kept, edited, flagged and deleted counts, and the citations removed'
    }
  },

  'main-thread-audit': {
    summary:
      'Audits the main process for anything that can hold its event loop, fixes what is safe to ' +
      'fix in place, and reports the rest, including what only moving work into another process ' +
      'would cure.',
    agents: [
      {
        role: 'Auditor',
        nodes: ['audit-<area>'],
        does: 'Reads and measures one slice of the main process and ranks what can hold its thread.',
        system: 'NODE_SYSTEM',
        prompt: 'auditPrompt'
      },
      {
        role: 'Fixer',
        nodes: ['fix'],
        does: 'Applies every fix from the four findings that is safe in place and accounts for the rest.',
        system: 'NODE_SYSTEM',
        prompt: 'fixPrompt'
      },
      {
        role: 'Reporter',
        nodes: ['report'],
        does: 'Writes the HTML page the human reads to decide on the structural change.',
        system: 'NODE_SYSTEM',
        prompt: 'reportPrompt'
      }
    ],
    steps: [
      'Four auditors work in parallel, one per slice: the SDK host, the engine, the workspace services and stores, and the IPC seam with the renderer.',
      'One fixer reads all four findings, applies the safe fixes and writes fixes.md.',
      'The branch is committed and lint, typecheck and the tests run; a failure goes back to the same fixer, up to three rounds, and then the run fails.',
      'A reporter writes report.html from the findings and the fixes, and the branch is committed.'
    ],
    stops: [],
    returns: {
      artifacts: [
        { file: 'findings-<area>.md', what: 'each slice’s findings, ranked, with evidence' },
        { file: 'fixes.md', what: 'every finding accounted for: fixed, left, or not a finding' },
        { file: 'report.html', what: 'what held the thread, what was fixed and what needs a new process' }
      ],
      branch: 'the fixes, committed round by round, and the report commit',
      report: 'the reporter’s summary and where the report, the fixes and each findings file are'
    }
  }
}

/** The reply the fake reader gives, as text: the same JSON a model is asked for. */
export function cannedReply(request: WorkflowReadRequest): string {
  const file = request.files[0]
  if (file === undefined) return '{}'
  const canned = CANNED[request.name] ?? assembled(request, file)
  return JSON.stringify({
    summary: canned.summary,
    agents: canned.agents.map((agent) => ({
      role: agent.role,
      nodes: agent.nodes,
      does: agent.does,
      model: modelCitation(file, agent.model),
      system: promptCitation(file, agent.system),
      prompt: promptCitation(file, agent.prompt)
    })),
    steps: canned.steps,
    stops: canned.stops,
    returns: canned.returns
  })
}

function modelCitation(
  file: WorkflowSourceFile,
  constant: string | undefined
): { value: string; file: string; line: number } | null {
  if (constant === undefined) return null
  const found = constantString(file.text, constant)
  // Cited where it should be even when it is not, so the check names what moved.
  return found === undefined
    ? { value: constant, file: file.label, line: 1 }
    : { value: found.value, file: file.label, line: found.line }
}

function promptCitation(
  file: WorkflowSourceFile,
  name: string | undefined
): { name: string; file: string; start: number; end: number } | null {
  if (name === undefined) return null
  const range = declarationRange(file.text, name)
  return range === undefined
    ? { name, file: file.label, start: 1, end: 1 }
    : { name, file: file.label, start: range.start, end: range.end }
}

const NODE_CALL = /ctx\.(?:node|openNode)\(\s*(['"`])(.*?)\1/g

// One agent per node call, its prompts and model taken from the spec that
// follows the call where they are named constants.
function assembled(request: WorkflowReadRequest, file: WorkflowSourceFile): Canned {
  const agents: CannedAgent[] = []
  for (const call of file.text.matchAll(NODE_CALL)) {
    const id = call[2].replace(/\$\{\s*([^}]*?)\s*\}/g, (_whole, hole: string) => `<${hole}>`)
    const spec = file.text.slice(call.index, call.index + 800)
    const named = (key: string): string | undefined => {
      const value = new RegExp(`\\b${key}:\\s*([A-Za-z_$][\\w$]*)`).exec(spec)?.[1]
      if (value === undefined) return undefined
      return declarationRange(file.text, value) === undefined ? undefined : value
    }
    const model = new RegExp(`\\bmodel:\\s*([A-Za-z_$][\\w$]*)`).exec(spec)?.[1]
    agents.push({
      role: id,
      nodes: [id],
      does: `Runs as ${id}.`,
      ...(model === undefined || constantString(file.text, model) === undefined ? {} : { model }),
      ...optional('system', named('system')),
      ...optional('prompt', named('prompt'))
    })
  }
  return {
    summary: `${request.manifest.description}. (A canned reading: this launch reads no file with a model.)`,
    agents,
    steps: agents.length === 0 ? ['The run executes the file’s own code.'] : agents.map((agent) => `${agent.role} runs.`),
    stops: [],
    returns: { artifacts: [], branch: null, report: 'what its run() returns' }
  }
}

function optional<Key extends string>(key: Key, value: string | undefined): Partial<Record<Key, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<Key, string>)
}
