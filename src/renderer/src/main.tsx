import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createFakeAdapter } from '../../shared/agent/fake-adapter'
import { ChatPane } from './ChatPane'

/**
 * The renderer's composition root: the only place an agent port is built (D4).
 * Loading this module is the whole of its interface — it finds `#root` in the
 * document `index.html` ships and mounts the pane there — so there is nothing
 * here to call and nothing to hand it.
 *
 * For now it builds the fake adapter directly, so the pane can be driven with
 * no Electron anywhere. The agent channel slice replaces that one line with the
 * IPC client, and nothing else in the renderer changes — the pane never learns
 * which adapter answered it.
 */
const container = document.getElementById('root')
if (!container) throw new Error('renderer: #root is missing from index.html')

const port = createFakeAdapter()

createRoot(container).render(
  <StrictMode>
    <ChatPane port={port} />
  </StrictMode>
)
