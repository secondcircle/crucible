import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createIpcClient } from './agent/ipc-client'
import { Shell } from './Shell'
import './styles/base.css'

// The port here is always the IPC client: which adapter answers is main's
// choice, and no fake is ever constructed in the renderer, so anything driving
// the running app drives the shipped path.
function mountApp(): void {
  const container = document.getElementById('root')
  if (!container) throw new Error('renderer: #root is missing from index.html')

  createRoot(container).render(
    <StrictMode>
      <Shell port={createIpcClient()} />
    </StrictMode>
  )
}

mountApp()
