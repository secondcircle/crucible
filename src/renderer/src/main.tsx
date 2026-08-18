import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createIpcClient } from './agent/ipc-client'
import { ChatPane } from './ChatPane'

/**
 * The renderer's composition root: the only place an agent port is built (D4).
 * Loading this module is the whole of its interface — it finds `#root` in the
 * document `index.html` ships and mounts the pane there — so there is nothing
 * here to call and nothing to hand it.
 *
 * The port it builds is the IPC client, always: the app has exactly one path to
 * an agent and agents driving it must drive the shipped one, so which adapter
 * answers is main's choice (D5) and no fake is ever constructed in the
 * renderer. A component test hands the pane a port of its own instead, which is
 * the same seam used from the other side.
 */
function mountApp(): void {
  const container = document.getElementById('root')
  if (!container) throw new Error('renderer: #root is missing from index.html')

  createRoot(container).render(
    <StrictMode>
      <ChatPane port={createIpcClient()} />
    </StrictMode>
  )
}

mountApp()
