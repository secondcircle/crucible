import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createIpcClient } from './agent/ipc-client'
import { createCommandClient } from './commands/ipc-client'
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
      />
    </StrictMode>
  )
}

mountApp()
