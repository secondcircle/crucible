import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionId } from '../../shared/agent/port'
import { createFakeWorkflowRunService } from '../../shared/workflows/fake-service'
import type { MainWorkflowRunService } from '../../shared/workflows/service'
import type { Flavor } from '../agent/select-adapter'
import type { LogSink } from '../log/sink'
import { readShippedStandingPrompt, shippedWorkflowLibPath, shippedWorkflowsPath } from '../shipped'
import { createWorkflowEngine } from './engine'
import { createWorkflowLoader } from './loader'
import { createLiveWorkflowRunService } from './service'
import { createSdkNodeSessionFactory } from './sdk-node-session'
import { createRunStore } from './store'

/** Never created here: discovery only ever reads. */
export function userWorkflowsPath(home = homedir()): string {
  return join(home, '.crucible', 'workflows')
}

export interface WorkflowRunWiring {
  readonly appPath: string
  /** Crucible's own state directory; run records live under it (ADR 0015). */
  readonly stateDir: string
  /** How a run speaks: a message to its orchestrator session's agent. */
  readonly deliver: (sessionId: SessionId, text: string) => void
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
    return createFakeWorkflowRunService({ deliver: wiring.deliver })
  }

  const loader = createWorkflowLoader({
    roots: {
      builtIn: shippedWorkflowsPath(wiring.appPath),
      user: userWorkflowsPath()
    },
    authoringModule: shippedWorkflowLibPath(wiring.appPath),
    onUnloadable: (path, cause) => {
      log.append({
        source: 'main',
        event: 'workflow_file_unloadable',
        path,
        message: cause instanceof Error ? cause.message : String(cause)
      })
    }
  })

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
    }
  })
}
