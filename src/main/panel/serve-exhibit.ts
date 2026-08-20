import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { parseExhibitUrl } from '../../shared/agent/exhibit-url'
import type { PanelModel } from './model'

// The whole decision of what the exhibit scheme answers with, as a plain
// function of the panel model and the request: Electron holds nothing but the
// translation into a `Response`. A file is servable because some session's tab
// shows it, and for no other reason.

// The exhibit document's own policy, which is the point of giving it an
// origin. Its inline script and inline styles run and its own `data:` images
// draw; every network source, subresource, nested frame and object is denied.
// `form-action` and `base-uri` are named because neither falls back to
// `default-src`.
export const EXHIBIT_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  "form-action 'none'",
  "base-uri 'none'"
].join('; ')

/** Everything a refused request is told, whatever it asked for. */
export const NOT_SHOWN = 'Not an exhibit the context panel is showing.'

/** The tab is real, its file is not readable. Same stance as the port's `exhibit`. */
export function unreadable(path: string): string {
  return `That exhibit could not be read: ${basename(path)}.`
}

export interface ExhibitResponse {
  readonly status: 200 | 404
  readonly headers: Readonly<Record<string, string>>
  /** The exhibit's bytes when served; a fixed sentence when refused. */
  readonly body: Uint8Array | string
}

/** As much of an Electron `ProtocolRequest` as the decision reads. */
export interface ExhibitRequest {
  readonly method: string
  readonly url: string
}

export function serveExhibit(panel: PanelModel, request: ExhibitRequest): ExhibitResponse {
  if (request.method !== 'GET') return refuse(NOT_SHOWN)

  const asked = parseExhibitUrl(request.url)
  if (asked === undefined) return refuse(NOT_SHOWN)

  // An exact lookup of the decoded ids, never a path: `..`, encoded separators
  // and every other smuggling shape simply match no tab.
  const file = panel.exhibitFile(asked.sessionId, asked.tabId)
  // Markdown exhibits never ride the frame; they keep their way through the
  // port's `exhibit` operation.
  if (file === undefined || file.kind !== 'html') return refuse(NOT_SHOWN)

  let body: Uint8Array
  try {
    body = readFileSync(file.path)
  } catch {
    // Honest data: the tab stays open, and a vanished file serves a refusal
    // rather than the copy it used to be.
    return refuse(unreadable(file.path))
  }

  return {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Read at request time, every time: a re-shown or externally edited
      // exhibit serves what is on disk now.
      'Cache-Control': 'no-store',
      'Content-Security-Policy': EXHIBIT_POLICY
    },
    body
  }
}

// Nothing the caller controls is reflected: a refusal says which of the two
// things went wrong and not one word of what was asked for.
function refuse(body: string): ExhibitResponse {
  return {
    status: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': EXHIBIT_POLICY
    },
    body
  }
}
