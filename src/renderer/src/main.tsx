import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createIpcClient } from './agent/ipc-client'
import { createAppUpdateClient } from './app-update/ipc-client'
import { createCacheClient } from './cache/ipc-client'
import { createCommandClient } from './commands/ipc-client'
import { createExhibitKeysClient } from './exhibits/ipc-client'
import { createNeedsYouClient } from './needs-you/ipc-client'
import { createQuotaClient } from './quota/ipc-client'
import { createWorkflowRunClient } from './runs/ipc-client'
import { createScheduleClient } from './schedules/ipc-client'
import { createMonitorClient } from './monitors/ipc-client'
import { instanceBadge } from './bridge'
import { Shell } from './Shell'
import { localFoldedStore } from './sidebar/folded-store'
import { createWorkspaceClient } from './workspace/ipc-client'
import './styles/base.css'

// Always the IPC client: which adapter answers is main's choice, so anything
// driving the running app drives the shipped path.
function mountApp(): void {
  const container = document.getElementById('root')
  if (!container) throw new Error('renderer: #root is missing from index.html')

  createRoot(container).render(
    <StrictMode>
      <Shell
        port={createIpcClient()}
        workspace={createWorkspaceClient()}
        commands={createCommandClient()}
        appUpdate={createAppUpdateClient()}
        quota={createQuotaClient()}
        cache={createCacheClient()}
        needsYou={createNeedsYouClient()}
        workflowRuns={createWorkflowRunClient()}
        schedules={createScheduleClient()}
        monitors={createMonitorClient()}
        exhibitKeys={createExhibitKeysClient()}
        folded={localFoldedStore()}
        instance={instanceBadge()}
      />
    </StrictMode>
  )
}

// The renderer's own long tasks, said on the console so main's forwarding
// puts them on the run log beside main's stalls: a frozen window is one or
// the other, and the log should say which. Attribution is what Chromium
// offers, which is only the duration; the trace is DevTools' job.
function watchLongTasks(): void {
  if (typeof PerformanceObserver === 'undefined') return
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < 200) continue
        console.warn(`renderer_long_task ${Math.round(entry.duration)}ms`)
      }
    })
    observer.observe({ entryTypes: ['longtask'] })
  } catch {
    // An older Chromium without the entry type: nothing to watch.
  }
}

watchLongTasks()
mountApp()
