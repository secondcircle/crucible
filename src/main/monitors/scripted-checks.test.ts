import { describe, expect, it } from 'vitest'
import { createScriptedCheckRunner } from './scripted-checks'

// The fake flavor's process seam. Its whole job is to make the three endings
// reachable with no shell and no model, so what is tested is that each word
// leads where the model needs it to.

async function walk(command: string, times: number): Promise<string[]> {
  const runner = createScriptedCheckRunner()
  const seen: string[] = []
  for (let at = 0; at < times; at += 1) {
    const result = await runner.run(command, '/repos/crucible').done
    seen.push(
      result.kind === 'exited' ? `exit ${result.exitCode}: ${result.output.trim()}` : result.kind
    )
  }
  return seen
}

describe('the scripted check runner', () => {
  it('starts no process at all', async () => {
    // No cwd is read and no bash is looked for: the command is a word, not a
    // program.
    const result = await createScriptedCheckRunner().run('anything', '/nowhere-at-all').done
    expect(result.kind).toBe('exited')
  })

  it('meets its condition on the third check of a "pass" command', async () => {
    expect(await walk('watch pass', 3)).toEqual([
      'exit 1: in_progress',
      'exit 1: in_progress',
      'exit 0: completed · e2e: failure · unit: success'
    ])
  })

  it('fails the same way every time for a "broken" one, so the strikes add up', async () => {
    const seen = await walk('watch broken', 3)
    expect(new Set(seen).size).toBe(1)
    expect(seen[0]).toContain('exit 4')
    expect(seen[0]).toContain('Not logged in')
  })

  it('never runs at all for a "missing" one', async () => {
    expect(await walk('watch missing', 1)).toEqual(['failed'])
  })

  it('waits forever for anything else, which is what times a monitor out', async () => {
    expect(new Set(await walk('watch the port to free up', 6))).toEqual(
      new Set(['exit 1: in_progress'])
    )
  })

  it('answers killed when it was stopped before it settled', async () => {
    const run = createScriptedCheckRunner(50).run('watch pass', '/repos')
    run.kill()
    expect((await run.done).kind).toBe('killed')
  })
})
