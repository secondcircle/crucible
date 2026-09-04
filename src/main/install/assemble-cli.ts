// Before anything touches the file system. Under Electron's utilityProcess
// `fs` is patched to read an `.asar` as a directory, and the assembler moves
// electron's own `default_app.asar` about as the file it is: patched, the
// removal failed with EISDIR and a copy would have unpacked the archive.
// Plain node, postinstall's case, has no such switch and ignores it.
process.noAsar = true

import { assembleDesktopApp } from './assemble'
import { parseAssembleRequest } from './assemble-request'

// The assembler as a process of its own. The installed app runs this to lay a
// staged update into its bundle: the copy is synchronous file work on a few
// hundred megabytes, and on the main thread it froze the window for as long
// as it took. One argument, the request as JSON; a failure is its message on
// stderr and a non-zero exit.
//
// The exit is explicit, and only after the last write has drained. Under
// Electron's utilityProcess a script that merely finishes does not end its
// process — the child sat there until the updater's timeout killed it, and
// its verdict, success or failure, went with it.

async function main(): Promise<void> {
  const installed = await assembleDesktopApp(parseAssembleRequest(process.argv[2]))
  await new Promise<void>((done) => {
    process.stdout.write(`${installed.version} ${installed.bundleRoot}\n`, () => done())
  })
  process.exit(0)
}

void main().catch((cause: unknown) => {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`, () => {
    process.exit(1)
  })
})
