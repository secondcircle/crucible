// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installCrucibleCommand, shimText } from './shim'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the crucible command on an agent’s PATH', () => {
  it('runs the runner under Electron-as-Node with the library and state it needs', () => {
    const text = shimText({ execPath: '/A p/Electron', script: '/out/rules-cli.js', libDir: '/lib', stateDir: "/st'ate" }, 'darwin')
    expect(text).toContain("ELECTRON_RUN_AS_NODE=1 CRUCIBLE_RULE_LIB='/lib' CRUCIBLE_STATE_DIR='/st'\\''ate'")
    expect(text).toContain(`exec '/A p/Electron' '/out/rules-cli.js' "$@"`)
    expect(shimText({ execPath: 'C:\\e.exe', script: 'C:\\c.js', libDir: 'L', stateDir: 'S' }, 'win32')).toContain(
      '"C:\\e.exe" "C:\\c.js" %*'
    )
  })

  it('is found first on PATH, once, and runs', () => {
    const bin = mkdtempSync(join(tmpdir(), 'crucible-bin-'))
    scratch.push(bin)
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' }
    const target = { execPath: process.execPath, script: '-e', libDir: '/lib', stateDir: '/state' }
    installCrucibleCommand(bin, { ...target, script: join(bin, 'echo.js') }, env, 'darwin')
    installCrucibleCommand(bin, { ...target, script: join(bin, 'echo.js') }, env, 'darwin')
    expect(env.PATH).toBe(`${bin}:/usr/bin:/bin`)
    execFileSync('sh', ['-c', `printf 'console.log(process.env.CRUCIBLE_RULE_LIB, process.argv.slice(2).join(" "))' > ${join(bin, 'echo.js')}`])
    expect(execFileSync('crucible', ['rules', 'test', 'comments'], { env, encoding: 'utf8' }).trim()).toBe('/lib rules test comments')
  })
})
