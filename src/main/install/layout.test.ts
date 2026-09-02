// @vitest-environment node
//
// Every decision the assembler makes, per platform string, from a Mac. None of
// these can be proved by running an install here: a Mac cannot install on
// Windows, and a test that waited for `%LOCALAPPDATA%` to exist would prove
// nothing about the rule.
import { describe, expect, it } from 'vitest'
import {
  assemblesFromHere,
  bundleLayout,
  bundleRootFromExecutable,
  bundleRootFor,
  copiedDependency,
  deriveBundleRoot,
  desktopEntry,
  distExecutable,
  isRenamedAside,
  launcherPath,
  plistWithValues,
  readTreeShape,
  renamedAside,
  swapsAside,
  type MachineView
} from './layout'

function machine(over: Partial<MachineView> = {}): MachineView {
  return {
    platform: 'darwin',
    home: '/Users/you',
    env: {},
    writable: () => true,
    ...over
  }
}

describe('where a fresh install goes', () => {
  it('is /Applications on a Mac that can be written to', () => {
    expect(deriveBundleRoot(machine())).toBe('/Applications/Crucible.app')
  })

  it('falls back to the user’s own Applications when /Applications is locked', () => {
    expect(deriveBundleRoot(machine({ writable: () => false }))).toBe(
      '/Users/you/Applications/Crucible.app'
    )
  })

  it('is the per-user Programs directory on Windows', () => {
    expect(
      deriveBundleRoot(
        machine({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\you\\AppData\\Local' } })
      )
    ).toBe('C:\\Users\\you\\AppData\\Local\\Programs\\Crucible')
  })

  it('is ~/.local/opt on Linux', () => {
    expect(deriveBundleRoot(machine({ platform: 'linux' }))).toBe('/Users/you/.local/opt/crucible')
  })
})

describe('the target rule', () => {
  it('uses an explicit target verbatim, whatever the platform would derive', () => {
    expect(bundleRootFor(machine(), '/Users/you/Applications/Crucible.app')).toBe(
      '/Users/you/Applications/Crucible.app'
    )
  })

  it('derives only when there is no target — postinstall’s case and no other', () => {
    expect(bundleRootFor(machine())).toBe('/Applications/Crucible.app')
  })

  it('walks a running app back to its own bundle', () => {
    expect(
      bundleRootFromExecutable('darwin', '/Applications/Crucible.app/Contents/MacOS/Crucible')
    ).toBe('/Applications/Crucible.app')
    expect(bundleRootFromExecutable('linux', '/home/you/.local/opt/crucible/crucible')).toBe(
      '/home/you/.local/opt/crucible'
    )
  })
})

describe('what the bundle holds, per platform', () => {
  it('names the executable Crucible on a Mac, inside the app bundle', () => {
    const layout = bundleLayout('darwin', '/Applications/Crucible.app')

    // `app.isPackaged` is false while the executable is called electron, and
    // every installed-app behavior keys off it.
    expect(layout.executable).toBe('/Applications/Crucible.app/Contents/MacOS/Crucible')
    expect(layout.appDir).toBe('/Applications/Crucible.app/Contents/Resources/app')
    expect(layout.icon.source).toBe('build/icon.icns')
    expect(distExecutable('darwin')).toBe('Contents/MacOS/Electron')
  })

  it('names it Crucible.exe on Windows, with the ico beside it', () => {
    const layout = bundleLayout('win32', 'C:\\Programs\\Crucible')

    expect(layout.executable).toBe('C:\\Programs\\Crucible\\Crucible.exe')
    expect(layout.appDir).toBe('C:\\Programs\\Crucible\\resources\\app')
    expect(layout.icon.source).toBe('build/icon.ico')
    expect(distExecutable('win32')).toBe('electron.exe')
  })

  it('names it crucible on Linux, with the png the launcher shows', () => {
    const layout = bundleLayout('linux', '/home/you/.local/opt/crucible')

    expect(layout.executable).toBe('/home/you/.local/opt/crucible/crucible')
    expect(layout.icon.source).toBe('build/icon.png')
    expect(distExecutable('linux')).toBe('electron')
  })
})

describe('which tree shape the assembler was handed', () => {
  const name = '@secondcircle/crucible'

  it('recognizes postinstall’s: the installed package directory itself', () => {
    const shape = readTreeShape(
      '/global/lib/node_modules/@secondcircle/crucible',
      name,
      (path) => path === '/global/lib/node_modules/@secondcircle/crucible/package.json',
      'darwin'
    )

    expect(shape?.packageDir).toBe('/global/lib/node_modules/@secondcircle/crucible')
    // Its own node_modules first, then the one it is hoisted into.
    expect(shape?.dependencyRoots).toEqual([
      '/global/lib/node_modules/@secondcircle/crucible/node_modules',
      '/global/lib/node_modules'
    ])
  })

  it('recognizes the updater’s: the package under a staging prefix', () => {
    const shape = readTreeShape(
      '/staging',
      name,
      (path) => path === '/staging/node_modules/@secondcircle/crucible/package.json',
      'linux'
    )

    expect(shape?.packageDir).toBe('/staging/node_modules/@secondcircle/crucible')
    expect(shape?.dependencyRoots).toEqual([
      '/staging/node_modules/@secondcircle/crucible/node_modules',
      '/staging/node_modules'
    ])
  })

  it('recognizes nothing else', () => {
    expect(readTreeShape('/somewhere', name, () => false, 'linux')).toBeUndefined()
  })

  it('leaves electron and npm’s own bookkeeping out of the bundle', () => {
    expect(copiedDependency('electron')).toBe(false)
    expect(copiedDependency('.package-lock.json')).toBe(false)
    expect(copiedDependency('.bin')).toBe(false)
    expect(copiedDependency('react')).toBe(true)
  })

  it('does nothing in a tree that has src/, which is every repo checkout', () => {
    expect(assemblesFromHere((path) => path === '/repo/src', '/repo', 'linux')).toBe(false)
    expect(assemblesFromHere(() => false, '/installed', 'linux')).toBe(true)
  })
})

describe('the Windows swap', () => {
  it('renames a locked file beside itself, and sweeps that name next time', () => {
    const aside = renamedAside('C:\\Programs\\Crucible\\Crucible.exe')

    expect(aside).toBe('C:\\Programs\\Crucible\\Crucible.exe.crucible-old')
    expect(isRenamedAside(aside)).toBe(true)
    expect(isRenamedAside('C:\\Programs\\Crucible\\Crucible.exe')).toBe(false)
  })

  it('is taken only for the failures a locked file raises, and only there', () => {
    expect(swapsAside('win32', { code: 'EPERM' })).toBe(true)
    expect(swapsAside('win32', { code: 'EBUSY' })).toBe(true)
    // A full disk is a real failure and stays one.
    expect(swapsAside('win32', { code: 'ENOSPC' })).toBe(false)
    // POSIX lets a running process's files be replaced, so a failure there
    // means what it says.
    expect(swapsAside('darwin', { code: 'EPERM' })).toBe(false)
    expect(swapsAside('linux', { code: 'EBUSY' })).toBe(false)
  })
})

describe('the launcher entry', () => {
  it('is a Start Menu shortcut on Windows', () => {
    expect(
      launcherPath(
        machine({ platform: 'win32', env: { APPDATA: 'C:\\Users\\you\\AppData\\Roaming' } })
      )
    ).toBe('C:\\Users\\you\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Crucible.lnk')
  })

  it('is a .desktop file on Linux, in the launcher’s own directory', () => {
    expect(launcherPath(machine({ platform: 'linux' }))).toBe(
      '/Users/you/.local/share/applications/crucible.desktop'
    )
  })

  it('is nothing on a Mac, where the bundle in Applications is the registration', () => {
    expect(launcherPath(machine())).toBeUndefined()
  })

  it('opens an app rather than a terminal, and files under Development', () => {
    const entry = desktopEntry({ executable: '/opt/crucible/crucible', icon: '/opt/crucible/icon.png' })

    expect(entry).toContain('Exec="/opt/crucible/crucible"')
    expect(entry).toContain('Icon=/opt/crucible/icon.png')
    expect(entry).toContain('Terminal=false')
    expect(entry).toContain('Categories=Development;')
  })
})

describe('the Mac bundle’s identity', () => {
  const PLIST = `<?xml version="1.0"?>
<plist version="1.0">
<dict>
\t<key>CFBundleExecutable</key>
\t<string>Electron</string>
\t<key>CFBundleName</key>
\t<string>Electron</string>
</dict>
</plist>
`

  it('replaces the keys electron shipped', () => {
    const written = plistWithValues(PLIST, {
      CFBundleExecutable: 'Crucible',
      CFBundleName: 'Crucible'
    })

    expect(written).toContain('<key>CFBundleExecutable</key>\n\t<string>Crucible</string>')
    expect(written).not.toContain('<string>Electron</string>')
  })

  it('adds the keys it does not have', () => {
    const written = plistWithValues(PLIST, { CFBundleShortVersionString: '1.5.0' })

    expect(written).toContain('<key>CFBundleShortVersionString</key>\n\t<string>1.5.0</string>')
    expect(written.trimEnd().endsWith('</plist>')).toBe(true)
  })
})
