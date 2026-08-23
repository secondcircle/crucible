import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Skill } from '@earendil-works/pi-coding-agent'
import { crucibleAgentDir } from '../agent/paths'

// The file format and the discovery rules stay π's; Crucible decides only
// which folders are read and in what order.

/** π's `Skill`, narrowed to what Crucible's own seams read off one. */
export interface LoadedSkill {
  readonly name: string
  readonly description: string
  /** Absolute path of the skill's own markdown file. */
  readonly filePath: string
  /** Absolute directory that file sits in. */
  readonly baseDir: string
}

// π's loader made these, and they carry fields π reads that Crucible does not
// (`disable-model-invocation` among them), so they go back whole.
export function forPi(skills: readonly LoadedSkill[]): Skill[] {
  return skills as Skill[]
}

export interface SkillRoots {
  /** The built-ins shipped with the app. */
  readonly builtIn: string
  /** `~/.crucible/skills`. */
  readonly user: string
}

// Workspace beats user beats built-in, and π's loader keeps the first skill it
// meets under a given name — so this order is the precedence. It is
// deliberately not π's own, which puts user ahead of project.
export function foldersFor(roots: SkillRoots, workspacePath: string): readonly string[] {
  return [join(workspacePath, '.crucible', 'skills'), roots.user, roots.builtIn]
}

/** Never created here: discovery only ever reads. */
export function userSkillsPath(home = homedir()): string {
  return join(home, '.crucible', 'skills')
}

export interface SkillService {
  // Never rejects. `undefined` means an origin folder is there but could not be
  // read, so the caller keeps the set it holds rather than losing skills the
  // user still has on disk.
  resolve(workspacePath: string): Promise<readonly LoadedSkill[] | undefined>
}

export interface SkillServiceOptions {
  readonly roots: SkillRoots
  // Nothing about a bad skill reaches the UI, so the run log is where the
  // diagnosis happens.
  readonly onDiagnostic?: (diagnostic: { path?: string; message: string }) => void
}

// Imported dynamically because the SDK is ESM-only, so the CommonJS main
// bundle cannot `require` it.
type Sdk = typeof import('@earendil-works/pi-coding-agent')

/** ENOENT, and the ENOTDIR of a path whose parent segment is a file. */
function absent(cause: unknown): boolean {
  const code = (cause as { code?: unknown })?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

// π's loader reads a folder nobody may open as a folder holding no skills, and
// those two must part ways here: an empty origin contributes nothing, an
// unreadable one leaves the previous set in force.
function unreadableFolders(folders: readonly string[]): readonly { path: string; cause: unknown }[] {
  const unreadable: { path: string; cause: unknown }[] = []
  for (const path of folders) {
    try {
      readdirSync(path)
    } catch (cause) {
      if (absent(cause)) continue
      unreadable.push({ path, cause })
    }
  }
  return unreadable
}

export function createSkillService({ roots, onDiagnostic }: SkillServiceOptions): SkillService {
  let sdkModule: Promise<Sdk> | undefined

  function sdk(): Promise<Sdk> {
    sdkModule ??= import('@earendil-works/pi-coding-agent')
    return sdkModule
  }

  return {
    async resolve(workspacePath: string): Promise<readonly LoadedSkill[] | undefined> {
      const folders = foldersFor(roots, workspacePath)
      const unreadable = unreadableFolders(folders)
      if (unreadable.length > 0) {
        // The load is not even attempted: its answer would be short the skills
        // of that folder, and a caller cannot tell that from a true one.
        for (const { path, cause } of unreadable) {
          onDiagnostic?.({
            path,
            message: `skills folder could not be read, previous skills stay in force: ${reasonFor(cause)}`
          })
        }
        return undefined
      }
      try {
        const pi = await sdk()
        const loaded = pi.loadSkills({
          cwd: workspacePath,
          // Crucible's own agent dir, so π's own folders are named nowhere.
          // With `includeDefaults` off nothing under it is read either: the
          // three paths below are the whole of discovery.
          agentDir: crucibleAgentDir(homedir()),
          skillPaths: [...folders],
          includeDefaults: false
        })
        for (const diagnostic of loaded.diagnostics) {
          // π reporting an origin folder itself means it is not there, the
          // ordinary state of two of the three, so it is not worth a log line
          // on every turn ever taken.
          if (diagnostic.path !== undefined && folders.includes(diagnostic.path)) continue
          onDiagnostic?.({
            ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
            message: diagnostic.message
          })
        }
        return loaded.skills
      } catch (cause) {
        // Nothing is said anywhere: no dialog, no transcript message, no
        // badge. The run log is the whole of the report.
        onDiagnostic?.({ message: reasonFor(cause) })
        return undefined
      }
    }
  }
}

/**
 * Absent names means every skill, an empty list none at all; a name matching no
 * skill is ignored rather than an error.
 */
export function narrowSkills(
  skills: readonly LoadedSkill[],
  names?: readonly string[]
): readonly LoadedSkill[] {
  if (names === undefined) return skills
  const wanted = new Set(names)
  return skills.filter((skill) => wanted.has(skill.name))
}

function reasonFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
