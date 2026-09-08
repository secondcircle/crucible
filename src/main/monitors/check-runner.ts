import { spawn } from 'node:child_process'
import { bashLocation, killTree } from '../platform/exec'

// The process seam behind the monitor model: one bash run of the agent's
// command in the agent's directory, and nothing else. The command is passed to
// bash exactly as it was given — no wrapper, no preamble, no injected
// arguments — because a check that ran something the agent did not write would
// answer a question nobody asked.

export type CheckResult =
  // bash ran and exited. `output` is stdout and stderr interleaved as they
  // arrived; `stderr` alone is what the breaking rule reads.
  | {
      readonly kind: 'exited'
      readonly exitCode: number
      readonly output: string
      readonly stderr: string
    }
  /** The process never ran: no bash, a spawn error, the directory is gone. */
  | { readonly kind: 'failed'; readonly message: string }
  /** `kill()` was called before it exited. Used for nothing. */
  | { readonly kind: 'killed' }

export interface CheckRun {
  readonly done: Promise<CheckResult>
  /** Kills the process and everything it started. Harmless after exit. */
  kill(): void
}

export interface CheckRunner {
  /** `bash -c <command>` in `cwd`, spawned exactly as a bash run is. */
  run(command: string, cwd: string): CheckRun
}

/** More output than this from one check is the check's problem, not ours. */
const MAX_OUTPUT = 1024 * 1024

export function createCheckRunner(): CheckRunner {
  return {
    run(command: string, cwd: string): CheckRun {
      const bash = bashLocation()
      if (!bash.ok) {
        return { done: Promise.resolve({ kind: 'failed', message: bash.message }), kill: () => {} }
      }

      let settle: (result: CheckResult) => void = () => {}
      const done = new Promise<CheckResult>((resolve) => {
        settle = resolve
      })

      let child: ReturnType<typeof spawn>
      try {
        // Its own process group, so stopping a check stops what it started
        // rather than orphaning a tree of children.
        child = spawn(bash.path, ['-c', command], {
          cwd,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch (cause) {
        return {
          done: Promise.resolve({
            kind: 'failed',
            message: cause instanceof Error ? cause.message : String(cause)
          }),
          kill: () => {}
        }
      }

      let output = ''
      let stderr = ''
      let ended = false
      let killed = false

      function end(result: CheckResult): void {
        if (ended) return
        ended = true
        settle(result)
      }

      // Both streams land in `output` in arrival order — what the person
      // watching a shell would have seen — while `stderr` keeps its own copy,
      // because that is the one the breaking rule reads.
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        if (output.length < MAX_OUTPUT) output += chunk
      })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        if (output.length < MAX_OUTPUT) output += chunk
        if (stderr.length < MAX_OUTPUT) stderr += chunk
      })

      child.on('error', (cause: Error) => {
        end({ kind: 'failed', message: cause.message })
      })

      child.on('close', (code, signal) => {
        if (killed) return end({ kind: 'killed' })
        // A signalled process never finished, so it has no status to report;
        // the check that never answered is one that failed to run to an exit.
        if (signal !== null || code === null) {
          end({ kind: 'failed', message: `the check was killed by ${signal ?? 'a signal'}` })
          return
        }
        end({ kind: 'exited', exitCode: code, output, stderr })
      })

      return {
        done,
        kill(): void {
          if (ended || killed) return
          killed = true
          if (child.pid !== undefined) killTree(child.pid)
          // A process that never got a pid is already over as far as anybody
          // waiting on it is concerned.
          else end({ kind: 'killed' })
        }
      }
    }
  }
}
