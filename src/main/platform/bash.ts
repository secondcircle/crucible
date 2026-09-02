import { win32, type PlatformPath } from 'node:path'
import { findOnWindowsPath, type PathView } from './path-lookup'

// Where bash is, per OS, as a pure function over a view of the machine. On
// Windows the bash that counts is Git Bash, never a bare `bash` lookup:
// `System32\bash.exe` is WSL, and a command that ran there would run against
// another filesystem, another user and another set of tools, and say nothing
// about it — a worse failure than not running at all.

/** What the discovery reads. Injected whole, so a Mac can test a Windows box. */
export interface MachineBashView extends PathView {
  readonly platform: NodeJS.Platform
}

export type BashLocation =
  | { readonly ok: true; readonly path: string }
  /** Said to the person, in the bash run's own output. Never silent. */
  | { readonly ok: false; readonly message: string }

const NOT_FOUND =
  'Crucible runs a bash command through Git Bash on Windows, and could not find it. ' +
  'Install Git for Windows (https://git-scm.com/download/win) and make sure git is on PATH.'

export function discoverBash(view: MachineBashView): BashLocation {
  if (view.platform !== 'win32') return { ok: true, path: 'bash' }

  // Windows paths, composed by Windows rules, whatever machine is asking.
  const { dirname, join } = paths
  const git = findOnWindowsPath('git.exe', view)
  if (git !== undefined) {
    // Git for Windows lays out `<root>\cmd\git.exe`, `<root>\bin\git.exe` and
    // `<root>\bin\bash.exe`, so bash is one directory up and one across from
    // whichever git is on PATH.
    const root = dirname(dirname(git))
    for (const candidate of [join(root, 'bin', 'bash.exe'), join(root, 'usr', 'bin', 'bash.exe')]) {
      if (view.exists(candidate)) return { ok: true, path: candidate }
    }
  }

  // No git on PATH, or a git that is not Git for Windows: the usual install
  // locations, still never a bare lookup.
  for (const root of ['C:\\Program Files\\Git', 'C:\\Program Files (x86)\\Git']) {
    const candidate = join(root, 'bin', 'bash.exe')
    if (view.exists(candidate)) return { ok: true, path: candidate }
  }

  return { ok: false, message: NOT_FOUND }
}

// Everything below the platform check is Windows-only, so the rules are
// Windows' own: backslashes between segments, whatever machine is asking.
const paths: PlatformPath = win32
