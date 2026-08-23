import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Skill } from '@earendil-works/pi-coding-agent'
import { crucibleAgentDir } from '../agent/paths'

// The three-origin ladder commands already resolve on, pointed at π's own
// loader: the file format and the discovery rules stay π's (ADR 0021), and
// Crucible decides only which folders are read and in what order.

/** π's `Skill`, narrowed to what Crucible's own seams read off one. */
export interface LoadedSkill {
  readonly name: string
  readonly description: string
  /** Absolute path of the skill's own markdown file. */
  readonly filePath: string
  /** Absolute directory that file sits in. */
  readonly baseDir: string
}

// π's loader made these, so they carry the fields π reads that Crucible does
// not — `disable-model-invocation` among them, which is why the objects are
// passed back whole rather than rebuilt from the four fields above.
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
  // Every skill the workspace offers, resolved fresh: a skill written a moment
  // ago is in this answer, and a folder that does not exist contributes
  // nothing. Never rejects. `undefined` means the folders could not be read at
  // all, so whatever the caller holds stays in force.
  resolve(workspacePath: string): Promise<readonly LoadedSkill[] | undefined>
}

export interface SkillServiceOptions {
  readonly roots: SkillRoots
  // Where π's loader diagnostics go: a skill with no description, an
  // unreadable folder, a name collision. The run log is where the diagnosis
  // happens, because nothing about a bad skill reaches the UI.
  readonly onDiagnostic?: (diagnostic: { path?: string; message: string }) => void
}

// Imported dynamically because the SDK is ESM-only, so the CommonJS main
// bundle cannot `require` it.
type Sdk = typeof import('@earendil-works/pi-coding-agent')

export function createSkillService({ roots, onDiagnostic }: SkillServiceOptions): SkillService {
  let sdkModule: Promise<Sdk> | undefined

  function sdk(): Promise<Sdk> {
    sdkModule ??= import('@earendil-works/pi-coding-agent')
    return sdkModule
  }

  return {
    async resolve(workspacePath: string): Promise<readonly LoadedSkill[] | undefined> {
      const folders = foldersFor(roots, workspacePath)
      try {
        const pi = await sdk()
        const loaded = pi.loadSkills({
          cwd: workspacePath,
          // Crucible's own agent dir, so π's `.pi` folders are named nowhere
          // (ADR 0015). With `includeDefaults` off nothing under it is read
          // either: the three paths below are the whole of discovery.
          agentDir: crucibleAgentDir(homedir()),
          skillPaths: [...folders],
          includeDefaults: false
        })
        for (const diagnostic of loaded.diagnostics) {
          // A diagnostic about an origin folder itself is π saying it is not
          // there, which is the ordinary state of two of the three and would
          // put two lines on the log for every turn ever taken. What is worth
          // reporting names a file inside one.
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
        onDiagnostic?.({ message: cause instanceof Error ? cause.message : String(cause) })
        return undefined
      }
    }
  }
}

/**
 * The skills a node may use: every one by default, the named subset when the
 * node asked for one, and nothing at all for an empty list. A name matching no
 * skill is ignored.
 */
export function narrowSkills(
  skills: readonly LoadedSkill[],
  names?: readonly string[]
): readonly LoadedSkill[] {
  if (names === undefined) return skills
  const wanted = new Set(names)
  return skills.filter((skill) => wanted.has(skill.name))
}
