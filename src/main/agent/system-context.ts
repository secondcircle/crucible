// Apart from the adapter and pure, so the assembly can be checked without
// constructing one and paying for a call.

/**
 * A doc already present is not added twice: sessions of one workspace share a
 * resource loader.
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
