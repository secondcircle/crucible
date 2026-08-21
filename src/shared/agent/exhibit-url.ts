import type { SessionId, TabId } from './port'

// The renderer builds these URLs and main parses them, so the format lives in
// one module and the two cannot drift. It takes on no Electron, Node or SDK.

/** The scheme exhibits are served under; registered privileged in main. */
export const EXHIBIT_SCHEME = 'exhibit'

// A standard scheme needs a host, and the host is what the handler dispatches
// on: a context panel tab, or a file some run's record names. Two hosts are
// two origins, which is what keeps a run's HTML out of the panel's.
const PANEL_HOST = 'panel'
const RUN_HOST = 'run'

/** A context panel tab: the renderer knows it by id and by nothing else. */
export interface PanelExhibitRef {
  readonly kind: 'panel'
  readonly sessionId: SessionId
  readonly tabId: TabId
}

/** One run artifact, named the way the record names it. */
export interface RunExhibitRef {
  readonly kind: 'run'
  readonly runId: string
  readonly path: string
}

export type ExhibitRef = PanelExhibitRef | RunExhibitRef

// No file path, no filename, no extension: the renderer knows a tab by its id
// and by nothing else, and the URL carries exactly that much.
export function exhibitUrl(sessionId: SessionId, tabId: TabId): string {
  return `${EXHIBIT_SCHEME}://${PANEL_HOST}/${encodeURIComponent(sessionId)}/${encodeURIComponent(tabId)}`
}

// The run form does carry a path, because that is the key the record is looked
// up by; main matches it whole and never resolves it.
export function runExhibitUrl(runId: string, path: string): string {
  return `${EXHIBIT_SCHEME}://${RUN_HOST}/${encodeURIComponent(runId)}/${encodeURIComponent(path)}`
}

// Refused rather than repaired: a request main cannot read off the format is
// a request nothing here made.
export function parseExhibitUrl(url: string): ExhibitRef | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== `${EXHIBIT_SCHEME}:`) return undefined
  if (parsed.host !== PANEL_HOST && parsed.host !== RUN_HOST) return undefined
  // Credentials, a query and a fragment are all shapes the builder never
  // makes, so none of them is part of what may be asked for.
  if (parsed.username !== '' || parsed.password !== '') return undefined
  if (parsed.search !== '' || parsed.hash !== '') return undefined

  // A path begins with the separator, so the first piece is always empty and
  // exactly two must follow it.
  const pieces = parsed.pathname.split('/')
  if (pieces.length !== 3 || pieces[0] !== '') return undefined
  const first = decodeSegment(pieces[1])
  const second = decodeSegment(pieces[2])
  if (first === undefined || second === undefined) return undefined
  if (first === '' || second === '') return undefined
  return parsed.host === PANEL_HOST
    ? { kind: 'panel', sessionId: first, tabId: second }
    : { kind: 'run', runId: first, path: second }
}

function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment)
  } catch {
    // Malformed encoding: not a segment this module would ever have written.
    return undefined
  }
}
