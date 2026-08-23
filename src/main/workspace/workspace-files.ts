import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// Reading a configuration file out of the workspace, as its own seam: the
// collectors take it as an argument, so a test drives them from text rather
// than from a directory on disk.

/** `undefined` where the file is absent or unreadable, which read the same. */
export type WorkspaceFileReader = (
  workspacePath: string,
  relativePath: string
) => Promise<string | undefined>

/** Bounds a file somebody pointed at a pipe or a disk image. */
const MAX_BYTES = 256 * 1024

export const readWorkspaceFile: WorkspaceFileReader = async (workspacePath, relativePath) => {
  try {
    const text = await readFile(join(workspacePath, relativePath), 'utf8')
    return text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text
  } catch {
    return undefined
  }
}
