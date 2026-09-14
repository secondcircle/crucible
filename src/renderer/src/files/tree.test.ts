import { describe, expect, it } from 'vitest'
import type { FileTree } from '../../../shared/workspace/service'
import { fileRows, insideTree, toggleFolder } from './tree'

const LISTING: FileTree = {
  directory: '/repos/crucible',
  paths: [
    '.gitignore',
    'AGENTS.md',
    'docs/adr/0008-context-panel.md',
    'docs/design/mock-a-ember.html',
    'package.json',
    'src/renderer/src/Shell.tsx',
    'src/renderer/src/state/panel-view.ts',
    'src/shared/agent/port.ts'
  ],
  changed: {
    'src/renderer/src/state/panel-view.ts': 'modified',
    'docs/design/mock-a-ember.html': 'untracked'
  }
}

const closed = { expanded: new Set<string>(), filter: '', collapsed: new Set<string>() }

function shown(rows: ReturnType<typeof fileRows>): string[] {
  return rows.map((row) => `${'  '.repeat(row.depth)}${row.name}`)
}

describe('the rows a closed tree draws', () => {
  it('lists the root’s own entries, folders first and each group alphabetical', () => {
    expect(shown(fileRows(LISTING, closed))).toEqual([
      'docs',
      'src',
      '.gitignore',
      'AGENTS.md',
      'package.json'
    ])
  })

  it('opens exactly the folders it is told are open', () => {
    const rows = fileRows(LISTING, { ...closed, expanded: new Set(['src', 'src/renderer']) })

    expect(shown(rows)).toEqual([
      'docs',
      'src',
      '  renderer',
      '    src',
      '  shared',
      '.gitignore',
      'AGENTS.md',
      'package.json'
    ])
  })

  it('carries the extension and the git status of every file it draws', () => {
    const rows = fileRows(LISTING, {
      ...closed,
      expanded: new Set(['src', 'src/renderer', 'src/renderer/src', 'src/renderer/src/state'])
    })
    const file = rows.find((row) => row.name === 'panel-view.ts')

    expect(file).toEqual({
      kind: 'file',
      path: 'src/renderer/src/state/panel-view.ts',
      name: 'panel-view.ts',
      depth: 4,
      extension: 'ts',
      status: 'modified'
    })
  })

  it('marks every folder on the way to a change, and no other', () => {
    const rows = fileRows(LISTING, { ...closed, expanded: new Set(['src', 'src/renderer']) })
    const holding = rows.filter((row) => row.kind === 'directory' && row.changed)

    expect(holding.map((row) => row.path)).toEqual([
      'docs',
      'src',
      'src/renderer',
      'src/renderer/src'
    ])
  })

  it('leaves a folder outside a repository plain', () => {
    const rows = fileRows({ ...LISTING, changed: {} }, closed)

    expect(rows.some((row) => row.kind === 'directory' && row.changed)).toBe(false)
    expect(rows.some((row) => row.kind === 'file' && row.status !== undefined)).toBe(false)
  })

  it('gives a dotfile no extension, because its name opens with the dot', () => {
    const row = fileRows(LISTING, closed).find((one) => one.name === '.gitignore')

    expect(row?.kind === 'file' && row.extension).toBe('')
  })
})

describe('the filter', () => {
  it('keeps the files it matches and every folder above them, opened', () => {
    expect(shown(fileRows(LISTING, { ...closed, filter: 'panel' }))).toEqual([
      'docs',
      '  adr',
      '    0008-context-panel.md',
      'src',
      '  renderer',
      '    src',
      '      state',
      '        panel-view.ts'
    ])
  })

  it('matches a stretch of the path, not the name alone, and ignores case', () => {
    expect(shown(fileRows(LISTING, { ...closed, filter: 'STATE/PAN' }))).toEqual([
      'src',
      '  renderer',
      '    src',
      '      state',
      '        panel-view.ts'
    ])
  })

  it('answers nothing at all when nothing matches', () => {
    expect(fileRows(LISTING, { ...closed, filter: 'nothing-here' })).toEqual([])
  })

  it('closes the folder the user closed, and nothing else it opened', () => {
    const rows = fileRows(LISTING, {
      ...closed,
      filter: 'panel',
      collapsed: new Set(['src/renderer'])
    })

    expect(shown(rows)).toEqual([
      'docs',
      '  adr',
      '    0008-context-panel.md',
      'src',
      '  renderer'
    ])
    expect(rows.find((row) => row.name === 'renderer')).toMatchObject({ expanded: false })
  })

  it('leaves the whole tree arranged as it was: the folds are the filter’s own', () => {
    const arranged = { ...closed, expanded: new Set(['docs']) }

    // Closed under the filter, and the filter then cleared.
    const under = fileRows(LISTING, { ...arranged, filter: 'panel', collapsed: new Set(['src']) })
    expect(shown(under)).toEqual(['docs', '  adr', '    0008-context-panel.md', 'src'])
    expect(shown(fileRows(LISTING, arranged))).toEqual([
      'docs',
      '  adr',
      '  design',
      'src',
      '.gitignore',
      'AGENTS.md',
      'package.json'
    ])
  })

  it('narrows nothing for spaces alone, which is no filter at all', () => {
    expect(shown(fileRows(LISTING, { ...closed, filter: '   ' }))).toEqual(
      shown(fileRows(LISTING, closed))
    )
  })
})

describe('opening and closing a folder', () => {
  it('opens a closed one and closes an open one', () => {
    const opened = toggleFolder(new Set<string>(), 'src')

    expect([...opened]).toEqual(['src'])
    expect([...toggleFolder(opened, 'src')]).toEqual([])
  })
})

describe('where a file sits in the tree', () => {
  it('names the path the tree knows it by', () => {
    expect(insideTree('/repos/crucible', '/repos/crucible/src/Shell.tsx')).toBe('src/Shell.tsx')
  })

  it('says nothing about a file outside the tree, or the root itself', () => {
    expect(insideTree('/repos/crucible', '/repos/other/Shell.tsx')).toBeUndefined()
    expect(insideTree('/repos/crucible', '/repos/crucible')).toBeUndefined()
    // A sibling folder whose name merely opens with the root's.
    expect(insideTree('/repos/crucible', '/repos/crucible-old/x.ts')).toBeUndefined()
  })

  it('answers in the tree’s own separators for a Windows path', () => {
    expect(insideTree('C:\\repos\\crucible', 'C:\\repos\\crucible\\src\\Shell.tsx')).toBe(
      'src/Shell.tsx'
    )
  })
})
