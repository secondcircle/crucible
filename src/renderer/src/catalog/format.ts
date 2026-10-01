import { MODEL_ALIASES } from '../../../shared/agent/known-models'
import type { CatalogEntry, CatalogManifest } from '../../../shared/workflows/catalog'
import type { CatalogReaderSettings } from '../../../shared/workflows/catalog-settings'
import type { ModelFact } from '../../../shared/workflows/catalog-facts'
import { parseNodeModel } from '../../../shared/workflows/node-model'
import { cadenceText } from '../../../shared/schedules/cron'

// The catalog's words, in one place, so the board, the hover card and the
// Settings section say a fact the same way.

/** `Opus`, or the id after its provider where the model has no alias. */
export function modelName(model: string): string {
  return MODEL_ALIASES[model] ?? model.split('/').at(-1) ?? model
}

/** A node's model as the page states it: the name, then the effort. */
export function modelText(spec: string): string {
  const parsed = parseNodeModel(spec)
  if (parsed === undefined) return spec
  return `${modelName(parsed.model)} · ${parsed.effort}`
}

/** What reads the files: `claude-sonnet-5-5 · medium`. */
export function readerText(reader: CatalogReaderSettings): string {
  return `${modelName(reader.model)} · ${reader.effort}`
}

/** The model fact's quiet tag: whose choice it was, and who says so. */
export function modelSource(fact: ModelFact): string {
  if (fact.kind === 'default') return 'engine default'
  return fact.from === 'manifest' ? 'from plan()' : 'named in the file'
}

/** One word for the list row, or nothing for a workflow that has its reading. */
export function entryState(entry: CatalogEntry): string | undefined {
  switch (entry.kind) {
    case 'shadowed':
      return 'shadowed'
    case 'broken':
      return 'broken'
    case 'workflow':
      return entry.reading.status === 'read' ? undefined : entry.reading.status
  }
}

export function targetText(manifest: CatalogManifest): string {
  const target = manifest.target
  if (target === undefined || target === '.') return 'The workspace’s own repository, unless a kickoff names another inside it.'
  if (typeof target === 'object') return 'A repository inside the workspace, which every kickoff has to name.'
  return `Always ${target}, a repository inside the workspace.`
}

export function commitText(manifest: CatalogManifest): string {
  return manifest.commit === false
    ? 'The engine commits nothing; the workflow’s own code commits what it means to.'
    : 'The engine commits whatever the worktree holds when the run ends.'
}

export function scheduleText(schedule: NonNullable<CatalogManifest['schedule']>): string {
  const when =
    schedule.cron === undefined
      ? 'on a schedule the file computes'
      : `${cadenceText(schedule.cron) ?? schedule.cron} (${schedule.cron})`
  return schedule.checks ? `${when}, when its check says so` : when
}

/** Where a file lives, said short: the folder it is in tells its origin already. */
export function fileName(path: string): string {
  return path.split(/[/\\]/).at(-1) ?? path
}
