import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { SessionId } from '../../shared/agent/port'
import {
  createFakeWorkflowRunService,
  type FakeArtifactFiles
} from '../../shared/workflows/fake-service'
import type { MainWorkflowRunService } from '../../shared/workflows/service'
import type { CacheRecorder } from '../cache/ledger'
import type { Flavor } from '../agent/select-adapter'
import type { LogSink } from '../log/sink'
import { readShippedStandingPrompt, shippedWorkflowLibPath, shippedWorkflowsPath } from '../shipped'
import { createWorkflowEngine } from './engine'
import { createWorkflowLoader, type WorkflowLoader } from './loader'
import { createLiveWorkflowRunService } from './service'
import { createSdkNodeSessionFactory } from './sdk-node-session'
import { createRunStore } from './store'

/** Never created here: discovery only ever reads. */
export function userWorkflowsPath(home = homedir()): string {
  return join(home, '.crucible', 'workflows')
}

// One loader shape for the launch: the engine resolves the workflow a run
// executes through it, and the scheduler reads the schedules a repo declares
// through it. Its module cache is off, so both see an edited file at once.
export function shippedWorkflowLoader(appPath: string, log: LogSink): WorkflowLoader {
  return createWorkflowLoader({
    roots: { builtIn: shippedWorkflowsPath(appPath), user: userWorkflowsPath() },
    authoringModule: shippedWorkflowLibPath(appPath),
    onUnloadable: (path, cause) => {
      log.append({
        source: 'main',
        event: 'workflow_file_unloadable',
        path,
        message: cause instanceof Error ? cause.message : String(cause)
      })
    }
  })
}

export interface WorkflowRunWiring {
  readonly appPath: string
  /** Crucible's own state directory; run records live under it. */
  readonly stateDir: string
  /** How a run speaks: a message to its orchestrator session's agent. */
  readonly deliver: (sessionId: SessionId, text: string) => void
  /** The cache ledger every observed miss is appended to, sessions and runs alike. */
  readonly cache?: CacheRecorder
  /** Shows a file in the OS file manager, for the artifact reader's Reveal. */
  readonly reveal?: (path: string) => void
  // Fake flavor only: the workspace the canned runs claim. Investigate needs
  // that workspace open in the sidebar, so an invented directory would leave
  // the canned rows uninvestigable; the fallback below is this checkout,
  // which the user can add.
  readonly cannedWorkspacePath?: string
}

// The fake service is compiled into the renderer bundle too, so its file
// access is handed in from here: the same `<stateDir>/workflow-runs/<runId>/
// artifacts/` layout the live store uses, and nothing outside it.
function scriptedArtifactFiles(root: string): FakeArtifactFiles {
  return {
    dir(runId: string): string {
      const dir = join(root, runId, 'artifacts')
      mkdirSync(dir, { recursive: true })
      return dir
    },
    write(path: string, body: string): void {
      try {
        writeFileSync(path, body, 'utf8')
      } catch {
        // A scripted artifact that cannot be written leaves the record saying
        // what it would have written and the reader honest about the file.
      }
    },
    read(path: string): string | undefined {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return undefined
      }
    },
    size(path: string): number | undefined {
      try {
        return statSync(path).size
      } catch {
        return undefined
      }
    }
  }
}

// One flavor decision governs all seams: a fake-flavor launch runs scripted
// runs, reads no workflow folder and starts no agent session.
export function selectWorkflowRunService(
  flavor: Flavor,
  log: LogSink,
  wiring: WorkflowRunWiring
): MainWorkflowRunService {
  log.append({ source: 'main', event: 'workflow_run_service_selected', service: flavor })

  if (flavor !== 'sdk') {
    const path = wiring.cannedWorkspacePath ?? process.cwd()
    return createFakeWorkflowRunService({
      deliver: wiring.deliver,
      files: scriptedArtifactFiles(join(wiring.stateDir, 'workflow-runs')),
      workspace: { path, name: basename(path) },
      ...(wiring.reveal === undefined ? {} : { reveal: wiring.reveal })
    })
  }

  const loader = shippedWorkflowLoader(wiring.appPath, log)

  const store = createRunStore(join(wiring.stateDir, 'workflow-runs'), (path, cause) => {
    log.append({
      source: 'main',
      event: 'run_record_write_failed',
      path,
      message: cause instanceof Error ? cause.message : String(cause)
    })
  })

  const changeListeners = new Set<() => void>()
  const engine = createWorkflowEngine({
    loader,
    store,
    sessions: createSdkNodeSessionFactory({
      standingPrompt: readShippedStandingPrompt(wiring.appPath),
      agentDir: join(wiring.stateDir, 'workflow-agent')
    }),
    deliver: wiring.deliver,
    ...(wiring.cache === undefined ? {} : { cache: wiring.cache }),
    onChanged: () => {
      for (const listener of [...changeListeners]) listener()
    },
    log: (event) =>
      log.append({ source: 'main', event: 'workflow_engine', ...event })
  })

  return createLiveWorkflowRunService({
    engine,
    loader,
    changes: {
      subscribe(listener: () => void): void {
        changeListeners.add(listener)
      }
    },
    ...(wiring.reveal === undefined ? {} : { reveal: wiring.reveal })
  })
}
