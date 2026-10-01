import { createContext } from 'react'
import type { CatalogSnapshot } from '../../../shared/workflows/catalog'

// What a workflow name anywhere in the window needs to show its hover card:
// the catalog as it stands, and the way into the full page. Provided once by
// the shell, so no surface that prints a workflow's name has to be handed it.

export interface CatalogLinks {
  readonly snapshot?: CatalogSnapshot
  /** Opens the workflow catalog on this workflow's page. */
  readonly open: (workspacePath: string, workflow: string) => void
}

export const CatalogContext = createContext<CatalogLinks>({ open: () => {} })
