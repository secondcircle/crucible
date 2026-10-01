import type {
  CatalogListener,
  CatalogSnapshot,
  WorkflowCatalogService
} from '../../../shared/workflows/catalog'
import {
  DEFAULT_CATALOG_READER,
  type CatalogReaderSettings
} from '../../../shared/workflows/catalog-settings'

// Answers the catalog seam the way main does but reads nothing by itself: a
// test sets the snapshot and the event goes out whole, like the catalog's.
// The board, the chip, the hover cards and the Settings section are all
// provable against this, with no main process and no reader.

export interface ScriptedCatalog extends WorkflowCatalogService {
  readonly calls: ReadonlyArray<
    | { readonly op: 'open'; readonly workspacePath: string }
    | { readonly op: 'setReader'; readonly settings: CatalogReaderSettings }
  >
  /** Replaces the snapshot and announces it. */
  setSnapshot(snapshot: CatalogSnapshot): void
}

export function createScriptedCatalog(
  initial: CatalogSnapshot = { reader: DEFAULT_CATALOG_READER, workspaces: [] }
): ScriptedCatalog {
  let snapshot = initial
  const listeners = new Set<CatalogListener>()
  const calls: Array<
    { op: 'open'; workspacePath: string } | { op: 'setReader'; settings: CatalogReaderSettings }
  > = []

  return {
    calls,

    setSnapshot(next: CatalogSnapshot): void {
      snapshot = next
      for (const listener of [...listeners]) listener({ type: 'catalog', snapshot })
    },

    async snapshot() {
      return snapshot
    },

    async open(workspacePath: string) {
      calls.push({ op: 'open', workspacePath })
    },

    async setReader(settings: CatalogReaderSettings) {
      calls.push({ op: 'setReader', settings })
    },

    onEvent(listener: CatalogListener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
