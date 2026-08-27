import { spawn } from 'node:child_process'

// Running a command and keeping everything it said, which is what both
// worktree mechanisms need: stdout alone for the one line a contract parses,
// stdout and stderr interleaved for the person who has to fix a failure.

export interface Ran {
  /** The process's own status, or absent when it never got to exit. */
  readonly code?: number
  readonly signal?: string
  /** stdout alone, which is where a contract's reported path is. */
  readonly stdout: string
  /** stdout and stderr interleaved, as a person watching would have seen. */
  readonly output: string
}

export interface CaptureOptions {
  readonly cwd?: string
  /** Extra environment on top of Crucible's own; absent means inherit it. */
  readonly env?: Readonly<Record<string, string>>
}

/** The first line of a failure: what was run, and how it ended. */
export function headline(what: string, ran: Ran): string {
  if (ran.signal !== undefined) return `${what} was killed by ${ran.signal}`
  if (ran.code === undefined) return `${what} could not be run`
  return `${what} exited ${ran.code}`
}

// No timeout and no kill: the script owns how long it takes, and a run that
// never ends is the repository's own problem to see.
export function capture(
  command: string,
  args: readonly string[],
  options: CaptureOptions = {}
): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let output = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      output += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      output += chunk
    })

    let settled = false
    function settle(ran: Ran): void {
      if (settled) return
      settled = true
      resolve(ran)
    }

    child.on('error', (cause: Error) => {
      settle({ stdout, output: `${output}${cause.message}\n` })
    })
    child.on('close', (code, signal) => {
      settle({
        stdout,
        output,
        ...(signal === null ? {} : { signal }),
        ...(code === null ? {} : { code })
      })
    })
  })
}

/** The last non-empty line, trimmed: the contract's one piece of parsing. */
export function lastLine(stdout: string): string | undefined {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  return lines.at(-1)
}
