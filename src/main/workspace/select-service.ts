import { createFakeWorkspaceService } from '../../shared/workspace/fake-service'
import type { WorkspaceService } from '../../shared/workspace/service'
import type { Flavor } from '../agent/select-adapter'
import type { LogSink } from '../log/sink'
import { createWorkspaceService } from './service'

export interface SelectedWorkspaceService {
  readonly service: WorkspaceService
  /** Kills whatever is still running; the fake has nothing to kill. */
  dispose(): void
}

// One flavor decision per launch governs both seams: the fake-adapter launch
// gets the fake workspace service, so an agent-driven check reads no folder and
// starts no process, and the SDK launch gets the real one.
export function selectWorkspaceService(flavor: Flavor, log: LogSink): SelectedWorkspaceService {
  log.append({ source: 'main', event: 'workspace_service_selected', service: flavor })

  if (flavor !== 'sdk') return { service: createFakeWorkspaceService(), dispose: () => {} }

  const service = createWorkspaceService()
  return { service, dispose: () => service.dispose() }
}
