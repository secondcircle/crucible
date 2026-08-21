import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createIpcClient } from './agent/ipc-client'
import { createAppUpdateClient } from './app-update/ipc-client'
import { createCacheClient } from './cache/ipc-client'
import { createCommandClient } from './commands/ipc-client'
import { createNeedsYouClient } from './needs-you/ipc-client'
import { createQuotaClient } from './quota/ipc-client'
import { createWorkflowRunClient } from './runs/ipc-client'
import { Shell } from './Shell'
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
      />
    </StrictMode>
  )
}

mountApp()
