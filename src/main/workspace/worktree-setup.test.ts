// @vitest-environment node
//
// The setup hook against real scripts on disk. A worktree straight out of git
// is a checkout, not a working environment: this is the seam where a
// repository says what the difference is.
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hasWorktreeSetup, setUpWorktree } from './worktree-setup'

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crucible-setup-'))
  scratch.push(dir)
  return dir
}

/** A workspace whose `.crucible/worktree-setup` is the given shell body. */
function workspaceWith(body: string, executable = true): string {
  const workspace = tempDir()
  mkdirSync(join(workspace, '.crucible'), { recursive: true })
  const script = join(workspace, '.crucible', 'worktree-setup')
  writeFileSync(script, `#!/usr/bin/env bash\n${body}\n`, 'utf8')
  if (executable) chmodSync(script, 0o755)
  return workspace
}

describe('setting up a fresh worktree', () => {
  it('is a success with nothing run when the repository asks for nothing', async () => {
    const outcome = await setUpWorktree(tempDir(), tempDir())

    expect(outcome.ok).toBe(true)
    expect(outcome.ran).toBe(false)
    expect(hasWorktreeSetup(tempDir())).toBe(false)
  })

  it('runs the script inside the worktree, not the checkout', async () => {
    // The whole point: the script acts on the new worktree. Being handed the
    // checkout instead would have it install over the workspace itself.
    const workspace = workspaceWith('pwd > where-it-ran.txt')
    const worktree = tempDir()

    const outcome = await setUpWorktree(workspace, worktree)

    expect(outcome.ok).toBe(true)
    expect(outcome.ran).toBe(true)
    expect(readFileSync(join(worktree, 'where-it-ran.txt'), 'utf8').trim()).toContain(
      worktree.replace('/private', '')
    )
  })

  it('fails with everything the script said, in the order it said it', async () => {
    const workspace = workspaceWith(
      'echo "installing"\necho "no lockfile here" >&2\nexit 3'
    )

    const outcome = await setUpWorktree(workspace, tempDir())

    expect(outcome.ok).toBe(false)
    expect(outcome.ran).toBe(true)
    expect(outcome.output).toContain('exited 3')
    expect(outcome.output).toContain('installing')
    expect(outcome.output).toContain('no lockfile here')
  })

  it('says so, and how to fix it, when the script cannot be executed', async () => {
    // Presence is the repository claiming the mechanism. A file that is there
    // but unusable is a failure, never a quiet skip behind the repo's back.
    const workspace = workspaceWith('exit 0', false)

    const outcome = await setUpWorktree(workspace, tempDir())

    expect(outcome.ok).toBe(false)
    expect(outcome.ran).toBe(false)
    expect(outcome.output).toContain('chmod +x')
    expect(hasWorktreeSetup(workspace)).toBe(true)
  })
})
