import { cannedBoard } from './fake-board'
import { cannedIssues } from './fake-issues'
import { rankFiles } from './match'
import {
  redactKeys,
  type ConnectOutcome,
  type ResearchOutcome,
  type ResearchStatus
} from './research'
import type {
  BranchBoardAnswer,
  IssueBoardAnswer,
  RunId,
  Unsubscribe,
  WorkspaceEvent,
  WorkspaceEventListener,
  WorkspaceService,
  WorktreeCreation
} from './service'

// No folder is read and no process is started, so an agent-driven check costs
// nothing. Imports neither Electron nor Node, exactly as the fake adapter does.

// Enough real-looking depth that the popover's filename-bright,
// directory-dim grammar is exercisable.
export const CANNED_FILES: readonly string[] = [
  'AGENTS.md',
  'CONTEXT.md',
  'docs/adr/0005-workspace-service-owns-os-facts.md',
  'docs/design/feature-inventory.md',
  'docs/design/mock-a-ember.html',
  'docs/design/mock-i-session-tree.html',
  'docs/design/mock-j-composer-suite.html',
  'package.json',
  'src/main/agent/sdk-adapter.ts',
  'src/main/workspace/service.ts',
  'src/renderer/src/Shell.tsx',
  'src/renderer/src/components/Composer.tsx',
  'src/renderer/src/components/SessionTree.tsx',
  'src/renderer/src/components/Transcript.tsx',
  'src/renderer/src/components/composer.css',
  'src/renderer/src/components/transcript.css',
  'src/shared/agent/fake-adapter.ts',
  'src/shared/agent/port.ts',
  'src/shared/workspace/service.ts'
]

// Hex-looking and fixed, so a flip to a worktree lands on a branch name an
// agent-driven check can read back. Cycled, so two flips differ.
export const CANNED_WORKTREE_IDS: readonly string[] = ['9f3a2c', '4b81de', 'c07a15']

/** Anything with this word in it fails, so a red exit badge is drivable. */
const FAILING = 'fail'

/** This one streams until it is stopped, so the Stop control is drivable. */
const ENDLESS = 'tail'

const SUCCESS_CHUNKS: readonly string[] = [
  'On branch crucible/ember-shell\n',
  'nothing to commit, working tree clean\n'
]

const FAILURE_CHUNKS: readonly string[] = [
  'npm ERR! missing script: dploy\n',
  'npm ERR! Did you mean deploy?\n'
]

const ENDLESS_CHUNKS: readonly string[] = [
  'watching for changes…\n',
  'still watching — press Stop\n'
]

// The research CLI, canned: a version and a credit figure that look like a
// machine that has one installed and connected, so the ordinary state of the
// Research section is there to drive with no CLI anywhere.
const CANNED_VERSION = '1.23.3'
const CANNED_CREDITS = 4_820

// What the canned browser login "prints" while it waits. The real one waits on
// a person too; here nothing can ever finish it, so Cancel and the pasted-key
// fallback are the two ways out, exactly as they are for the real one.
const CANNED_CONNECT_CHUNKS: readonly string[] = [
  '\nOpening browser for authorization…\n',
  "If the browser doesn't open, visit: https://example.invalid/cli-auth\n"
]

// Slow enough that Stop is reachable by hand, and zero in tests, which then
// drive the stream themselves.
const DEFAULT_PAUSE_MS = 220

export interface FakeWorkspaceService extends WorkspaceService {
  /** Every link the fake was asked to open, and opened nothing for. */
  readonly openedUrls: readonly string[]
}

export function createFakeWorkspaceService({
  pauseMs = DEFAULT_PAUSE_MS
}: {
  readonly pauseMs?: number
} = {}): FakeWorkspaceService {
  const openedUrls: string[] = []
  const listeners = new Set<WorkspaceEventListener>()
  const running = new Map<RunId, { stop(): void }>()
  let minted = 0

  function emit(event: WorkspaceEvent): void {
    for (const listener of [...listeners]) listener(event)
  }

  function stream(runId: RunId, chunks: readonly string[], exitCode: number | undefined): void {
    let index = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false

    function next(): void {
      if (stopped) return
      if (index < chunks.length) {
        emit({ type: 'run_output', runId, chunk: chunks[index] ?? '' })
        index += 1
        timer = setTimeout(next, pauseMs)
        return
      }
      // An endless run says nothing more and waits to be stopped, which is
      // the whole point of it.
      if (exitCode === undefined) {
        timer = undefined
        return
      }
      running.delete(runId)
      emit({ type: 'run_ended', runId, exitCode })
    }

    running.set(runId, {
      stop(): void {
        stopped = true
        if (timer !== undefined) clearTimeout(timer)
        running.delete(runId)
        // No exit code: the run was stopped rather than exiting.
        emit({ type: 'run_ended', runId })
      }
    })

    timer = setTimeout(next, pauseMs)
  }

  let worktrees = 0
  // The one piece of state the fake research calls move, so a driven check can
  // walk connected → logged out → connected again.
  let research: ResearchStatus = {
    kind: 'signedIn',
    version: redactKeys(CANNED_VERSION),
    credits: CANNED_CREDITS
  }
  let waiting: { settle(outcome: ConnectOutcome): void } | undefined

  function endConnect(): void {
    const ending = waiting
    waiting = undefined
    ending?.settle({ kind: 'abandoned' })
  }

  return {
    openedUrls,

    async searchFiles(_directory: string, query: string): Promise<readonly string[]> {
      return rankFiles(CANNED_FILES, query)
    },

    // Every canned workspace is a git one, so the chip is there to drive.
    async isGitWorkspace(): Promise<boolean> {
      return true
    },

    // No process and no folder: a pause long enough to see the working state,
    // then a canned branch.
    async createWorktree(workspacePath: string): Promise<WorktreeCreation> {
      await new Promise((resolve) => setTimeout(resolve, pauseMs))
      const id =
        CANNED_WORKTREE_IDS[worktrees % CANNED_WORKTREE_IDS.length] ?? CANNED_WORKTREE_IDS[0] ?? ''
      worktrees += 1
      return {
        ok: true,
        path: `${workspacePath}/.crucible/worktrees/${id}`,
        branch: `crucible/${id}`
      }
    },

    // Both board variants are drivable with no git, no gh and no cost: the
    // hosted one by default, the git-only one for a marker-word path.
    async branchBoard(workspacePath: string): Promise<BranchBoardAnswer> {
      return { kind: 'board', board: cannedBoard(workspacePath, Date.now()) }
    },

    // The same two shapes the branch board has: a hosted repository by
    // default, and no issue host at all for the marker-word path.
    async issueBoard(workspacePath: string): Promise<IssueBoardAnswer> {
      return cannedIssues(workspacePath, Date.now())
    },

    async openUrl(url: string): Promise<void> {
      openedUrls.push(url)
    },

    async startRun(_directory: string, command: string): Promise<RunId> {
      minted += 1
      const runId = `fake-run-${minted}`
      const endless = command.includes(ENDLESS)
      stream(
        runId,
        endless ? ENDLESS_CHUNKS : command.includes(FAILING) ? FAILURE_CHUNKS : SUCCESS_CHUNKS,
        endless ? undefined : command.includes(FAILING) ? 1 : 0
      )
      return runId
    },

    async stopRun(runId: RunId): Promise<void> {
      running.get(runId)?.stop()
    },

    async researchStatus(): Promise<ResearchStatus> {
      await new Promise((resolve) => setTimeout(resolve, pauseMs))
      return research
    },

    async researchConnect(apiKey?: string): Promise<ConnectOutcome> {
      endConnect()

      // A pasted key is the flow that can finish here: no browser is involved,
      // and the canned status moves the way the real one would.
      if (apiKey !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, pauseMs))
        research = {
          kind: 'signedIn',
          version: redactKeys(CANNED_VERSION),
          credits: CANNED_CREDITS
        }
        return { kind: 'settled', status: research }
      }

      return new Promise<ConnectOutcome>((resolve) => {
        const timers: ReturnType<typeof setTimeout>[] = []
        const mine = {
          settle(outcome: ConnectOutcome): void {
            for (const timer of timers) clearTimeout(timer)
            resolve(outcome)
          }
        }
        waiting = mine
        CANNED_CONNECT_CHUNKS.forEach((chunk, index) => {
          timers.push(
            setTimeout(
              () => {
                if (waiting === mine) emit({ type: 'research_output', chunk: redactKeys(chunk) })
              },
              pauseMs * (index + 1)
            )
          )
        })
      })
    },

    async researchCancelConnect(): Promise<void> {
      endConnect()
    },

    async researchDisconnect(): Promise<ResearchOutcome> {
      await new Promise((resolve) => setTimeout(resolve, pauseMs))
      research = { kind: 'signedOut', version: redactKeys(CANNED_VERSION) }
      return { kind: 'settled', status: research }
    },

    onEvent(listener: WorkspaceEventListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
