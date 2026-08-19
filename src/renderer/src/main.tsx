import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createIpcClient } from './agent/ipc-client'
import { Shell } from './Shell'
import './styles/base.css'

/**
 * The renderer's composition root: the only place an agent port is built.
 * Loading this module is the whole of its interface — it finds `#root` in the
 * document `index.html` ships and mounts the shell there — so there is nothing
 * here to call and nothing to hand it.
 *
 * The port it builds is the IPC client, always: the app has exactly one path to
 * an agent and agents driving it must drive the shipped one, so which adapter
 * answers is main's choice and no fake is ever constructed in the renderer. A
 * component test hands the shell a port of its own instead, which is the same
 * seam used from the other side.
 */
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
