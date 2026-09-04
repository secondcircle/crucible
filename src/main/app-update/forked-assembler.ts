import type { AssembleRequest } from '../install/assemble'

// Assembly of a staged update, run in a process of its own. The assembler is
// synchronous file work over the whole Electron distribution, and inline in
// the main process it held the event loop, and so the window, for the whole
// copy. Here main only waits on an exit code.

/** Long enough for a slow disk; a copy still going after this has hung. */
export const ASSEMBLE_TIMEOUT_MS = 10 * 60 * 1000

/** The little of a child process this needs, which is what utilityProcess gives. */
export interface ForkedChild {
  readonly stdout?: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null
  readonly stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null
  on(event: 'exit', listener: (code: number) => void): void
  /** A child that died of a fatal error, in utilityProcess's own terms. */
  on(event: 'error', listener: (type: string, location: string, report: string) => void): void
  kill(): boolean
}

export type Fork = (script: string, args: readonly string[]) => ForkedChild

export interface ForkedAssemblerOptions {
  /** The built assembler entry: `out/main/assemble-cli.js` in the running bundle. */
  readonly script: string
  readonly packageName: string
  /** Electron's `utilityProcess.fork`, or a stand-in. */
  readonly fork: Fork
  readonly timeoutMs?: number
}

export function forkedAssembler({
  script,
  packageName,
  fork,
  timeoutMs = ASSEMBLE_TIMEOUT_MS
}: ForkedAssemblerOptions): (tree: string, target: string) => Promise<void> {
  return (tree, target) =>
    new Promise<void>((resolve, reject) => {
      const request: AssembleRequest = { tree, packageName, target }
      const child = fork(script, [JSON.stringify(request)])
      let said = ''
      let settled = false

      child.stderr?.on('data', (chunk) => {
        said += chunk.toString()
      })
      // Piped, so it has to be read, or a child that says enough would block
      // on a full pipe; what it says on success is of no interest here.
      child.stdout?.on('data', () => {})

      const timer = setTimeout(() => {
        settle(() => {
          child.kill()
          reject(new Error(`Assembling the update took longer than ${timeoutMs / 1000}s.`))
        })
      }, timeoutMs)

      function settle(how: () => void): void {
        if (settled) return
        settled = true
        clearTimeout(timer)
        how()
      }

      child.on('error', (type, location) => {
        settle(() => reject(new Error(`Crucible\u2019s assembler failed: ${type} at ${location}.`)))
      })

      child.on('exit', (code) => {
        settle(() => {
          if (code === 0) resolve()
          else {
            const reason = said.trim()
            reject(
              new Error(reason === '' ? `The assembler exited with code ${code}.` : reason)
            )
          }
        })
      })
    })
}
