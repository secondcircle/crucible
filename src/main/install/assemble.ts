import { execFile } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  APP_ID,
  APP_NAME,
  assemblesFromHere,
  bundleLayout,
  bundleRootFor,
  copiedDependency,
  desktopEntry,
  distExecutable,
  distRoot,
  isRenamedAside,
  launcherPath,
  swapsAside,
  plistWithValues,
  readTreeShape,
  renamedAside,
  type MachineView,
  type Platform
} from './layout'

// Given a tree that holds the package and its resolved dependencies, produce
// or refresh the desktop app at a bundle location: nothing else in Crucible
// knows where an app lives on any OS. Plain Node, no electron import —
// postinstall runs it before there is an app at all.

export interface AssembleRequest {
  /** The tree holding the package and its dependencies. Two shapes, see layout. */
  readonly tree: string
  /** The package's name, as its own package.json gives it. */
  readonly packageName: string
  /**
   * The bundle to refresh. Absent means derive this platform's install
   * location — postinstall's case, and only postinstall's: an app that is
   * already installed knows its own bundle and hands it in, so an update can
   * never land somewhere the running process will not relaunch from.
   */
  readonly target?: string
}

export interface AssembleOutcome {
  readonly bundleRoot: string
  /** The version now sitting in that bundle. */
  readonly version: string
  /** Where the launcher entry or shortcut went, when the platform has one. */
  readonly launcher?: string
}

/** The machine, injected whole so every decision above is testable. */
export interface Machine extends MachineView {
  /** Runs a command to completion; rejects when it fails. `env` is added to this process's own. */
  readonly run: (
    command: string,
    args: readonly string[],
    env?: Readonly<Record<string, string>>
  ) => Promise<void>
}

export function thisMachine(): Machine {
  return {
    platform: process.platform,
    home: homedir(),
    env: process.env,
    writable: (path: string) => {
      try {
        // Writability of the directory, asked the only way that answers
        // honestly under MDM: try it.
        const probe = join(path, `.crucible-probe-${process.pid}`)
        writeFileSync(probe, '')
        rmSync(probe, { force: true })
        return true
      } catch {
        return false
      }
    },
    run: (command, args, env) =>
      new Promise<void>((resolve, reject) => {
        const options = env === undefined ? {} : { env: { ...process.env, ...env } }
        execFile(command, [...args], options, (failure) => {
          if (failure === null) resolve()
          else reject(failure)
        })
      })
  }
}

export async function assembleDesktopApp(
  request: AssembleRequest,
  machine: Machine = thisMachine()
): Promise<AssembleOutcome> {
  const platform = machine.platform
  const shape = readTreeShape(request.tree, request.packageName, existsSync, platform)
  if (shape === undefined) {
    throw new Error(
      `Crucible could not find ${request.packageName} in ${request.tree}, so there was nothing to install.`
    )
  }

  const bundleRoot = bundleRootFor(machine, request.target)
  const layout = bundleLayout(platform, bundleRoot)
  const version = packageVersion(shape.packageDir)
  const dist = await electronDist(shape, machine)

  mkdirSync(bundleRoot, { recursive: true })
  // Last update's leftovers, which unlock the moment the process that held
  // them exits. Swept first so a bundle never grows a second generation.
  sweepRenamedAside(bundleRoot)

  copyTree(distRoot(platform, dist), bundleRoot, platform)
  place(join(bundleRoot, distExecutable(platform)), layout.executable, platform)
  rmSync(join(layout.resourcesDir, 'default_app.asar'), { force: true })

  // The payload is replaced rather than merged, so nothing a previous version
  // shipped survives into this one. On Windows whatever is locked stays and
  // is written over by the copy below.
  removeBestEffort(layout.appDir)
  copyPackage(shape.packageDir, layout.appDir, platform)
  copyDependencies(shape, layout.appDir, platform)

  copyIcon(shape.packageDir, layout, platform)
  if (platform === 'darwin') await finishMacBundle(bundleRoot, layout, version, machine)
  else chmodSync(layout.executable, 0o755)

  const launcher = await registerLauncher(machine, layout)

  return { bundleRoot, version, ...(launcher === undefined ? {} : { launcher }) }
}

/**
 * Postinstall's whole rule: a tree with `src/` is a repo checkout, and `npm
 * ci` in this repository installs nothing to anybody's machine.
 */
export function assemblesInThisTree(tree: string): boolean {
  return assemblesFromHere(existsSync, tree)
}

function packageVersion(packageDir: string): string {
  const parsed: unknown = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  const version = (parsed as { version?: unknown }).version
  if (typeof version !== 'string' || version === '') {
    throw new Error('The package Crucible was asked to install carries no version.')
  }
  return version
}

/**
 * Electron's platform binaries. Electron 43 stopped downloading them in a
 * postinstall: the package ships `install.js` and fetches on the first
 * `require('electron')`, which nothing in a global install ever does. So when
 * `dist` is missing the assembler makes that first call itself, with the
 * binary that is running it, and looks again.
 *
 * That binary is node under postinstall and Electron's own under the
 * installed app's updater, and Electron handed a script starts an app that
 * never exits. `ELECTRON_RUN_AS_NODE` makes it node for this one child;
 * node itself ignores it.
 */
async function electronDist(
  shape: { readonly dependencyRoots: readonly string[] },
  machine: Machine
): Promise<string> {
  const found = (): string | undefined => {
    for (const root of shape.dependencyRoots) {
      const dist = join(root, 'electron', 'dist')
      if (existsSync(dist)) return dist
    }
    return undefined
  }
  const dist = found()
  if (dist !== undefined) return dist

  for (const root of shape.dependencyRoots) {
    const installer = join(root, 'electron', 'install.js')
    if (!existsSync(installer)) continue
    await machine.run(process.execPath, [installer], { ELECTRON_RUN_AS_NODE: '1' })
    const downloaded = found()
    if (downloaded !== undefined) return downloaded
  }
  throw new Error(
    'Crucible found no electron binary to build the app from. Reinstall so electron can download its own.'
  )
}

function copyPackage(packageDir: string, appDir: string, platform: Platform): void {
  mkdirSync(appDir, { recursive: true })
  for (const entry of readdirSync(packageDir)) {
    // Dependencies are copied separately, with electron left out.
    if (entry === 'node_modules') continue
    copyTree(join(packageDir, entry), join(appDir, entry), platform)
  }
}

// The main bundle externalizes its dependencies, so they have to be on disk
// beside it at runtime. The nearer root wins where both hold a copy, which is
// what nesting means to Node's own resolver.
function copyDependencies(
  shape: { readonly packageDir: string; readonly dependencyRoots: readonly string[] },
  appDir: string,
  platform: Platform
): void {
  const into = join(appDir, 'node_modules')
  // "A nearer root already provided it" is a fact about this run, remembered
  // here rather than read off the bundle: an existing directory there may be
  // the previous version's leftover from a removal a locked file refused.
  const placed = new Set<string>()

  for (const root of shape.dependencyRoots) {
    for (const name of dependencyNames(root)) {
      const from = join(root, name)
      // Our own package sits in the hoisted root beside its dependencies;
      // copying it would nest the app inside itself.
      if (from === shape.packageDir || placed.has(name)) continue
      placed.add(name)
      const to = join(into, name)
      // Replaced, never merged, one dependency at a time — the promise
      // copyPackage keeps for the payload, kept here too because the payload's
      // own removal may have been refused halfway.
      removeBestEffort(to)
      copyTree(from, to, platform)
    }
  }
}

/**
 * The packages a `node_modules` directory holds, by name — scopes expanded,
 * because a scope is a directory of packages and not a package, and npm's own
 * bookkeeping (`.package-lock.json`, `.bin`) left out.
 */
function dependencyNames(root: string): string[] {
  if (!existsSync(root)) return []
  const names: string[] = []
  for (const entry of readdirSync(root)) {
    if (!copiedDependency(entry)) continue
    if (!entry.startsWith('@')) {
      names.push(entry)
      continue
    }
    for (const scoped of readdirSync(join(root, entry))) {
      if (copiedDependency(scoped)) names.push(join(entry, scoped))
    }
  }
  return names
}

function copyIcon(packageDir: string, layout: ReturnType<typeof bundleLayout>, platform: Platform): void {
  const source = join(packageDir, layout.icon.source)
  if (!existsSync(source)) return
  mkdirSync(dirname(layout.icon.path), { recursive: true })
  place(source, layout.icon.path, platform, 'copy')
}

async function finishMacBundle(
  bundleRoot: string,
  layout: ReturnType<typeof bundleLayout>,
  version: string,
  machine: Machine
): Promise<void> {
  const plistPath = join(bundleRoot, 'Contents', 'Info.plist')
  if (existsSync(plistPath)) {
    writeFileSync(
      plistPath,
      plistWithValues(readFileSync(plistPath, 'utf8'), {
        CFBundleExecutable: APP_NAME,
        CFBundleName: APP_NAME,
        CFBundleDisplayName: APP_NAME,
        CFBundleIdentifier: APP_ID,
        CFBundleIconFile: 'icon.icns',
        CFBundleShortVersionString: version,
        CFBundleVersion: version
      })
    )
  }
  chmodSync(layout.executable, 0o755)
  // The bundle was modified after electron signed it, and a Mac refuses to
  // launch a bundle whose signature no longer matches. Ad-hoc is all an
  // unsigned local app needs; notarization is somebody else's story.
  await machine
    .run('codesign', ['--force', '--deep', '--sign', '-', bundleRoot])
    .catch(() => {
      // A missing codesign (no developer tools) is not a reason to leave the
      // install half-done; the app may still launch, and the installer's
      // output already told the user what it did.
    })
}

/** The Start Menu shortcut on Windows, the launcher entry on Linux. */
async function registerLauncher(
  machine: Machine,
  layout: ReturnType<typeof bundleLayout>
): Promise<string | undefined> {
  const path = launcherPath(machine)
  if (path === undefined) return undefined
  mkdirSync(dirname(path), { recursive: true })

  if (machine.platform === 'linux') {
    writeFileSync(
      path,
      desktopEntry({ executable: layout.executable, icon: layout.icon.path })
    )
    chmodSync(path, 0o755)
    return path
  }

  // A .lnk is a binary format with no plain-file equivalent, so Windows' own
  // shell object writes it. This is not a bash run: PowerShell is the OS's
  // only way to ask for a shortcut without a dependency.
  const script = [
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${quote(path)})`,
    `$s.TargetPath = ${quote(layout.executable)}`,
    `$s.WorkingDirectory = ${quote(dirname(layout.executable))}`,
    `$s.IconLocation = ${quote(layout.icon.path)}`,
    `$s.Description = ${quote(`${APP_NAME} — a personal development system built on π`)}`,
    '$s.Save()'
  ].join('; ')
  await machine
    .run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])
    .catch(() => {})
  return path
}

function quote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`
}

// ------------------------------------------------------------ the file work

function copyTree(from: string, to: string, platform: Platform): void {
  const stats = lstatSync(from)
  // Symlinks are copied as symlinks. A Mac framework is built out of them —
  // `Versions/Current` and the links beside it — and following them instead
  // would triple the bundle and leave a shape no framework has.
  if (stats.isSymbolicLink()) {
    const target = readlinkSync(from)
    replacing(to, platform, () => symlinkSync(target, to))
    return
  }
  if (stats.isDirectory()) {
    mkdirSync(to, { recursive: true })
    for (const entry of readdirSync(from)) {
      copyTree(join(from, entry), join(to, entry), platform)
    }
    return
  }
  mkdirSync(dirname(to), { recursive: true })
  place(from, to, platform, 'copy')
  chmodSync(to, stats.mode & 0o777)
}

function place(from: string, to: string, platform: Platform, how: 'move' | 'copy' = 'move'): void {
  if (from === to) return
  replacing(to, platform, () => {
    if (how === 'copy') copyFileSync(from, to)
    else renameSync(from, to)
  })
}

/**
 * Replace what a path holds, never write through it: the bundle belongs to a
 * running app with these very inodes mapped, and writing through one rewrites
 * bytes that app is executing, while an unlink leaves the old inode to
 * whoever holds it open. Windows refuses the unlink for a loaded file but
 * allows a rename, so there the file is renamed aside and the new one takes
 * its name.
 */
function replacing(to: string, platform: Platform, write: () => void): void {
  removeBestEffort(to)
  try {
    write()
    return
  } catch (cause) {
    // Nothing left to rename aside means the removal above succeeded and the
    // write failed for a reason of its own — a real failure, raised as it is.
    if (!swapsAside(platform, cause) || !existsSync(to)) throw cause
  }
  renameSync(to, renamedAside(to))
  write()
}

function sweepRenamedAside(directory: string): void {
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(directory, entry)
    if (isRenamedAside(entry)) {
      // Still locked means the old process has not exited yet — its own image,
      // most often — and the next run gets it. Failing the assembly instead
      // would mean no update ever lands until the human restarts, which is the
      // silent never-updating app the rename-aside rule exists to prevent.
      removeBestEffort(path)
      continue
    }
    if (isDirectory(path)) sweepRenamedAside(path)
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Removal that a locked file does not turn into a failed install. */
function removeBestEffort(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // Windows, holding something open. The copy that follows writes over what
    // it can and renames aside what it cannot.
  }
}
