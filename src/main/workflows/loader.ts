import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createWorkflowHost, type SpawnHost, type WorkflowHost, type WorkflowManifest } from './host/host'

// Workflows resolve like Commands, minus the built-in rung: two origins,
// workspace over user, and a file in a folder is enrollment. Crucible ships
// no workflows of its own — only example files beside the agent docs, which
// this loader never reads.
//
// The files are TypeScript, and this process never executes them: a workflow
// host does, one process per file, so a file's top-level code, its `run()`
// and its checks hold that host and nothing else. What comes back here is a
// manifest — the declarations, minus the functions — and a way to open a
// fresh host for the run.

export type WorkflowOrigin = 'user' | 'workspace'

export interface WorkflowRoots {
  /** `~/.crucible/workflows`. */
  readonly user: string
}

export interface LoadedWorkflow {
  /** The file name, which is the workflow's name; `description` is the manifest's. */
  readonly name: string
  readonly origin: WorkflowOrigin
  readonly path: string
  readonly manifest: WorkflowManifest
  /** A fresh host with this file loaded. The caller kills it. */
  open(): WorkflowHost
}

export interface WorkflowLoader {
  /**
   * Every winner of the origin ladder, loaded, sorted by name. Given an
   * origin, only the winners from that origin are read at all: reading a
   * manifest starts a host and runs the file's module body in it, so a
   * caller that will discard an origin should never ask for it. The
   * scheduler asks every 30 seconds and wants workspace files only.
   */
  list(workspacePath: string, origin?: WorkflowOrigin): Promise<readonly LoadedWorkflow[]>
  /** The ladder's winner for one name. Unknown names and broken files throw. */
  resolve(workspacePath: string, name: string): Promise<LoadedWorkflow>
}

export interface WorkflowLoaderOptions {
  readonly roots: WorkflowRoots
  /** Absolute path of the shipped authoring module, `crucible:workflow`. */
  readonly authoringModule: string
  /** Starts a host process for a file. */
  readonly spawn: SpawnHost
  /** Where a file that cannot load is reported; discovery never crashes. */
  readonly onUnloadable?: (path: string, cause: unknown) => void
}

interface Found {
  readonly name: string
  readonly origin: WorkflowOrigin
  readonly path: string
}

export function createWorkflowLoader({
  roots,
  authoringModule,
  spawn,
  onUnloadable
}: WorkflowLoaderOptions): WorkflowLoader {
  // A manifest is read by starting a process, so one is kept for as long as
  // the file it came from has the same bytes; the next listing after an edit
  // reads it afresh. A run never uses this — it opens a host of its own,
  // which imports the file again, so a helper the file imports is always
  // read live by the run even though it cannot move this stamp.
  const manifests = new Map<string, { readonly stamp: string; readonly manifest: WorkflowManifest }>()

  const open = (found: Found): WorkflowHost => createWorkflowHost(spawn, found.path, authoringModule)

  /** Workspace beats user: the winner is the last one found. */
  function discover(workspacePath: string): Map<string, Found> {
    const folders: readonly { origin: WorkflowOrigin; path: string }[] = [
      { origin: 'user', path: roots.user },
      { origin: 'workspace', path: join(workspacePath, '.crucible', 'workflows') }
    ]
    const winners = new Map<string, Found>()
    for (const folder of folders) {
      for (const name of workflowNames(folder.path)) {
        winners.set(name, { name, origin: folder.origin, path: join(folder.path, `${name}.ts`) })
      }
    }
    return winners
  }

  async function readManifest(found: Found): Promise<WorkflowManifest> {
    const stamp = fileStamp(found.path)
    const kept = manifests.get(found.path)
    if (kept !== undefined && kept.stamp === stamp) return kept.manifest

    const host = open(found)
    let manifest: WorkflowManifest
    try {
      manifest = await host.manifest()
    } catch (cause) {
      throw new Error(
        `The workflow "${found.name}" could not be loaded from ${found.path}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        { cause }
      )
    } finally {
      host.kill()
    }
    manifests.set(found.path, { stamp, manifest })
    return manifest
  }

  async function load(found: Found): Promise<LoadedWorkflow> {
    const manifest = await readManifest(found)
    return { ...found, manifest, open: () => open(found) }
  }

  return {
    async list(workspacePath: string, origin?: WorkflowOrigin): Promise<readonly LoadedWorkflow[]> {
      // Every file at once: each is its own process, and the listing is only
      // as slow as the slowest of them rather than the sum.
      const found = [...discover(workspacePath).values()].filter(
        (candidate) => origin === undefined || candidate.origin === origin
      )
      const settled = await Promise.allSettled(found.map(load))
      const listed: LoadedWorkflow[] = []
      for (const [at, outcome] of settled.entries()) {
        if (outcome.status === 'fulfilled') {
          listed.push(outcome.value)
          continue
        }
        // A broken file is skipped and reported; it never takes the rest of
        // the catalog down with it.
        onUnloadable?.(found[at].path, outcome.reason)
      }
      return listed.sort((left, right) => left.name.localeCompare(right.name))
    },

    async resolve(workspacePath: string, name: string): Promise<LoadedWorkflow> {
      const found = discover(workspacePath).get(name)
      if (found === undefined) {
        const known = [...discover(workspacePath).keys()].sort().join(', ')
        throw new Error(
          known === ''
            ? `No workflow is named "${name}" — no workflow folder has any files.`
            : `No workflow is named "${name}". Known workflows: ${known}.`
        )
      }
      return load(found)
    }
  }
}

/** What "the same file" means for the manifest kept from the last read. */
function fileStamp(path: string): string {
  try {
    return createHash('sha1').update(readFileSync(path)).digest('hex')
  } catch {
    return 'missing'
  }
}

// Non-recursive, `*.ts` only, and a missing folder contributes nothing;
// discovery never creates a folder. `.d.ts` and the shipped lib folder are
// not workflows and never appear — the former by the filter, the latter by
// being a directory.
function workflowNames(folder: string): readonly string[] {
  let entries: readonly string[]
  try {
    entries = readdirSync(folder, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')
      )
      .map((entry) => entry.name.slice(0, -'.ts'.length))
  } catch {
    return []
  }
  return entries.filter((name) => name !== '')
}
