import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { npmSpawn, type MachineNpmView } from './npm-spawn'

// Fetching a version onto disk, outside the bundle, with npm doing the work:
// Node is a stated prerequisite of the installed app, and the Mac PATH
// prepend already makes npm reachable from a Dock launch. *How* npm is
// invoked is a per-platform fact and lives behind this seam, in `npmSpawn`.

export interface UpdateStager {
  /** Stages that version and answers the tree the assembler is handed. */
  stage(version: string): Promise<string>
}

/**
 * Set while a staging install runs, so the staged package's own postinstall —
 * the desktop assembler — does not install a second app from under here.
 * Install scripts stay on: electron's is what downloads the platform binary.
 */
export const STAGING_VARIABLE = 'CRUCIBLE_UPDATE_STAGING'

/** Long enough for a cold dependency tree on a slow line. */
const TIMEOUT_MS = 10 * 60 * 1000

export function npmStager(options: {
  readonly packageName: string
  /** One staging root per app, under the app's own state directory. */
  readonly root: string
  /** The machine npm is looked for on. Injected whole, so it is testable. */
  readonly machine?: MachineNpmView
  readonly run?: (
    command: string,
    args: readonly string[],
    context: { readonly cwd: string; readonly env: Record<string, string | undefined> }
  ) => Promise<void>
}): UpdateStager {
  const run = options.run ?? execFileRun
  const machine = options.machine ?? thisMachine()

  return {
    async stage(version: string): Promise<string> {
      // Asked before anything is cleared: a machine with no npm to find leaves
      // whatever was staged last alone, and says why into the run log.
      const spawn = npmSpawn(
        [
          'install',
          `${options.packageName}@${version}`,
          '--prefix',
          options.root,
          '--no-audit',
          '--no-fund'
        ],
        machine
      )
      if (!spawn.ok) throw new Error(spawn.message)

      // Cleared before every staging, so successive versions never accumulate
      // dependency trees in a directory nobody looks at. Off the loop: the
      // cost is one syscall per file in the last staged tree, tens of
      // thousands of them, and this runs in the app the human is using.
      await rm(options.root, { recursive: true, force: true })
      await mkdir(options.root, { recursive: true })
      await run(spawn.command, spawn.args, {
        cwd: options.root,
        env: { ...process.env, ...spawn.env, [STAGING_VARIABLE]: '1' }
      })
      return options.root
    }
  }
}

function thisMachine(): MachineNpmView {
  return {
    platform: process.platform,
    path: process.env.PATH ?? '',
    exists: existsSync,
    // Electron's own binary, which is Node whenever `ELECTRON_RUN_AS_NODE` is
    // set. The installed app therefore needs no `node` on PATH to run npm's
    // code, only an npm on disk to point at.
    node: process.execPath
  }
}

function execFileRun(
  command: string,
  args: readonly string[],
  context: { readonly cwd: string; readonly env: Record<string, string | undefined> }
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const options = { cwd: context.cwd, env: context.env, timeout: TIMEOUT_MS }
    execFile(command, [...args], options, (failure, _stdout, stderr) => {
      if (failure === null) {
        resolve()
        return
      }
      reject(new Error(`${command} ${args.join(' ')} failed: ${stderr || failure.message}`))
    })
  })
}
