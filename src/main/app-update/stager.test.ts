// @vitest-environment node
//
// The stager against a real staging directory and a recorded spawn: what it
// asks npm for, on which machine, and what it does to the directory when
// there is no npm to ask.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { npmStager, STAGING_VARIABLE } from './stager'
import type { MachineNpmView } from './npm-spawn'

const NAME = '@secondcircle/crucible'

let root: string
let ran: Array<{
  command: string
  args: readonly string[]
  context: { cwd: string; env: Record<string, string | undefined> }
}>

beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), 'crucible-stager-')), 'update-staging')
  ran = []
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const record = async (
  command: string,
  args: readonly string[],
  context: { readonly cwd: string; readonly env: Record<string, string | undefined> }
): Promise<void> => {
  ran.push({ command, args, context: { cwd: context.cwd, env: context.env } })
}

const posixMachine: MachineNpmView = {
  platform: 'linux',
  path: '/usr/bin:/bin',
  exists: () => false,
  node: '/home/you/.local/opt/crucible/crucible'
}

describe('staging a version', () => {
  it('installs it into the app’s own staging root and answers that tree', async () => {
    const stager = npmStager({ packageName: NAME, root, machine: posixMachine, run: record })

    const tree = await stager.stage('1.6.0')

    expect(tree).toBe(root)
    expect(ran).toHaveLength(1)
    expect(ran[0].command).toBe('npm')
    expect(ran[0].args).toEqual([
      'install',
      `${NAME}@1.6.0`,
      '--prefix',
      root,
      '--no-audit',
      '--no-fund'
    ])
    // The staged package's own postinstall is the assembler, and it must not
    // install a second app of its own from under here.
    expect(ran[0].context.env[STAGING_VARIABLE]).toBe('1')
  })

  it('clears the root first, so versions never pile up in it', async () => {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'from-1.5.0'), 'last time')

    await npmStager({ packageName: NAME, root, machine: posixMachine, run: record }).stage('1.6.0')

    expect(existsSync(join(root, 'from-1.5.0'))).toBe(false)
    expect(existsSync(root)).toBe(true)
  })
})

describe('staging on a Windows install', () => {
  // Where a bare `npm` spawn cannot work at all: npm is a batch shim there.
  // The stager runs npm's own code under electron's binary as Node, so the
  // background install cannot fail silently forever.
  const NODEJS = 'C:\\Program Files\\nodejs'
  const CLI = `${NODEJS}\\node_modules\\npm\\bin\\npm-cli.js`
  const machine = (over: Partial<MachineNpmView> = {}): MachineNpmView => ({
    platform: 'win32',
    path: `C:\\Windows\\system32;${NODEJS}`,
    exists: (path) => path === `${NODEJS}\\npm.cmd` || path === CLI,
    node: 'C:\\Users\\First Last\\AppData\\Local\\Programs\\Crucible\\Crucible.exe',
    ...over
  })

  it('spawns node with npm’s cli, not a name Node cannot resolve', async () => {
    await npmStager({ packageName: NAME, root, machine: machine(), run: record }).stage('1.6.0')

    expect(ran[0].command).toBe(
      'C:\\Users\\First Last\\AppData\\Local\\Programs\\Crucible\\Crucible.exe'
    )
    expect(ran[0].args[0]).toBe(CLI)
    expect(ran[0].args).toContain(`${NAME}@1.6.0`)
    expect(ran[0].context.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(ran[0].context.env[STAGING_VARIABLE]).toBe('1')
  })

  it('says why and leaves the staging root alone when npm cannot be found', async () => {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'from-1.5.0'), 'last time')
    const stager = npmStager({
      packageName: NAME,
      root,
      machine: machine({ exists: () => false }),
      run: record
    })

    await expect(stager.stage('1.6.0')).rejects.toThrow(/could not find npm/)
    expect(ran).toEqual([])
    // Nothing spawned, nothing destroyed: the service logs this and the next
    // check retries.
    expect(existsSync(join(root, 'from-1.5.0'))).toBe(true)
  })
})
