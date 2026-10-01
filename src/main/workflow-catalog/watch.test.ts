// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchFolder } from './select-service'

// The real watcher on real folders: a save anywhere under a workflow folder
// is a change, and a folder that is not there yet is waited for.

const scratch: string[] = []
const stops: (() => void)[] = []

afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crucible-watch-'))
  scratch.push(dir)
  return dir
}

describe('watching a workflow folder', () => {
  it('hears a save in a subfolder', async () => {
    const folder = tempDir()
    mkdirSync(join(folder, 'lib'))
    const onChange = vi.fn()
    const stop = watchFolder(folder, onChange)
    expect(stop).toBeDefined()
    stops.push(stop as () => void)

    writeFileSync(join(folder, 'lib', 'helper.ts'), 'export const a = 1\n', 'utf8')
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled())
  })

  it('waits in the parent for a folder that does not exist yet, then watches it', async () => {
    const parent = tempDir()
    const folder = join(parent, 'workflows')
    const onChange = vi.fn()
    const stop = watchFolder(folder, onChange)
    expect(stop).toBeDefined()
    stops.push(stop as () => void)

    mkdirSync(folder)
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled())
    onChange.mockClear()
    writeFileSync(join(folder, 'notes.ts'), 'export default {}\n', 'utf8')
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled())
  })

  it('cannot watch a folder whose parent is not there either', () => {
    expect(watchFolder(join(tempDir(), 'a', 'b'), () => {})).toBeUndefined()
  })
})
