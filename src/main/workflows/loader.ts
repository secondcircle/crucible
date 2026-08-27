import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createJiti, type Jiti } from 'jiti'
import type { WorkflowDef } from './authoring'

// Workflows resolve like Commands, minus the built-in rung: two origins,
// workspace over user, and a file in a folder is enrollment. Crucible ships
// no workflows of its own — only example files beside the agent docs, which
// this loader never reads. The files are
// TypeScript, loaded through jiti so a workflow works from any folder with
// no build step and no node_modules of its own; the `crucible:workflow`
// import every file uses is aliased to the shipped authoring module.

export type WorkflowOrigin = 'user' | 'workspace'

export interface WorkflowRoots {
  /** `~/.crucible/workflows`. */
  readonly user: string
}

export interface LoadedWorkflow {
  /** The file name, which is the workflow's name; `description` is the def's. */
  readonly name: string
  readonly origin: WorkflowOrigin
  readonly path: string
  readonly def: WorkflowDef
}

export interface WorkflowLoader {
  /** Every winner of the origin ladder, loaded, sorted by name. */
  list(workspacePath: string): Promise<readonly LoadedWorkflow[]>
  /** The ladder's winner for one name. Unknown names and broken files throw. */
  resolve(workspacePath: string, name: string): Promise<LoadedWorkflow>
}

export interface WorkflowLoaderOptions {
  readonly roots: WorkflowRoots
  /** Absolute path of the shipped authoring module, `crucible:workflow`. */
  readonly authoringModule: string
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
  onUnloadable
}: WorkflowLoaderOptions): WorkflowLoader {
  let loader: Jiti | undefined

  function jiti(): Jiti {
    // Module cache off, so a workflow an agent edits mid-session is what the
    // very next run executes.
    loader ??= createJiti(__filename, {
      moduleCache: false,
      interopDefault: true,
      alias: { 'crucible:workflow': authoringModule }
    })
    return loader
  }

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

  async function load(found: Found): Promise<LoadedWorkflow> {
    let loaded: unknown
    try {
      loaded = await jiti().import(found.path, { default: true })
    } catch (cause) {
      throw new Error(
        `The workflow "${found.name}" could not be loaded from ${found.path}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        { cause }
      )
    }
    return { ...found, def: checkDef(found, loaded) }
  }

  return {
    async list(workspacePath: string): Promise<readonly LoadedWorkflow[]> {
      const listed: LoadedWorkflow[] = []
      for (const found of discover(workspacePath).values()) {
        // A broken file is skipped and reported; it never takes the rest of
        // the catalog down with it.
        try {
          listed.push(await load(found))
        } catch (cause) {
          onUnloadable?.(found.path, cause)
        }
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

/** The floor a default export must meet before the engine will run it. */
function checkDef(found: Found, loaded: unknown): WorkflowDef {
  const def = loaded as Partial<WorkflowDef> | null | undefined
  if (typeof def !== 'object' || def === null) {
    throw new Error(`${found.path} does not default-export a workflow definition.`)
  }
  if (typeof def.description !== 'string' || def.description.trim() === '') {
    throw new Error(`The workflow "${found.name}" has no description (${found.path}).`)
  }
  if (typeof def.inputs !== 'object' || def.inputs === null) {
    throw new Error(`The workflow "${found.name}" declares no inputs record (${found.path}).`)
  }
  if (typeof def.run !== 'function') {
    throw new Error(`The workflow "${found.name}" has no run() (${found.path}).`)
  }
  return def as WorkflowDef
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
