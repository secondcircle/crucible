// No I/O and no SDK import, so what an agent is told can be checked without
// constructing an adapter or paying for a call.

/** The one substitution a role prompt may ask for. */
export const DOCS_INDEX_PLACEHOLDER = '{{CRUCIBLE_DOCS_INDEX}}'

export interface SystemPromptLayers {
  readonly role: string
  readonly standing: string
  readonly docsIndexPath?: string
}

/** π appends the project context files and the cwd line after this text. */
export function composeSystemPrompt({
  role,
  standing,
  docsIndexPath
}: SystemPromptLayers): string {
  const substituted =
    docsIndexPath === undefined
      ? role.trim()
      : role.split(DOCS_INDEX_PLACEHOLDER).join(docsIndexPath).trim()
  const appended = standing.trim()

  // An empty override makes the SDK fall back to π's own prompt, the one
  // outcome this module exists to prevent.
  if (substituted === '') throw new Error('A Crucible agent needs a role prompt; this one is blank.')
  if (appended === '') {
    throw new Error('A Crucible agent needs a standing prompt; this one is blank.')
  }
  // A misplumbed launch fails here rather than shipping a literal placeholder
  // into a paid call.
  if (substituted.includes(DOCS_INDEX_PLACEHOLDER)) {
    throw new Error(
      `The role prompt still names ${DOCS_INDEX_PLACEHOLDER}, so no docs index path was given.`
    )
  }

  return `${substituted}\n\n${appended}`
}
