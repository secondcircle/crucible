import { execFile } from 'node:child_process'
import { basename, dirname } from 'node:path'

/** A worktree's workspace is its main checkout; anything else is itself. */
export function mainCheckoutOf(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8' },
      (error, stdout) => {
        const common = stdout?.trim() ?? ''
        resolve(error === null && basename(common) === '.git' ? dirname(common) : cwd)
      }
    )
  })
}
