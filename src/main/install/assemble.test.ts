// @vitest-environment node
//
// The assembler against a tree written for it: a package, its dependencies and
// a stand-in electron dist. What the real thing does that this cannot is
// download a binary and launch it; what it decides is all here.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assembleDesktopApp, assemblesInThisTree, type Machine } from './assemble'

const NAME = '@secondcircle/crucible'

let root: string
let home: string
let ran: Array<{ command: string; args: readonly string[] }>

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** The updater's tree shape: the package under a staging prefix. */
function staging(version: string, platform: NodeJS.Platform): string {
  const tree = join(root, 'staging')
  const packageDir = join(tree, 'node_modules', '@secondcircle', 'crucible')
  write(join(packageDir, 'package.json'), JSON.stringify({ name: NAME, version }))
  write(join(packageDir, 'out', 'main', 'index.js'), `// version ${version}\n`)
  write(join(packageDir, 'resources', 'prompts', 'standing.md'), 'standing\n')
  write(join(packageDir, 'build', 'icon.png'), 'png bytes')
  write(join(packageDir, 'build', 'icon.icns'), 'icns bytes')

  const modules = join(tree, 'node_modules')
  write(join(modules, 'react', 'index.js'), 'module.exports = {}\n')
  write(join(modules, '@earendil-works', 'pi-ai', 'index.js'), 'module.exports = {}\n')
  write(join(modules, '.package-lock.json'), '{}')

  const dist = join(modules, 'electron', 'dist')
  if (platform === 'darwin') {
    const app = join(dist, 'Electron.app', 'Contents')
    write(join(app, 'MacOS', 'Electron'), '#!/bin/sh\n')
    chmodSync(join(app, 'MacOS', 'Electron'), 0o755)
    write(
      join(app, 'Info.plist'),
      '<?xml version="1.0"?>\n<plist version="1.0">\n<dict>\n\t<key>CFBundleExecutable</key>\n\t<string>Electron</string>\n</dict>\n</plist>\n'
    )
    write(join(app, 'Resources', 'default_app.asar'), 'electron default app')
  } else {
    write(join(dist, platform === 'win32' ? 'electron.exe' : 'electron'), '#!/bin/sh\n')
    write(join(dist, 'resources', 'default_app.asar'), 'electron default app')
    write(join(dist, 'libffmpeg.so'), `binary ${version}`)
  }
  return tree
}

function machine(platform: NodeJS.Platform, over: Partial<Machine> = {}): Machine {
  return {
    platform,
    home,
    env: {},
    writable: () => true,
    run: async (command, args) => {
      ran.push({ command, args })
    },
    ...over
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crucible-assemble-'))
  home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  ran = []
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('assembling a desktop app on Linux', () => {
  it('builds the bundle the caller named, and registers a launcher entry', async () => {
    const tree = staging('1.5.0', 'linux')
    const target = join(root, 'opt', 'crucible')

    const outcome = await assembleDesktopApp({ tree, packageName: NAME, target }, machine('linux'))

    expect(outcome).toMatchObject({ bundleRoot: target, version: '1.5.0' })
    // The executable is not called electron, which is the whole of what makes
    // `app.isPackaged` true in the assembled app.
    expect(existsSync(join(target, 'crucible'))).toBe(true)
    expect(existsSync(join(target, 'electron'))).toBe(false)
    expect(statSync(join(target, 'crucible')).mode & 0o111).not.toBe(0)
    // Electron's own files ride along; its default app does not.
    expect(existsSync(join(target, 'libffmpeg.so'))).toBe(true)
    expect(existsSync(join(target, 'resources', 'default_app.asar'))).toBe(false)

    const app = join(target, 'resources', 'app')
    expect(readFileSync(join(app, 'out', 'main', 'index.js'), 'utf8')).toContain('1.5.0')
    expect(existsSync(join(app, 'resources', 'prompts', 'standing.md'))).toBe(true)
    // Dependencies come along, because the main bundle externalizes them.
    expect(existsSync(join(app, 'node_modules', 'react', 'index.js'))).toBe(true)
    expect(existsSync(join(app, 'node_modules', '@earendil-works', 'pi-ai', 'index.js'))).toBe(true)
    // Electron itself does not: inside Electron it is built in.
    expect(existsSync(join(app, 'node_modules', 'electron'))).toBe(false)
    expect(existsSync(join(app, 'node_modules', '.package-lock.json'))).toBe(false)

    const entry = join(home, '.local', 'share', 'applications', 'crucible.desktop')
    expect(outcome.launcher).toBe(entry)
    expect(readFileSync(entry, 'utf8')).toContain(`Exec="${join(target, 'crucible')}"`)
    expect(readFileSync(entry, 'utf8')).toContain(`Icon=${join(target, 'icon.png')}`)
    expect(existsSync(join(target, 'icon.png'))).toBe(true)
  })

  it('replaces the payload rather than merging into it', async () => {
    const tree = staging('1.5.0', 'linux')
    const target = join(root, 'opt', 'crucible')
    await assembleDesktopApp({ tree, packageName: NAME, target }, machine('linux'))
    const stale = join(target, 'resources', 'app', 'out', 'main', 'gone-in-1.6.js')
    writeFileSync(stale, 'from the old version')

    rmSync(join(root, 'staging'), { recursive: true, force: true })
    staging('1.6.0', 'linux')
    const outcome = await assembleDesktopApp(
      { tree, packageName: NAME, target },
      machine('linux')
    )

    expect(outcome.version).toBe('1.6.0')
    expect(readFileSync(join(target, 'resources', 'app', 'out', 'main', 'index.js'), 'utf8')).toContain(
      '1.6.0'
    )
    expect(existsSync(stale)).toBe(false)
  })
})

describe('assembling a desktop app on a Mac', () => {
  it('takes electron’s bundle, renames it, and signs it again', async () => {
    const tree = staging('1.5.0', 'darwin')
    const target = join(root, 'Applications', 'Crucible.app')

    await assembleDesktopApp({ tree, packageName: NAME, target }, machine('darwin'))

    expect(existsSync(join(target, 'Contents', 'MacOS', 'Crucible'))).toBe(true)
    expect(existsSync(join(target, 'Contents', 'MacOS', 'Electron'))).toBe(false)

    const plist = readFileSync(join(target, 'Contents', 'Info.plist'), 'utf8')
    expect(plist).toContain('<key>CFBundleExecutable</key>\n\t<string>Crucible</string>')
    expect(plist).toContain('<key>CFBundleIdentifier</key>\n\t<string>com.secondcircle.crucible</string>')
    expect(plist).toContain('<key>CFBundleShortVersionString</key>\n\t<string>1.5.0</string>')
    expect(existsSync(join(target, 'Contents', 'Resources', 'icon.icns'))).toBe(true)
    expect(existsSync(join(target, 'Contents', 'Resources', 'app', 'out', 'main', 'index.js'))).toBe(
      true
    )
    expect(existsSync(join(target, 'Contents', 'Resources', 'default_app.asar'))).toBe(false)

    // The bundle changed after electron signed it, and a Mac will not launch a
    // bundle whose signature no longer matches.
    expect(ran).toEqual([
      { command: 'codesign', args: ['--force', '--deep', '--sign', '-', target] }
    ])
  })
})

describe('the leftovers of a Windows swap', () => {
  // Windows locks the running executable and its loaded libraries, so a file
  // the assembler cannot replace is renamed beside itself. Those names are
  // swept at the start of the next run, once the process that held them has
  // exited — and at most one generation ever lingers.
  it('are swept before the next assembly, wherever in the bundle they sit', async () => {
    const tree = staging('1.5.0', 'linux')
    const target = join(root, 'opt', 'crucible')
    await assembleDesktopApp({ tree, packageName: NAME, target }, machine('linux'))
    write(join(target, 'crucible.crucible-old'), 'the previous executable')
    write(join(target, 'resources', 'app', 'out', 'old.js.crucible-old'), 'a previous module')

    await assembleDesktopApp({ tree, packageName: NAME, target }, machine('linux'))

    expect(existsSync(join(target, 'crucible.crucible-old'))).toBe(false)
    expect(existsSync(join(target, 'resources', 'app', 'out', 'old.js.crucible-old'))).toBe(false)
    expect(existsSync(join(target, 'crucible'))).toBe(true)
  })
})

describe('who decides where the app goes', () => {
  it('uses the caller’s target verbatim, deriving nothing', async () => {
    const tree = staging('1.5.0', 'linux')
    const target = join(root, 'somewhere', 'else')

    const outcome = await assembleDesktopApp(
      { tree, packageName: NAME, target },
      // A machine whose derived location would be somewhere quite different.
      machine('linux')
    )

    expect(outcome.bundleRoot).toBe(target)
    expect(existsSync(join(home, '.local', 'opt', 'crucible'))).toBe(false)
  })

  it('derives the platform’s install location only when given no target', async () => {
    const tree = staging('1.5.0', 'linux')

    const outcome = await assembleDesktopApp({ tree, packageName: NAME }, machine('linux'))

    expect(outcome.bundleRoot).toBe(join(home, '.local', 'opt', 'crucible'))
  })

  it('says so plainly when the tree holds no such package', async () => {
    await expect(
      assembleDesktopApp({ tree: root, packageName: NAME }, machine('linux'))
    ).rejects.toThrow(/could not find/)
  })
})

describe('what a global install must not drag along', () => {
  // npm's global node_modules holds every globally installed package side by
  // side — npm itself always among them. The walk up from the package to a
  // hoisted dependency root is the *staging* tree's shape; applied to the
  // global-install shape it makes the whole global prefix a dependency root,
  // and every unrelated global package is copied into the bundle.
  it('copies no sibling global packages into the bundle', async () => {
    // The global-install shape: the package directory itself, dependencies
    // nested under its own node_modules — exactly what postinstall hands in.
    const packageDir = join(root, 'global', 'node_modules', '@secondcircle', 'crucible')
    write(join(packageDir, 'package.json'), JSON.stringify({ name: NAME, version: '1.5.0' }))
    write(join(packageDir, 'out', 'main', 'index.js'), '// version 1.5.0\n')
    write(join(packageDir, 'node_modules', 'react', 'index.js'), 'module.exports = {}\n')
    write(join(packageDir, 'node_modules', 'electron', 'dist', 'electron'), '#!/bin/sh\n')
    // The neighbours every real global prefix has.
    write(join(root, 'global', 'node_modules', 'npm', 'index.js'), 'the package manager\n')
    write(
      join(root, 'global', 'node_modules', '@other-scope', 'tool', 'index.js'),
      'somebody else\n'
    )

    const target = join(root, 'opt', 'crucible')
    await assembleDesktopApp({ tree: packageDir, packageName: NAME, target }, machine('linux'))

    const modules = join(target, 'resources', 'app', 'node_modules')
    expect(existsSync(join(modules, 'react'))).toBe(true)
    expect(existsSync(join(modules, 'npm'))).toBe(false)
    expect(existsSync(join(modules, '@other-scope'))).toBe(false)
  })
})

describe('a refresh that cannot remove everything first', () => {
  // Windows holds files the running app has loaded against delete, yet the
  // assembler must still leave the bundle holding the new version. A
  // dependency that survived the failed removal must therefore still be
  // refreshed — skipping it because it "already exists" reads last version's
  // leftovers as this run's own work. Reproduced here with a directory the
  // removal cannot delete, which is what a locked file does to `rmSync`.
  it('still refreshes a dependency the removal left behind', async () => {
    const tree = staging('1.5.0', 'linux')
    const modules = join(root, 'staging', 'node_modules')
    write(join(modules, 'react', 'index.js'), '// react as of 1.5.0\n')
    const target = join(root, 'opt', 'crucible')
    await assembleDesktopApp({ tree, packageName: NAME, target }, machine('linux'))

    rmSync(join(root, 'staging'), { recursive: true, force: true })
    staging('1.6.0', 'linux')
    write(join(modules, 'react', 'index.js'), '// react as of 1.6.0\n')

    // The bundle's node_modules cannot have entries removed (as a locked file
    // forbids on Windows), though every file inside them can still be written.
    const bundled = join(target, 'resources', 'app', 'node_modules')
    chmodSync(bundled, 0o555)
    try {
      await assembleDesktopApp({ tree, packageName: NAME, target }, machine('linux'))
      expect(readFileSync(join(bundled, 'react', 'index.js'), 'utf8')).toContain('1.6.0')
    } finally {
      chmodSync(bundled, 0o755)
    }
  })
})

describe('a leftover the sweep cannot delete yet', () => {
  // A `.crucible-old` name still held by the old process unlocks only when
  // that process exits. Until then the sweep must step past it, not fail the
  // assembly: a second update published before the user restarts would
  // otherwise never land. `rmSync`'s `force` ignores only a missing path,
  // not a delete the OS refuses.
  it('does not fail the assembly', async () => {
    const tree = staging('1.5.0', 'linux')
    const target = join(root, 'opt', 'crucible')
    await assembleDesktopApp({ tree, packageName: NAME, target }, machine('linux'))

    // A leftover that cannot be deleted: its contents cannot be unlinked,
    // which is Windows' locked-executable refusal in POSIX terms.
    const held = join(target, 'held.crucible-old')
    write(join(held, 'still-running'), 'the old executable')
    chmodSync(held, 0o555)
    try {
      const outcome = await assembleDesktopApp(
        { tree, packageName: NAME, target },
        machine('linux')
      )
      expect(outcome.version).toBe('1.5.0')
    } finally {
      chmodSync(held, 0o755)
    }
  })
})

describe('a refresh under a running app', () => {
  // The refresh happens under a running app, which has the shell's libraries
  // mmap'd. Replacing such a file is safe — an unlink leaves the old inode to
  // the process that holds it — but writing through it rewrites the very
  // bytes the app is executing: SIGBUS, or two versions interleaved in one
  // process. A new inode at the same path is the observable fact of a safe
  // refresh.
  it('replaces the shell’s files rather than writing through them', async () => {
    const tree = staging('1.5.0', 'linux')
    const target = join(root, 'opt', 'crucible')
    await assembleDesktopApp({ tree, packageName: NAME, target }, machine('linux'))
    const mapped = join(target, 'libffmpeg.so')
    const before = statSync(mapped).ino

    rmSync(join(root, 'staging'), { recursive: true, force: true })
    staging('1.6.0', 'linux')
    await assembleDesktopApp({ tree, packageName: NAME, target }, machine('linux'))

    expect(readFileSync(mapped, 'utf8')).toBe('binary 1.6.0')
    expect(statSync(mapped).ino).not.toBe(before)
  })
})

describe('postinstall’s one rule', () => {
  it('assembles nothing in a tree that has src/', () => {
    mkdirSync(join(root, 'checkout', 'src'), { recursive: true })

    expect(assemblesInThisTree(join(root, 'checkout'))).toBe(false)
    expect(assemblesInThisTree(join(root, 'staging'))).toBe(true)
  })
})
