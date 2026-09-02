// @vitest-environment node
//
// How npm is run, per OS, decided from a view of the machine rather than from
// the machine this runs on — because the machine this runs on is never the
// one the decision is hard for.
import { describe, expect, it } from 'vitest'
import { npmSpawn, type MachineNpmView } from './npm-spawn'

const ARGS = ['install', '@secondcircle/crucible@1.6.0', '--prefix', 'C:\\Users\\First Last\\stage']

function view(over: Partial<MachineNpmView> = {}): MachineNpmView {
  return {
    platform: 'darwin',
    path: '/usr/bin:/bin',
    exists: () => false,
    node: '/Applications/Crucible.app/Contents/MacOS/Crucible',
    ...over
  }
}

const held =
  (...paths: string[]) =>
  (path: string) =>
    paths.includes(path)

describe('npm on a Mac and on Linux', () => {
  it('is npm, as PATH gives it: a shebang script POSIX execs', () => {
    expect(npmSpawn(ARGS, view())).toEqual({ ok: true, command: 'npm', args: ARGS, env: {} })
    expect(npmSpawn(ARGS, view({ platform: 'linux' }))).toEqual({
      ok: true,
      command: 'npm',
      args: ARGS,
      env: {}
    })
  })
})

describe('npm on Windows', () => {
  // The whole point: `npm` there is `npm.cmd`, a batch shim Node will not
  // spawn — `spawn npm ENOENT` without a shell, `EINVAL` with the .cmd named.
  // So the shim is read for where it says npm's code is, and npm's code runs
  // under the Node this process already is.
  const NODEJS = 'C:\\Program Files\\nodejs'
  const CLI = `${NODEJS}\\node_modules\\npm\\bin\\npm-cli.js`
  const windows = (over: Partial<MachineNpmView> = {}): MachineNpmView =>
    view({
      platform: 'win32',
      path: `C:\\Windows\\system32;${NODEJS}`,
      node: 'C:\\Users\\First Last\\AppData\\Local\\Programs\\Crucible\\Crucible.exe',
      ...over
    })

  it('runs npm’s own code under electron’s node, naming no shell', () => {
    const spawn = npmSpawn(ARGS, windows({ exists: held(`${NODEJS}\\npm.cmd`, CLI) }))

    expect(spawn).toEqual({
      ok: true,
      command: 'C:\\Users\\First Last\\AppData\\Local\\Programs\\Crucible\\Crucible.exe',
      args: [CLI, ...ARGS],
      // Which is what makes electron's binary plain Node, so no `node` on
      // PATH is needed and no argument is ever handed to cmd.exe to re-quote.
      env: { ELECTRON_RUN_AS_NODE: '1' }
    })
  })

  it('never asks Node to spawn a batch file', () => {
    const spawn = npmSpawn(ARGS, windows({ exists: held(`${NODEJS}\\npm.cmd`, CLI) }))

    expect(spawn.ok && spawn.command.toLowerCase()).not.toMatch(/\.(cmd|bat)$/)
    expect(spawn.ok && spawn.args.some((argument) => /\.(cmd|bat)$/i.test(argument))).toBe(false)
  })

  it('finds npm wherever on PATH it sits, first entry winning', () => {
    const appdata = 'C:\\Users\\First Last\\AppData\\Roaming\\npm'
    const spawn = npmSpawn(
      ARGS,
      windows({
        // An `npm install -g npm` puts a newer npm ahead of the installer's.
        path: `"${appdata}";C:\\Windows\\system32;${NODEJS}`,
        exists: held(
          `${appdata}\\npm.cmd`,
          `${appdata}\\node_modules\\npm\\bin\\npm-cli.js`,
          `${NODEJS}\\npm.cmd`,
          CLI
        )
      })
    )

    expect(spawn.ok && spawn.args[0]).toBe(`${appdata}\\node_modules\\npm\\bin\\npm-cli.js`)
  })

  it('spawns a real npm.exe directly, where a version manager installed one', () => {
    const volta = 'C:\\Users\\First Last\\AppData\\Local\\Volta\\bin'
    const spawn = npmSpawn(
      ARGS,
      windows({ path: volta, exists: held(`${volta}\\npm.exe`) })
    )

    expect(spawn).toEqual({ ok: true, command: `${volta}\\npm.exe`, args: ARGS, env: {} })
  })

  it('says what is missing and where to get it, rather than spawning a hope', () => {
    // A shim with no npm beside it: nothing here to run.
    const orphan = npmSpawn(ARGS, windows({ exists: held(`${NODEJS}\\npm.cmd`) }))
    expect(orphan.ok).toBe(false)

    const nothing = npmSpawn(ARGS, windows())
    expect(nothing.ok).toBe(false)
    // The staging failure carries this into the run log, where §4.3 leaves it.
    expect(nothing.ok === false && nothing.message).toContain('Node.js')
  })
})
