// What a run's record says about the files it touched, asked two ways: is
// this path one of them, and what is a file of this name. Both flavors of the
// run service answer from here, so the gate and the kind cannot mean two
// different things in fake and live.

import type { RunRecord } from './run'

export type ArtifactKind = 'markdown' | 'html' | 'text'

export function artifactKind(path: string): ArtifactKind {
  const extension = (/\.[^./\\]+$/.exec(path)?.[0] ?? '').toLowerCase()
  if (extension === '.md' || extension === '.markdown') return 'markdown'
  if (extension === '.html' || extension === '.htm') return 'html'
  return 'text'
}

// Exact string equality against what the record names, never a path resolved
// against the filesystem: `..` and every other smuggling shape simply matches
// no entry.
export function recordNamesPath(run: RunRecord, path: string): boolean {
  if (Object.values(run.inputs).includes(path)) return true
  return run.nodes.some(
    (node) =>
      node.artifacts.some((artifact) => artifact.path === path) ||
      node.reads.some((read) => read.path === path)
  )
}

/** The last segment of a path, whichever separator wrote it. */
export function artifactName(path: string): string {
  return path.split(/[\\/]/).filter((piece) => piece !== '').pop() ?? path
}
