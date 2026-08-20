import { protocol, session } from 'electron'
import { EXHIBIT_SCHEME } from '../../shared/agent/exhibit-url'
import type { PanelModel } from './model'
import { serveExhibit } from './serve-exhibit'

// Standard and secure so a sandboxed frame may load an exhibit at all, and no
// further: the exhibit's own response header is what limits what it may do.
export function registerExhibitScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: EXHIBIT_SCHEME, privileges: { standard: true, secure: true } }
  ])
}

/** Installed once per launch, on the session the app window uses. */
export function serveExhibitScheme(panel: PanelModel): void {
  session.defaultSession.protocol.handle(EXHIBIT_SCHEME, (request) => {
    const { status, headers, body } = serveExhibit(panel, request)
    return new Response(body, { status, headers })
  })
}
