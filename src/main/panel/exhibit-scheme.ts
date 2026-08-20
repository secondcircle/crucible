import { protocol, session } from 'electron'
import { EXHIBIT_SCHEME } from '../../shared/agent/exhibit-url'
import type { PanelModel } from './model'
import { serveExhibit } from './serve-exhibit'

// The plumbing the decision in `serve-exhibit.ts` cannot be tested with. It
// sits under the one panel model the launch already holds (ADR 0008), not
// beside it: both adapters keep delegating to that same model.

// Standard and secure, so a sandboxed frame may load an exhibit at all. Not
// privileged past that: `bypassCSP` is deliberately absent, because the
// renderer admits this frame through its own `frame-src` and the exhibit
// document takes its policy from the response header.
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
