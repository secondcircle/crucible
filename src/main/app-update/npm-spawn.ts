import { win32 } from 'node:path'
import { findOnWindowsPath, type PathView } from '../platform/path-lookup'

// How to run npm on this machine, as a pure function over a view of it: a
// per-platform fact that cannot be exercised on the machine that writes it.
//
// On Windows npm is a batch shim Node will neither resolve on PATH nor spawn
// without a shell, so the shim is read only for where it says npm's code is,
// and that code runs under this process's own binary as Node — no shell, and
// so no quoting of the staging path.

export interface MachineNpmView extends PathView {
  readonly platform: NodeJS.Platform
  /**
   * The executable that runs a JavaScript file as Node. Electron's own binary
   * does when `ELECTRON_RUN_AS_NODE` is set, so this needs no `node` on PATH.
   */
  readonly node: string
}

export type NpmSpawn =
  | {
      readonly ok: true
      readonly command: string
      readonly args: readonly string[]
      /** Merged into the child's environment. Empty off Windows. */
      readonly env: Readonly<Record<string, string>>
    }
  /** Said by whoever wanted npm run; the next check retries. */
  | { readonly ok: false; readonly message: string }

const NOT_FOUND =
  'Crucible stages an update with npm and could not find npm on this machine. ' +
  'Install Node.js (https://nodejs.org) and make sure npm is on PATH.'

/** npm's own code, relative to the directory its bin shim sits in. */
const CLI = ['node_modules', 'npm', 'bin', 'npm-cli.js']

export function npmSpawn(args: readonly string[], view: MachineNpmView): NpmSpawn {
  // Mac and Linux ship npm as an extensionless script with a shebang, which
  // POSIX execs directly. Nothing to discover.
  if (view.platform !== 'win32') return { ok: true, command: 'npm', args, env: {} }

  // A real executable is spawnable as it stands: version managers that shim
  // npm (volta, and anything else that compiles its shims) install an .exe.
  const exe = findOnWindowsPath('npm.exe', view)
  if (exe !== undefined) return { ok: true, command: exe, args, env: {} }

  // Otherwise the batch shim, read for its directory alone. That directory is
  // npm's install prefix, and npm's own code sits under it: the Node.js
  // installer's `C:\Program Files\nodejs`, nvm-windows' version directory,
  // and the `%APPDATA%\npm` an `npm install -g npm` writes all have this
  // shape.
  const shim = findOnWindowsPath('npm.cmd', view)
  if (shim !== undefined) {
    const cli = win32.join(win32.dirname(shim), ...CLI)
    if (view.exists(cli)) {
      return {
        ok: true,
        command: view.node,
        args: [cli, ...args],
        env: { ELECTRON_RUN_AS_NODE: '1' }
      }
    }
  }

  return { ok: false, message: NOT_FOUND }
}
