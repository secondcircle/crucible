import { describe, expect, it } from 'vitest'
import type { CatalogEntry, CatalogSnapshot } from './catalog'
import { catalogStatus } from './catalog-facts'
import { DEFAULT_CATALOG_READER } from './catalog-settings'

const USER_FILE = '/home/.crucible/workflows/tidy.ts'

const live: CatalogEntry = {
  kind: 'workflow',
  name: 'tidy',
  origin: 'user',
  path: USER_FILE,
  manifest: { description: 'tidies', inputs: {} },
  reading: { status: 'reading' }
}

const shadowed: CatalogEntry = {
  kind: 'shadowed',
  name: 'tidy',
  origin: 'user',
  path: USER_FILE,
  winner: '/a/.crucible/workflows/tidy.ts'
}

function snapshot(...catalogs: (readonly CatalogEntry[])[]): CatalogSnapshot {
  return {
    reader: DEFAULT_CATALOG_READER,
    workspaces: catalogs.map((entries, index) => ({ workspacePath: `/w${index}`, entries }))
  }
}

describe('the catalog’s status', () => {
  it('counts a user file shadowed in one workspace by where it runs, whichever comes first', () => {
    expect(catalogStatus(snapshot([shadowed], [live]))).toMatchObject({ reading: 1 })
    expect(catalogStatus(snapshot([live], [shadowed]))).toMatchObject({ reading: 1 })
  })

  it('counts one file in two workspaces once', () => {
    expect(catalogStatus(snapshot([live], [live]))).toMatchObject({ read: 0, reading: 1, failed: 0 })
  })
})
