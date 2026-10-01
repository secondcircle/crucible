import { watch as watchFs } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ConversationAdapter } from '../../shared/agent/adapter'
import type { MainWorkflowCatalogService } from '../../shared/workflows/catalog'
import type { Flavor } from '../agent/select-adapter'
import type { LogSink } from '../log/sink'
import type { SpawnHost } from '../workflows/host/host'
import { shippedWorkflowLoader, userWorkflowsPath } from '../workflows/select-service'
import { createWorkflowCatalog, type WatchFolder } from './catalog'
import { createCatalogStore } from './store'

// Unlike the run and schedule seams, the fake flavor reads the real folders
// here: the files are what the catalog is about, and reading them costs
// nothing. Only the reading itself is a model call, and it goes through the
// adapter the launch chose, so a fake launch's readings are canned and no
// test or agent-driven check ever pays for one.

export interface CatalogWiring {
  readonly appPath: string
  /** Crucible's own state directory; the catalog's file lives under it. */
  readonly stateDir: string
  /** Starts the process a workflow file's manifest and plan are read in. */
  readonly spawnHost: SpawnHost
  /** The agent seam a reading is asked through. */
  readonly adapter: Pick<ConversationAdapter, 'readWorkflow'>
}

export function selectWorkflowCatalog(
  flavor: Flavor,
  log: LogSink,
  wiring: CatalogWiring
): MainWorkflowCatalogService {
  log.append({ source: 'main', event: 'workflow_catalog_selected', reader: flavor })
  const loader = shippedWorkflowLoader(wiring.appPath, log, wiring.spawnHost)
  return createWorkflowCatalog({
    surveyor: loader,
    folders: (workspacePath) => [join(workspacePath, '.crucible', 'workflows'), userWorkflowsPath()],
    read: (request) => wiring.adapter.readWorkflow(request),
    store: createCatalogStore(join(wiring.stateDir, 'workflow-catalog.json'), (cause) => {
      log.append({
        source: 'main',
        event: 'workflow_catalog_write_failed',
        message: cause instanceof Error ? cause.message : String(cause)
      })
    }),
    watch: watchFolder,
    log: (event) => log.append({ source: 'main', ...event, event: String(event.event) })
  })
}

// A folder that does not exist yet is waited for in its parent, so the first
// workflow saved into a new ~/.crucible/workflows is seen like any other.
export const watchFolder: WatchFolder = (folder, onChange) => {
  let stop = watchItself(folder, onChange)
  if (stop !== undefined) return () => stop?.()
  try {
    const parent = watchFs(dirname(folder), () => {
      const itself = watchItself(folder, onChange)
      if (itself === undefined) return
      parent.close()
      stop = itself
      onChange()
    })
    parent.on('error', () => parent.close())
    stop = () => parent.close()
    return () => stop?.()
  } catch {
    return undefined
  }
}

function watchItself(folder: string, onChange: () => void): (() => void) | undefined {
  try {
    const watcher = watchFs(folder, { recursive: true }, () => onChange())
    watcher.on('error', () => watcher.close())
    return () => watcher.close()
  } catch {
    return undefined
  }
}
