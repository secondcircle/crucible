import { posix, win32, type PlatformPath } from 'node:path'

// Every decision the assembler makes that is a decision rather than a file
// copy. They are here, as pure functions over a platform string and a few
// facts, because none of them can be exercised on the machine that builds
// them: a Mac cannot run a Windows install, and a test that needs
// `%LOCALAPPDATA%` to exist proves nothing about the rule.

export type Platform = NodeJS.Platform

/**
 * Paths are composed with the target platform's own rules, not the running
 * machine's, so every decision below is the decision that machine would make
 * — and a Mac can check the Windows one.
 */
function pathsOf(platform: Platform): PlatformPath {
  return platform === 'win32' ? win32 : posix
}

/** The app's name wherever a name is shown: Dock, Start Menu, launcher. */
export const APP_NAME = 'Crucible'

/** The bundle identifier the Mac bundle carries. */
export const APP_ID = 'com.secondcircle.crucible'

/**
 * The environment facts a layout decision reads. Injected whole so a test can
 * describe a Windows machine from a Mac.
 */
export interface MachineView {
  readonly platform: Platform
  readonly home: string
  /** `process.env`, for the two Windows directories that only it names. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Whether the assembler could write there. Mac's `/Applications` question. */
  readonly writable: (path: string) => boolean
}

/**
 * Where a *fresh* install goes. Only postinstall asks: an app that exists
 * knows its own bundle and hands it in, and re-deriving would let a bundle
 * installed under `~/Applications` update a `/Applications` copy nobody runs.
 */
export function deriveBundleRoot(view: MachineView): string {
  const { join } = pathsOf(view.platform)
  switch (view.platform) {
    case 'darwin': {
      const applications = '/Applications'
      const root = view.writable(applications) ? applications : join(view.home, 'Applications')
      return join(root, `${APP_NAME}.app`)
    }
    case 'win32': {
      // Per-user by convention and by permission: a machine-wide install would
      // need an elevated npm.
      const programs = view.env.LOCALAPPDATA ?? join(view.home, 'AppData', 'Local')
      return join(programs, 'Programs', APP_NAME)
    }
    default:
      return join(view.home, '.local', 'opt', APP_NAME.toLowerCase())
  }
}

/**
 * The target rule in one place: an explicit target is used exactly as given,
 * and the install location is derived only when there is none.
 */
export function bundleRootFor(view: MachineView, target?: string): string {
  return target ?? deriveBundleRoot(view)
}

/** Where things sit inside an assembled bundle, per platform. */
export interface BundleLayout {
  /** The executable's path inside the bundle, and the name it must carry. */
  readonly executable: string
  /** Where the package and its dependencies go. */
  readonly appDir: string
  /** Electron's own resources directory inside the bundle. */
  readonly resourcesDir: string
  /** The icon file inside the bundle, and the art it is copied from. */
  readonly icon: { readonly source: string; readonly path: string }
}

/**
 * `app.isPackaged` is false while the executable is still called `electron`,
 * and every installed-app behavior in main keys off it — the SDK adapter, the
 * `Crucible` state directory, the absent debug port, the update service. The
 * rename is load-bearing, not cosmetic.
 */
export function bundleLayout(platform: Platform, bundleRoot: string): BundleLayout {
  const { join } = pathsOf(platform)
  switch (platform) {
    case 'darwin': {
      const resources = join(bundleRoot, 'Contents', 'Resources')
      return {
        executable: join(bundleRoot, 'Contents', 'MacOS', APP_NAME),
        appDir: join(resources, 'app'),
        resourcesDir: resources,
        icon: { source: 'build/icon.icns', path: join(resources, 'icon.icns') }
      }
    }
    case 'win32': {
      const resources = join(bundleRoot, 'resources')
      return {
        executable: join(bundleRoot, `${APP_NAME}.exe`),
        appDir: join(resources, 'app'),
        resourcesDir: resources,
        icon: { source: 'build/icon.ico', path: join(bundleRoot, 'icon.ico') }
      }
    }
    default: {
      const resources = join(bundleRoot, 'resources')
      return {
        executable: join(bundleRoot, APP_NAME.toLowerCase()),
        appDir: join(resources, 'app'),
        resourcesDir: resources,
        icon: { source: 'build/icon.png', path: join(bundleRoot, 'icon.png') }
      }
    }
  }
}

/**
 * The bundle a running app belongs to, walked up from its own executable.
 * This is how the updater knows its target exactly, instead of asking the
 * platform where an app *would* be installed — a question whose answer can
 * change after the install.
 */
export function bundleRootFromExecutable(platform: Platform, executable: string): string {
  const { dirname } = pathsOf(platform)
  // `<bundle>.app/Contents/MacOS/Crucible` on a Mac; `<bundle>/Crucible.exe`
  // and `<bundle>/crucible` everywhere else.
  return platform === 'darwin' ? dirname(dirname(dirname(executable))) : dirname(executable)
}

/**
 * Electron's own executable, where it lands inside the bundle — which is what
 * the rename to `Crucible` starts from. On a Mac the bundle *is* electron's
 * `Electron.app`, so the path is inside it rather than beside it.
 */
export function distExecutable(platform: Platform): string {
  const { join } = pathsOf(platform)
  switch (platform) {
    case 'darwin':
      return join('Contents', 'MacOS', 'Electron')
    case 'win32':
      return 'electron.exe'
    default:
      return 'electron'
  }
}

/**
 * What of electron's dist is copied into the bundle. On a Mac the dist holds
 * `Electron.app` and the bundle *is* that app, so the copy starts one level
 * in; elsewhere the dist directory is the bundle.
 */
export function distRoot(platform: Platform, dist: string): string {
  return platform === 'darwin' ? pathsOf(platform).join(dist, 'Electron.app') : dist
}

// ---------------------------------------------------------------- the tree

/**
 * The two tree shapes the assembler's callers actually produce, and no others:
 * postinstall's installed package directory, and the updater's
 * `npm install --prefix` staging root.
 */
export interface TreeShape {
  /** The package's own directory: its `package.json` and published files. */
  readonly packageDir: string
  /**
   * Directories that may hold resolved dependencies, nearest first. Both
   * shapes occur in the wild — npm nests some deps under the package and
   * hoists the rest beside it — so both are read and the nearer wins.
   */
  readonly dependencyRoots: readonly string[]
}

/**
 * Recognizes which shape a tree is. `exists` is the only filesystem fact it
 * needs, so the decision is testable without a tree.
 */
export function readTreeShape(
  tree: string,
  packageName: string,
  exists: (path: string) => boolean,
  platform: Platform = process.platform
): TreeShape | undefined {
  const { join } = pathsOf(platform)
  // Postinstall's shape: the package directory itself.
  if (exists(join(tree, 'package.json'))) {
    return { packageDir: tree, dependencyRoots: dependencyRootsFor(tree, platform) }
  }
  // The updater's shape: `<staging>/node_modules/<name>`, dependencies hoisted
  // into that same `node_modules`.
  const staged = join(tree, 'node_modules', ...packageName.split('/'))
  if (exists(join(staged, 'package.json'))) {
    return { packageDir: staged, dependencyRoots: dependencyRootsFor(staged, platform) }
  }
  return undefined
}

// The package's own `node_modules` first, then the one it sits inside — which
// is where npm hoists what it deduplicated. A scoped package sits two levels
// down, so the walk climbs past its scope directory.
function dependencyRootsFor(packageDir: string, platform: Platform): readonly string[] {
  const { basename, dirname, join } = pathsOf(platform)
  const roots = [join(packageDir, 'node_modules')]
  let above = dirname(packageDir)
  for (let step = 0; step < 2; step += 1) {
    if (basename(above) === 'node_modules') {
      roots.push(above)
      break
    }
    above = dirname(above)
  }
  return roots
}

/**
 * Whether an entry of `node_modules` is copied into the bundle. Electron
 * itself never is: inside Electron `require('electron')` is built-in, and its
 * dist would double the bundle for nothing. Nor is npm's own bookkeeping —
 * `.package-lock.json`, `.bin` and their kin are not packages.
 */
export function copiedDependency(name: string): boolean {
  return name !== 'electron' && !name.startsWith('.')
}

/**
 * The published tarball carries no `src/`, so a tree that has one is a repo
 * checkout and postinstall does nothing at all: `npm ci` in this repository
 * installs nothing to the machine.
 */
export function assemblesFromHere(
  exists: (path: string) => boolean,
  tree: string,
  platform: Platform = process.platform
): boolean {
  return !exists(pathsOf(platform).join(tree, 'src'))
}

// ------------------------------------------------------- the Windows swap

const RENAMED_ASIDE = '.crucible-old'

/**
 * Windows locks the running `Crucible.exe` and every DLL it has loaded against
 * write and delete, but allows renaming them within the volume. So a file that
 * cannot be replaced is renamed beside itself and the new one written under
 * the real name: after the assembler returns, the bundle's contents hold the
 * new version on every OS, which is what lets `restart()` mean one thing
 * everywhere.
 */
export function renamedAside(path: string): string {
  return `${path}${RENAMED_ASIDE}`
}

/**
 * Whether a failed replacement should be retried by renaming the file aside.
 * Only on Windows, and only for the codes it raises over a file a running
 * process holds open — a full disk or a missing directory is a real failure
 * and stays one.
 */
export function swapsAside(platform: Platform, cause: unknown): boolean {
  if (platform !== 'win32') return false
  const code = (cause as { code?: unknown } | null)?.code
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}

/**
 * What the next run sweeps: the leftovers of the previous swap, which unlock
 * as soon as the process that held them exits. At most one generation can
 * linger, and that is accepted.
 */
export function isRenamedAside(path: string): boolean {
  return path.endsWith(RENAMED_ASIDE)
}

// ------------------------------------------------------- the launcher entry

/**
 * The Linux launcher entry. `Terminal=false` because clicking the icon opens
 * an app, not a shell.
 */
export function desktopEntry(options: {
  readonly executable: string
  readonly icon: string
}): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${APP_NAME}`,
    'Comment=A personal development system built on π',
    `Exec="${options.executable}"`,
    `Icon=${options.icon}`,
    'Terminal=false',
    'Categories=Development;',
    'StartupWMClass=Crucible',
    ''
  ].join('\n')
}

/** Where that entry goes, and the Start Menu shortcut's path on Windows. */
export function launcherPath(view: MachineView): string | undefined {
  const { join } = pathsOf(view.platform)
  switch (view.platform) {
    case 'win32': {
      const appData = view.env.APPDATA ?? join(view.home, 'AppData', 'Roaming')
      return join(
        appData,
        'Microsoft',
        'Windows',
        'Start Menu',
        'Programs',
        `${APP_NAME}.lnk`
      )
    }
    case 'linux':
      return join(view.home, '.local', 'share', 'applications', 'crucible.desktop')
    default:
      // The Mac needs none: the bundle in Applications is the registration.
      return undefined
  }
}

// ------------------------------------------------------------- Info.plist

/**
 * The Mac bundle's identity, set on electron's own plist. A minimal edit
 * rather than a plist library: these are the four keys that decide what the
 * Dock shows and what the Finder launches, and every one of them is a
 * `<key>`/`<string>` pair in a file we ship the shape of.
 */
export function plistWithValues(
  plist: string,
  values: Readonly<Record<string, string>>
): string {
  let written = plist
  const missing: string[] = []
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(
      `(<key>${escapeRegExp(key)}</key>\\s*<string>)([^<]*)(</string>)`
    )
    if (pattern.test(written)) {
      written = written.replace(pattern, `$1${escapeXml(value)}$3`)
    } else {
      missing.push(`\t<key>${key}</key>\n\t<string>${escapeXml(value)}</string>`)
    }
  }
  if (missing.length === 0) return written
  const at = written.lastIndexOf('</dict>')
  if (at === -1) return written
  return `${written.slice(0, at)}${missing.join('\n')}\n${written.slice(at)}`
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
