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

// One flavor decision governs both seams, so a fake-adapter launch reads no
// folder and starts no process either.
export function selectWorkspaceService(
  flavor: Flavor,
  log: LogSink,
  // The two OS surfaces only main may reach: the browser a link opens in and
  // the file manager a row reveals in. The fake opens neither.
  platform: {
    readonly openExternal: (url: string) => void
    readonly revealItem: (path: string) => void
  }
): SelectedWorkspaceService {
  log.append({ source: 'main', event: 'workspace_service_selected', service: flavor })

  if (flavor !== 'sdk') return { service: createFakeWorkspaceService(), dispose: () => {} }

  const service = createWorkspaceService(platform)
  return { service, dispose: () => service.dispose() }
}
