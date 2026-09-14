// @vitest-environment node
//
// The composer's `@file` listing against a real folder. The fallback walk is
// what a workspace that is not a repository gets, and it is the path that
// used to read every directory and every .gitignore synchronously, on the
// main thread, once per keystroke. These pin what it lists, in what order,
// and that it still yields between reads.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fileTree, listFiles, walk } from './files'

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A folder that is not a repository, so `git ls-files` cannot answer for it. */
function tempTree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'crucible-files-'))
  scratch.push(root)
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body, 'utf8')
  }
  return root
}

describe('listing a workspace git cannot answer for', () => {
  it('walks it depth-first in alphabetical order', async () => {
    const root = tempTree({
      'src/b.ts': '',
      'src/a.ts': '',
      'README.md': '',
      'src/nested/c.ts': ''
    })

    await expect(listFiles(root)).resolves.toEqual([
      'README.md',
      'src/a.ts',
      'src/b.ts',
      'src/nested/c.ts'
    ])
  })

  it('applies each .gitignore to the folder that holds it', async () => {
    const root = tempTree({
      '.gitignore': 'out/\n*.log\n',
      'keep.ts': '',
      'noise.log': '',
      'out/built.js': '',
      'packages/.gitignore': 'vendor\n',
      'packages/app.ts': '',
      'packages/vendor/lib.ts': ''
    })

    await expect(listFiles(root)).resolves.toEqual([
      '.gitignore',
      'keep.ts',
      'packages/.gitignore',
      'packages/app.ts'
    ])
  })

  it('honours a negation, and never lists .git', async () => {
    const root = tempTree({
      '.gitignore': '*.log\n!keep.log\n',
      '.git/config': '',
      'drop.log': '',
      'keep.log': ''
    })

    await expect(listFiles(root)).resolves.toEqual(['.gitignore', 'keep.log'])
  })

  // The walk is awaited throughout, so the loop turns while it runs: a timer
  // armed the moment it starts fires before it finishes. This fails the
  // moment any read in the walk goes back to being synchronous.
  it('lets the loop turn while it walks', async () => {
    const root = tempTree(
      Object.fromEntries(Array.from({ length: 200 }, (_, at) => [`d${at % 20}/f${at}.ts`, '']))
    )
    const order: string[] = []

    const walking = walk(root).then((listed) => {
      order.push('walked')
      return listed
    })
    setTimeout(() => order.push('timer'), 0)

    expect(await walking).toHaveLength(200)
    expect(order[0]).toBe('timer')
  })
})

/** A real repository, because the tree's ignore rules and colors are git's. */
function tempRepo(files: Readonly<Record<string, string>>): string {
  const root = tempTree(files)
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'nobody@example.invalid'],
    ['config', 'user.name', 'Nobody'],
    ['add', '-A'],
    ['commit', '-qm', 'first']
  ]) {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  }
  return root
}

describe('what the file tree lists', () => {
  it('hides what git ignores, shows dotfiles, and never shows .git', async () => {
    const root = tempRepo({
      '.gitignore': 'node_modules/\n',
      '.crucible/workflows/build.ts': '',
      'node_modules/left/index.js': '',
      'src/Shell.tsx': ''
    })

    const tree = await fileTree(root)

    expect(tree.directory).toBe(root)
    expect(tree.paths).toEqual(['.crucible/workflows/build.ts', '.gitignore', 'src/Shell.tsx'])
  })

  it('says which files git sees as modified and which as untracked', async () => {
    const root = tempRepo({ 'src/Shell.tsx': 'first\n', 'kept.ts': '' })
    writeFileSync(join(root, 'src/Shell.tsx'), 'changed\n', 'utf8')
    writeFileSync(join(root, 'src/new.ts'), 'fresh\n', 'utf8')

    const tree = await fileTree(root)

    expect(tree.changed).toEqual({ 'src/Shell.tsx': 'modified', 'src/new.ts': 'untracked' })
  })

  it('names the changes of a folder inside a repository by that folder’s own paths', async () => {
    const root = tempRepo({ 'src/inner/kept.ts': 'first\n', 'outside.ts': '' })
    writeFileSync(join(root, 'src/inner/kept.ts'), 'changed\n', 'utf8')
    writeFileSync(join(root, 'outside.ts'), 'changed too\n', 'utf8')

    const tree = await fileTree(join(root, 'src'))

    expect(tree.paths).toEqual(['inner/kept.ts'])
    expect(tree.changed).toEqual({ 'inner/kept.ts': 'modified' })
  })

  it('leaves a folder that is no repository plain, and still lists it', async () => {
    const tree = await fileTree(tempTree({ 'a.ts': '', 'b/c.ts': '' }))

    expect(tree.paths).toEqual(['a.ts', 'b/c.ts'])
    expect(tree.changed).toEqual({})
  })
})
