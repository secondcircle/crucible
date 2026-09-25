import { execFileSync } from 'node:child_process'

export function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}

/** A file's text at a commit, or null when it doesn't exist there. */
export function show(repo: string, rev: string, path: string): string | null {
  try {
    return execFileSync('git', ['-C', repo, 'show', `${rev}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

export interface Changed {
  status: string
  path: string
}

/** Files a commit (or range) changed, with their status letter. */
export function changedFiles(repo: string, from: string, to: string): Changed[] {
  return git(repo, ['diff', '--name-status', '--no-renames', from, to])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, path] = line.split('\t')
      return { status: status!, path: path! }
    })
}

/** For every line of a file at a commit, the commit that introduced it. */
export function blame(repo: string, rev: string, path: string): string[] {
  const out = git(repo, ['blame', '--porcelain', rev, '--', path])
  const byLine: string[] = []
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line)
    if (m) byLine[Number(m[2]) - 1] = m[1]!
  }
  return byLine
}
