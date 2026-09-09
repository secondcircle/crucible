// @vitest-environment node
//
// The composer's `@file` listing against a real folder. The fallback walk is
// what a workspace that is not a repository gets, and it is the path that
// used to read every directory and every .gitignore synchronously, on the
// main thread, once per keystroke. These pin what it lists, in what order,
// and that it still yields between reads.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listFiles, walk } from './files'

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
