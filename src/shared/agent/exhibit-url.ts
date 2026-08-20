import type { SessionId, TabId } from './port'

// The one format both ends of the exhibit scheme know. The renderer builds
// these URLs and main parses them, so the format lives in one module and the
// two cannot drift. Like `port.ts`, this file takes on nothing: no Electron,
// no Node, no SDK types, only the port's own two id aliases.

/** The scheme exhibits are served under; registered privileged in main. */
export const EXHIBIT_SCHEME = 'exhibit'

// The only host the scheme answers on. It carries no meaning of its own; a
// standard scheme needs a host, and this is it.
const EXHIBIT_HOST = 'panel'

/** What an exhibit URL names, and everything it can name. */
export interface ExhibitRef {
  readonly sessionId: SessionId
  readonly tabId: TabId
}

// No file path, no filename, no extension: the renderer knows a tab by its id
// and by nothing else, and the URL carries exactly that much.
export function exhibitUrl(sessionId: SessionId, tabId: TabId): string {
  return `${EXHIBIT_SCHEME}://${EXHIBIT_HOST}/${encodeURIComponent(sessionId)}/${encodeURIComponent(tabId)}`
}

// Anything that is not exactly the shape above is refused rather than
// repaired, because a request main cannot read off the format is a request no
// panel made.
export function parseExhibitUrl(url: string): ExhibitRef | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== `${EXHIBIT_SCHEME}:` || parsed.host !== EXHIBIT_HOST) return undefined
  // Credentials, a query and a fragment are all shapes the builder never
  // makes, so none of them is part of what may be asked for.
  if (parsed.username !== '' || parsed.password !== '') return undefined
  if (parsed.search !== '' || parsed.hash !== '') return undefined

  // A path begins with the separator, so the first piece is always empty and
  // exactly two must follow it.
  const pieces = parsed.pathname.split('/')
  if (pieces.length !== 3 || pieces[0] !== '') return undefined
  const sessionId = decodeSegment(pieces[1])
  const tabId = decodeSegment(pieces[2])
  if (sessionId === undefined || tabId === undefined) return undefined
  if (sessionId === '' || tabId === '') return undefined
  return { sessionId, tabId }
}

function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment)
  } catch {
    // Malformed encoding: not a segment this module would ever have written.
    return undefined
  }
}
