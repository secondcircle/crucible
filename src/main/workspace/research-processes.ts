import { spawn } from 'node:child_process'
import { killTree } from '../platform/exec'

// Not the board collector's runner: that one collapses every way a process can
// fail into one failure, and only ever captures a process that finished.

/** The command every research call runs. Resolved on PATH, never a path. */
export const RESEARCH_COMMAND = 'firecrawl'

/** What one research process did. Never a throw. */
export type ProcessOutcome =
  /** Never started: nothing by that name on PATH. */
  | { readonly kind: 'noBinary' }
  | {
      readonly kind: 'exited'
      readonly code: number
      readonly stdout: string
      readonly stderr: string
    }
  | { readonly kind: 'timedOut'; readonly stdout: string; readonly stderr: string }
  /** Ended by `cancel`, which is the user's Cancel or a superseding attempt. */
  | { readonly kind: 'cancelled' }
  /** Any other spawn failure, in the OS's words. */
  | { readonly kind: 'failed'; readonly reason: string }

export interface ResearchAttempt {
  /** Settles when the process ends, however it ends. */
  readonly finished: Promise<ProcessOutcome>
  /** Kills it. `finished` then settles `cancelled`. */
  cancel(): void
}

export interface ResearchProcesses {
  /** Runs the CLI to completion under a timeout: status and log-out. */
  capture(args: readonly string[], timeoutMs: number): Promise<ProcessOutcome>
  /** Starts a login and streams what it prints: the one call a person waits on. */
  begin(args: readonly string[], onOutput: (chunk: string) => void): ResearchAttempt
}

/**
 * The child environment for every research call: the parent's, minus every
 * `FIRECRAWL_*` variable, so the CLI can only use its own stored credential.
 */
export function researchEnv(
  parent: Readonly<Record<string, string | undefined>>
): Record<string, string | undefined> {
  const child: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(parent)) {
    // The whole prefix rather than a list of names: Crucible sets none of these,
    // and what the CLI reads a credential from can grow without warning.
    if (name.startsWith('FIRECRAWL_')) continue
    child[name] = value
  }
  return child
}

/** ENOENT off a spawn is the one failure that means "not installed". */
function missingBinary(cause: unknown): boolean {
  return (cause as { code?: unknown })?.code === 'ENOENT'
}

function reasonFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function createResearchProcesses(
  command: string = RESEARCH_COMMAND
): ResearchProcesses {
  return {
    capture(args: readonly string[], timeoutMs: number): Promise<ProcessOutcome> {
      return new Promise<ProcessOutcome>((resolve) => {
        const child = spawn(command, [...args], {
          env: researchEnv(process.env),
          stdio: ['ignore', 'pipe', 'pipe']
        })

        let stdout = ''
        let stderr = ''
        let settled = false
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => (stdout += chunk))
        child.stderr.on('data', (chunk: string) => (stderr += chunk))

        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          child.kill('SIGKILL')
          resolve({ kind: 'timedOut', stdout, stderr })
        }, timeoutMs)

        function settle(outcome: ProcessOutcome): void {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(outcome)
        }

        child.on('error', (cause: Error) => {
          settle(
            missingBinary(cause)
              ? { kind: 'noBinary' }
              : { kind: 'failed', reason: reasonFor(cause) }
          )
        })

        child.on('close', (code, signal) => {
          // A signalled process never exited; nothing about it is an exit code.
          if (signal !== null) {
            settle({ kind: 'failed', reason: `firecrawl was killed by ${signal}` })
            return
          }
          settle({ kind: 'exited', code: code ?? 0, stdout, stderr })
        })
      })
    },

    begin(args: readonly string[], onOutput: (chunk: string) => void): ResearchAttempt {
      // Its own process group: the browser login starts a helper to open the
      // browser, and cancelling has to take the whole tree with it.
      const child = spawn(command, [...args], {
        env: researchEnv(process.env),
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let cancelled = false
      let settled = false
      let stdout = ''
      let stderr = ''
      let settle: (outcome: ProcessOutcome) => void = () => {}

      const finished = new Promise<ProcessOutcome>((resolve) => {
        settle = (outcome) => {
          if (settled) return
          settled = true
          resolve(outcome)
        }
      })

      // Both streams reach the dialog in arrival order, which is what a person
      // watching the same command in a terminal would have seen.
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding('utf8')
        stream.on('data', (chunk: string) => {
          if (stream === child.stdout) stdout += chunk
          else stderr += chunk
          onOutput(chunk)
        })
      }

      child.on('error', (cause: Error) => {
        if (cancelled) {
          settle({ kind: 'cancelled' })
          return
        }
        settle(
          missingBinary(cause)
            ? { kind: 'noBinary' }
            : { kind: 'failed', reason: reasonFor(cause) }
        )
      })

      child.on('close', (code, signal) => {
        if (cancelled) {
          settle({ kind: 'cancelled' })
          return
        }
        if (signal !== null) {
          settle({ kind: 'failed', reason: `firecrawl was killed by ${signal}` })
          return
        }
        settle({ kind: 'exited', code: code ?? 0, stdout, stderr })
      })

      return {
        finished,
        cancel(): void {
          cancelled = true
          if (child.pid !== undefined) killTree(child.pid)
          settle({ kind: 'cancelled' })
        }
      }
    }
  }
}
