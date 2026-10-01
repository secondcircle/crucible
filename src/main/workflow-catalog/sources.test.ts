// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG_READER } from '../../shared/workflows/catalog-settings'
import { sourcesHash, workflowSources } from './sources'
import { createCatalogStore } from './store'

const scratch: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crucible-catalog-'))
  scratch.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function folderWith(files: Record<string, string>): string {
  const folder = tempDir()
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(folder, name, '..'), { recursive: true })
    writeFileSync(join(folder, name), text, 'utf8')
  }
  return folder
}

describe('a workflow’s sources', () => {
  it('are the file and every local file it imports, followed through, packages left out', async () => {
    const folder = folderWith({
      'build.ts':
        "import { workflow } from 'crucible:workflow'\nimport { a } from './lib/a'\nimport z from 'zod'\n",
      'lib/a.ts': "export { b } from './b.ts'\nexport const a = 1\n",
      'lib/b.ts': "import { a } from './a'\nexport const b = a\n"
    })
    const files = await workflowSources(join(folder, 'build.ts'))
    expect(files.map((file) => file.label)).toEqual([
      'build.ts',
      join('lib', 'a.ts'),
      join('lib', 'b.ts')
    ])
  })

  it('hash differently when any file in the set changes, and alike when none does', async () => {
    const folder = folderWith({
      'build.ts': "import { a } from './lib/a'\n",
      'lib/a.ts': 'export const a = 1\n'
    })
    const path = join(folder, 'build.ts')
    const before = sourcesHash(await workflowSources(path))
    expect(sourcesHash(await workflowSources(path))).toBe(before)
    writeFileSync(join(folder, 'lib', 'a.ts'), 'export const a = 2\n', 'utf8')
    expect(sourcesHash(await workflowSources(path))).not.toBe(before)
  })
})

describe('the catalog’s store', () => {
  it('keeps the reader and the readings across a launch', async () => {
    const file = join(tempDir(), 'state', 'workflow-catalog.json')
    const failures: unknown[] = []
    const first = createCatalogStore(file, (cause) => failures.push(cause))
    await first.ready
    expect(first.reader()).toEqual(DEFAULT_CATALOG_READER)
    const reader = { model: 'anthropic/claude-haiku-5', effort: 'low' }
    const reading = {
      reader,
      readAt: '2026-09-01T00:00:00.000Z',
      summary: 's',
      agents: [],
      steps: ['x'],
      stops: [],
      returns: { artifacts: [], report: 'r' }
    }
    first.setReader(reader)
    first.keep('/w/build.ts', 'anthropic/claude-haiku-5:low', { key: 'k', reading })

    await expect
      .poll(async () => {
        const next = createCatalogStore(file, (cause) => failures.push(cause))
        await next.ready
        return [next.reader(), next.reading('/w/build.ts', 'anthropic/claude-haiku-5:low')]
      })
      .toEqual([reader, { key: 'k', reading }])
    expect(failures).toEqual([])
  })

  it('starts from the default over a file it cannot read', async () => {
    const file = join(tempDir(), 'workflow-catalog.json')
    writeFileSync(file, '{ half a fi', 'utf8')
    const store = createCatalogStore(file, () => {})
    await store.ready
    expect(store.reader()).toEqual(DEFAULT_CATALOG_READER)
  })
})
