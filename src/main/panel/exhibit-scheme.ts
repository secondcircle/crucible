import { protocol, session } from 'electron'
import { EXHIBIT_SCHEME, parseExhibitUrl } from '../../shared/agent/exhibit-url'
import type { MainWorkflowRunService } from '../../shared/workflows/service'
import { serveRunArtifact } from '../workflows/serve-run-artifact'
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
export function serveExhibitScheme(
  panel: PanelModel,
  runs: Pick<MainWorkflowRunService, 'artifactFile'>
): void {
  session.defaultSession.protocol.handle(EXHIBIT_SCHEME, (request) => {
    const asked = parseExhibitUrl(request.url)
    const { status, headers, body } =
      asked?.kind === 'run' ? serveRunArtifact(runs, request) : serveExhibit(panel, request)
    return new Response(body, { status, headers })
  })
}
