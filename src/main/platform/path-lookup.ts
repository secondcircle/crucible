import { win32 } from 'node:path'

// One place answers "which file on PATH is this name", so nothing in the app
// grows a second reading of Windows' own rules.

/** What a PATH lookup reads. Injected whole, so a Mac can test a Windows box. */
export interface PathView {
  /** `PATH`, as the process has it. */
  readonly path: string
  readonly exists: (path: string) => boolean
}

/**
 * PATH's own semantics on Windows and nothing more: entries split on `;`,
 * surrounding quotes dropped, the first directory that holds the name wins.
 * Windows' rules whatever machine is asking, which is what makes the callers
 * testable off Windows.
 *
 * The name is always given with its extension. Windows' own `PATHEXT` search
 * is what makes a bare name ambiguous — `bash` finds WSL, `npm` finds nothing
 * Node can spawn — and both callers here exist precisely to avoid it.
 */
export function findOnWindowsPath(name: string, view: PathView): string | undefined {
  for (const directory of view.path.split(win32.delimiter)) {
    if (directory === '') continue
    const candidate = win32.join(directory.replace(/^"|"$/g, ''), name)
    if (view.exists(candidate)) return candidate
  }
  return undefined
}
