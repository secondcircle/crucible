import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCheckRunner } from './check-runner'

// The process seam against a real bash in a real directory: the command runs
// where the monitor was set, exactly as it was written, and a command that
// cannot run at all is told apart from one that ran and said no.

const scratch: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crucible-check-'))
  scratch.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('running a check', () => {
  it('runs it in the directory it was given', async () => {
    const dir = tempDir()
    const result = await createCheckRunner().run('pwd', dir).done
    expect(result.kind).toBe('exited')
    if (result.kind !== 'exited') return
    expect(result.exitCode).toBe(0)
    // A Mac's /var is a symlink to /private/var, so the tail is what matters.
    expect(result.output.trim().endsWith(dir.replace(/^\/private/, ''))).toBe(true)
  })

  it('runs the command exactly as given, quotes, pipes and all', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'state.txt'), 'IN_PROGRESS\nqueued\n')
    const result = await createCheckRunner().run(
      `cat state.txt | grep -q "IN_PROGRESS" && echo 'still going' && exit 1`,
      dir
    ).done

    expect(result).toMatchObject({ kind: 'exited', exitCode: 1 })
    if (result.kind !== 'exited') return
    expect(result.output.trim()).toBe('still going')
  })

  it('answers 0 when the condition is met', async () => {
    const result = await createCheckRunner().run('exit 0', tempDir()).done
    expect(result).toMatchObject({ kind: 'exited', exitCode: 0 })
  })

  it('keeps stderr apart from the interleaved output, because the breaking rule reads it', async () => {
    const result = await createCheckRunner().run(
      'echo out; echo bad 1>&2; exit 3',
      tempDir()
    ).done
    expect(result.kind).toBe('exited')
    if (result.kind !== 'exited') return
    expect(result.stderr.trim()).toBe('bad')
    expect(result.output).toContain('out')
    expect(result.output).toContain('bad')
  })

  it('reports a command bash cannot find as bash does', async () => {
    const result = await createCheckRunner().run(
      'crucible-no-such-command-anywhere',
      tempDir()
    ).done
    expect(result).toMatchObject({ kind: 'exited', exitCode: 127 })
  })

  it('fails rather than waiting when the directory is gone', async () => {
    const dir = tempDir()
    rmSync(dir, { recursive: true, force: true })
    const result = await createCheckRunner().run('pwd', dir).done
    expect(result.kind).toBe('failed')
  })

  it('is stopped by kill, and its result is used for nothing', async () => {
    const run = createCheckRunner().run('sleep 30', tempDir())
    // A beat, so the process genuinely exists before it is killed.
    await new Promise((resolve) => setTimeout(resolve, 50))
    run.kill()
    expect((await run.done).kind).toBe('killed')
  })

  it('is harmless to kill something that already exited', async () => {
    const run = createCheckRunner().run('exit 0', tempDir())
    await run.done
    expect(() => run.kill()).not.toThrow()
  })
})
