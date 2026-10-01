// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG_READER } from '../../shared/workflows/catalog-settings'
import type { WorkflowReading } from '../../shared/workflows/catalog'
import { detachedReading, rootedReading, sourcesHash, workflowSources } from './sources'
import { createCatalogStore, memoryCatalogStore } from './store'

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
    first.keep('anthropic/claude-haiku-5:low', 'h', reading, ['/w/build.ts'])

    await expect
      .poll(async () => {
        const next = createCatalogStore(file, (cause) => failures.push(cause))
        await next.ready
        return [
          next.reader(),
          next.reading('anthropic/claude-haiku-5:low', 'h'),
          next.lastRead('/w/build.ts', 'anthropic/claude-haiku-5:low')
        ]
      })
      .toEqual([reader, reading, 'h'])
    expect(failures).toEqual([])
  })

  it('keeps a reading by its source set, and lets go of one no file holds any more', () => {
    const store = memoryCatalogStore()
    const reading = (summary: string): WorkflowReading => ({
      reader: DEFAULT_CATALOG_READER,
      readAt: '2026-09-01T00:00:00.000Z',
      summary,
      agents: [],
      steps: ['x'],
      stops: [],
      returns: { artifacts: [], report: 'r' }
    })
    store.keep('r', 'one', reading('first'), ['/a/build.ts'])
    // The same bytes in another worktree: the reading is already made.
    store.holds('/b/build.ts', 'r', 'one')
    expect(store.lastRead('/b/build.ts', 'r')).toBe('one')
    store.keep('r', 'two', reading('second'), ['/a/build.ts'])
    // /b still holds the first bytes, so the first reading stays.
    expect(store.reading('r', 'one')?.summary).toBe('first')
    store.keep('r', 'three', reading('third'), ['/b/build.ts'])
    expect(store.reading('r', 'one')).toBeUndefined()
    expect(store.reading('r', 'two')?.summary).toBe('second')
    // Nothing to hold where nothing was read.
    store.holds('/c/build.ts', 'r', 'never')
    expect(store.lastRead('/c/build.ts', 'r')).toBeUndefined()
  })

  it('reads past a file an older build wrote', async () => {
    const file = join(tempDir(), 'workflow-catalog.json')
    const reader = { model: 'anthropic/claude-haiku-5', effort: 'low' }
    writeFileSync(
      file,
      JSON.stringify({ version: 1, reader, readings: [{ path: '/w/build.ts', reader: 'x', key: 'k', reading: {} }] }),
      'utf8'
    )
    const store = createCatalogStore(file, () => {})
    await store.ready
    expect(store.reader()).toEqual(reader)
    expect(store.lastRead('/w/build.ts', 'x')).toBeUndefined()
  })

  it('starts from the default over a file it cannot read', async () => {
    const file = join(tempDir(), 'workflow-catalog.json')
    writeFileSync(file, '{ half a fi', 'utf8')
    const store = createCatalogStore(file, () => {})
    await store.ready
    expect(store.reader()).toEqual(DEFAULT_CATALOG_READER)
  })
})

describe('a reading kept apart from any one path', () => {
  const quote = (file: string): { file: string; start: number; end: number; lines: [] } => ({
    file,
    start: 1,
    end: 1,
    lines: []
  })
  // The same reading, its quotes naming each file as `name` spells it.
  const reading = (name: (label: string) => string): WorkflowReading => ({
    reader: DEFAULT_CATALOG_READER,
    readAt: '2026-09-01T00:00:00.000Z',
    summary: 's',
    agents: [
      {
        role: 'Builder',
        nodes: ['build'],
        does: 'builds',
        model: { value: 'anthropic/claude-opus-5-5:high', quote: quote(name('build.ts')) },
        system: { name: 'NODE_SYSTEM', ...quote(name('lib/system.ts')) },
        prompt: { name: 'taskPrompt', ...quote(name('build.ts')) }
      },
      { role: 'Plain', nodes: ['plain'], does: 'names nothing' }
    ],
    steps: ['x'],
    stops: [],
    returns: { artifacts: [], report: 'r' }
  })

  it('names its files by label, and is rooted again beside any workflow file', () => {
    const inA = reading((label) => `/a/.crucible/workflows/${label}`)
    const detached = detachedReading(inA, '/a/.crucible/workflows/build.ts')
    expect(detached).toEqual(reading((label) => label))
    expect(rootedReading(detached, '/b/.crucible/workflows/build.ts')).toEqual(
      reading((label) => `/b/.crucible/workflows/${label}`)
    )
  })
})
