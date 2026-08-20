// Pure, no I/O and no SDK import, so the whole of what a Crucible agent is
// told can be checked without constructing an adapter or paying for a call.
// A future node agent picks a different role prompt; the standing prompt is
// appended whatever it picks.

/** The one substitution a role prompt may ask for. */
export const DOCS_INDEX_PLACEHOLDER = '{{CRUCIBLE_DOCS_INDEX}}'

export interface SystemPromptLayers {
  /** Role prompt text; may contain the {{CRUCIBLE_DOCS_INDEX}} placeholder. */
  readonly role: string
  /** Standing prompt text; appended whatever the role says. */
  readonly standing: string
  /** Absolute path substituted for every occurrence of the placeholder. */
  readonly docsIndexPath?: string
}

/**
 * The whole system prompt of an agent Crucible starts: role first, standing
 * last, one blank line between them. π appends the project context files and
 * the cwd line after this text; nothing else is added here.
 */
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

  // A blank layer would leave π's own prompt standing: an empty override makes
  // the SDK fall back to it, which is the one outcome this module exists to
  // prevent.
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
