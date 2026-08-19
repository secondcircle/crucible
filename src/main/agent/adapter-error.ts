// The only way a failure becomes text the port may carry, so that stacks, SDK
// error objects and provider payloads stop here rather than in each module
// that builds an event. A fallback is always returned, so an error line always
// renders.
export function displaySafeMessage(cause: unknown, fallback = UNEXPLAINED): string {
  return displaySafeText(cause) ?? fallback
}

const UNEXPLAINED = 'The agent failed without saying why.'

/** Longer than any sentence a pane should print on one error line. */
const SENTENCE_LIMIT = 200

// What payloads and stacks carry and a one-line sentence never does.
const STRUCTURE = /[{}[\]<>]|\p{Cc}/u

function displaySafeText(cause: unknown): string | undefined {
  const raw = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : undefined
  if (raw === undefined) return undefined
  return plainSentence(raw) ?? plainSentence(embeddedMessage(raw))
}

function plainSentence(text: string | undefined): string | undefined {
  const trimmed = text?.trim()
  if (trimmed === undefined || trimmed === '' || trimmed.length > SENTENCE_LIMIT) return undefined
  return STRUCTURE.test(trimmed) ? undefined : trimmed
}

// A provider buries the one readable sentence inside its payload, so it is
// lifted out and everything around it, request id included, is left behind.
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
