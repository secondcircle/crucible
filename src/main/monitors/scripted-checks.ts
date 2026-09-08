import type { CheckResult, CheckRun, CheckRunner } from './check-runner'

const IN_PROGRESS = 'in_progress\n'
const COMPLETED = 'completed · e2e: failure · unit: success\n'
const GH_ERROR = 'gh: Not logged in to github.com. Run `gh auth login`.\n'

export function createScriptedCheckRunner(beatMs = 0): CheckRunner {
  // Per command text rather than per monitor: the runner never learns which
  // monitor asked, and two monitors on the same scripted command are meant to
  // walk the same script.
  const runs = new Map<string, number>()

  return {
    run(command: string): CheckRun {
      const asked = command.toLowerCase()
      const count = (runs.get(command) ?? 0) + 1
      runs.set(command, count)

      let killed = false
      const done = new Promise<CheckResult>((resolve) => {
        const settle = (): void => {
          if (killed) return resolve({ kind: 'killed' })
          resolve(fateOf(asked, count))
        }
        if (beatMs <= 0) queueMicrotask(settle)
        else setTimeout(settle, beatMs)
      })

      return {
        done,
        kill(): void {
          killed = true
        }
      }
    }
  }
}

function fateOf(asked: string, count: number): CheckResult {
  if (asked.includes('missing')) {
    return { kind: 'failed', message: 'spawn bash ENOENT' }
  }
  if (asked.includes('broken')) {
    return { kind: 'exited', exitCode: 4, output: GH_ERROR, stderr: GH_ERROR }
  }
  if (asked.includes('pass') && count >= 3) {
    return { kind: 'exited', exitCode: 0, output: COMPLETED, stderr: '' }
  }
  return { kind: 'exited', exitCode: 1, output: IN_PROGRESS, stderr: '' }
}
