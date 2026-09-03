import { assembleDesktopApp } from './assemble'
import { parseAssembleRequest } from './assemble-request'

// The assembler as a process of its own. The installed app runs this to lay a
// staged update into its bundle: the copy is synchronous file work on a few
// hundred megabytes, and on the main thread it froze the window for as long
// as it took. One argument, the request as JSON; a failure is its message on
// stderr and a non-zero exit.

async function main(): Promise<void> {
  const installed = await assembleDesktopApp(parseAssembleRequest(process.argv[2]))
  process.stdout.write(`${installed.version} ${installed.bundleRoot}\n`)
}

void main().catch((cause: unknown) => {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`)
  process.exitCode = 1
})
