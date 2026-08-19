/**
 * The one way a failure becomes text the port may carry.
 *
 * A turn can fail from either direction — an adapter reports it, or an
 * operation throws — and both hand this function the raw cause. It answers with
 * a sentence, so no other module holds the raw text next to an event it is
 * building: the port's rule that a message is *display-safe text for a person*,
 * and that stacks, SDK error objects and provider payloads never cross, is kept
 * here or nowhere.
 *
 * What "display-safe" means, concretely — and this is the whole of the rule:
 *
 * - A cause that is neither an `Error` nor a string says nothing a pane could
 *   render; it becomes the fallback. An SDK error *object* is therefore never
 *   stringified into a message, only its `message` is even looked at.
 * - Text that is already a plain sentence — short, one line, no structure — is
 *   what the provider or the SDK meant a human to read, and crosses as it is.
 * - Text that carries structure is a payload, not a sentence: a provider's
 *   `400 {"type":"error", … ,"request_id":"req_…"}`, an HTML error page, a
 *   stack trace. The payload never crosses. If a human-readable `message` sits
 *   inside it, that sentence — and only that sentence — is lifted out and
 *   crosses instead, so a person can still be told "You're out of extra usage"
 *   without also being shown a request id.
 * - Anything left over becomes the fallback, so an error line always renders.
 *
 * The raw cause stops here. The run log records what crossed the seam, because
 * that is the thing a reader has to reconcile with what the window showed.
 */
export function displaySafeMessage(cause: unknown, fallback = UNEXPLAINED): string {
  return displaySafeText(cause) ?? fallback
}

/** What an error says when nothing it carried could be shown to a person. */
const UNEXPLAINED = 'The agent failed without saying why.'

/** Longer than any sentence a pane should print on one error line. */
const SENTENCE_LIMIT = 200

/**
 * The shapes payloads and stacks come in: braces, brackets, angle brackets, and
 * any line break or control character — a sentence for one error line has none
 * of them.
 */
const STRUCTURE = /[{}[\]<>]|\p{Cc}/u

function displaySafeText(cause: unknown): string | undefined {
  const raw = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : undefined
  if (raw === undefined) return undefined
  return plainSentence(raw) ?? plainSentence(embeddedMessage(raw))
}

/** The text itself if it is something a pane can print, and nothing otherwise. */
function plainSentence(text: string | undefined): string | undefined {
  const trimmed = text?.trim()
  if (trimmed === undefined || trimmed === '' || trimmed.length > SENTENCE_LIMIT) return undefined
  return STRUCTURE.test(trimmed) ? undefined : trimmed
}

/**
 * The human sentence a provider buried in its payload — `error.message` in a
 * provider's JSON, wherever in it that sits. Everything around it, including
 * the request id, is left behind.
 */
function embeddedMessage(raw: string): string | undefined {
  const open = raw.indexOf('{')
  const close = raw.lastIndexOf('}')
  if (open === -1 || close < open) return undefined

  let payload: unknown
  try {
    payload = JSON.parse(raw.slice(open, close + 1))
  } catch {
    return undefined
  }
  return humanMessage(payload, 0)
}

function humanMessage(value: unknown, depth: number): string | undefined {
  if (depth > 4 || value === null || typeof value !== 'object') return undefined

  const fields = value as Record<string, unknown>
  if (typeof fields.message === 'string') return fields.message

  for (const nested of Object.values(fields)) {
    const found = humanMessage(nested, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}
