import type { SessionId } from '../../shared/agent/port'
import type { ShellStore } from '../shell/store'
import type { PanelPersistence, StoredPanel } from './model'

// Panel state lives in the session record it belongs to, so removing the
// session forgets its tabs with it.
export function storePanelPersistence(store: ShellStore): PanelPersistence {
  return {
    load(sessionId: SessionId): StoredPanel | undefined {
      return store.session(sessionId)?.panel
    },

    save(sessionId: SessionId, panel: StoredPanel): void {
      // A session that is gone has no record to write into, and writing one
      // would resurrect what a removal just forgot.
      if (store.session(sessionId) === undefined) return
      store.updateSession(sessionId, { panel })
    }
  }
}
