// One definition of how a skill read is named and how its summary is built,
// because three surfaces read it: the main process writes it, the transcript
// chain counts it, and the session tree's activity line counts it too.

/** The tool name a skill read is displayed under, as the port sends it. */
export const SKILL_TOOL = 'skill'

// The port sends a supporting file as the skill's name, ` · `, then the path
// inside the skill. The chain head's count, the row's faint tail and the tree
// line all turn on that one format.
export function splitSkillSummary(summary: string): {
  readonly skill: string
  readonly within?: string
} {
  const at = summary.indexOf(' · ')
  if (at === -1) return { skill: summary }
  return { skill: summary.slice(0, at), within: summary.slice(at + ' · '.length) }
}
