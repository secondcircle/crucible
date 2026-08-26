// Turn-start context, marked so it can be taken back out. π stores a user
// message whole, so the only way to put text before the model without it
// becoming part of the conversation anyone reads is to mark it on the way in
// and strip it on the way out. Every surface that shows a user message reads
// it through `userTextOf`, which strips this, so there is one place to get
// right rather than one per surface.
//
// The tags are deliberately unlovely: a person typing them by hand would have
// to be trying, and if they did, the worst that happens is their own text is
// hidden from the transcript rather than anything of Crucible's leaking into it.

const OPEN = '<crucible:turn-context>'
const CLOSE = '</crucible:turn-context>'

/** The message as the model receives it: the context first, then what was typed. */
export function markTurnContext(context: string, text: string): string {
  return `${OPEN}\n${context}\n${CLOSE}\n\n${text}`
}

/** The same message with every marked block removed, which is what a person sees. */
export function stripTurnContext(text: string): string {
  if (!text.includes(OPEN)) return text
  let stripped = ''
  let at = 0
  for (;;) {
    const opened = text.indexOf(OPEN, at)
    if (opened === -1) break
    const closed = text.indexOf(CLOSE, opened)
    stripped += text.slice(at, opened)
    // An unclosed block means the whole tail is context: better to show
    // nothing of it than to show half of it.
    if (closed === -1) return stripped.trimStart()
    at = closed + CLOSE.length
  }
  return (stripped + text.slice(at)).trimStart()
}
