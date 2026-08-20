// The agent learns Crucible from docs shipped with the app (ADR 0006): every
// SDK adapter session's system context carries them, because the installed app
// may run on a machine with no Crucible source checkout.
//
// Pure, so the assembly can be tested without constructing an adapter.

/**
 * π's own appended system prompts, plus Crucible's shipped docs. An absent doc
 * changes nothing, and a doc already present is not added twice — sessions of
 * one workspace share a resource loader.
 */
export function withAgentContext(
  base: readonly string[],
  ...docs: readonly (string | undefined)[]
): readonly string[] {
  const assembled = [...base]
  for (const doc of docs) {
    const text = doc?.trim() ?? ''
    if (text === '') continue
    if (assembled.some((already) => already.trim() === text)) continue
    assembled.push(text)
  }
  return assembled
}
