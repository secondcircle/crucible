import { STAGING_VARIABLE } from '../app-update/stager'
import { assembleDesktopApp, assemblesInThisTree } from './assemble'
import { readPackageIdentity } from './package-json'

// What `npm install -g @scope/crucible` leaves behind: a real desktop app.
// npm runs this from the installed package's own directory, which is exactly
// the tree the assembler wants. In a repo checkout — told apart by the `src/`
// the published tarball lacks — it does nothing at all: `npm ci` here must
// never install anything to the machine.

async function main(): Promise<void> {
  const tree = process.cwd()
  if (!assemblesInThisTree(tree)) return
  // The installed app staged this copy to update itself with. It assembles
  // into the bundle it is running from, on its own terms; deriving a location
  // here would install a second app nobody asked for.
  if (process.env[STAGING_VARIABLE] === '1') return

  const installed = await assembleDesktopApp({
    tree,
    packageName: readPackageIdentity(tree).name
  })
  process.stdout.write(
    `Crucible ${installed.version} is installed at ${installed.bundleRoot}.\n` +
      (installed.launcher === undefined
        ? 'Open it from Applications or the Dock.\n'
        : `Open it from ${installed.launcher}.\n`)
  )
}

void main().catch((cause: unknown) => {
  // A failed desktop install must not fail the npm install itself: the package
  // is on disk and the person can say what happened. Exit zero, say plainly
  // what did not happen.
  process.stdout.write(
    `Crucible was installed as a package, but could not assemble the desktop app: ${
      cause instanceof Error ? cause.message : String(cause)
    }\n`
  )
})
