import { readFileSync } from 'node:fs'
import { parseExhibitUrl } from '../../shared/agent/exhibit-url'
import { artifactKind } from '../../shared/workflows/artifacts'
import type { MainWorkflowRunService } from '../../shared/workflows/service'
import {
  EXHIBIT_POLICY,
  type ExhibitRequest,
  type ExhibitResponse
} from '../panel/serve-exhibit'

// The run half of the exhibit scheme, and a plain function of the run service
// and the request so the decision tests without Electron. A file is servable
// only because the named run's record names it.

/** Everything a refused request is told, whatever it asked for. */
export const NOT_A_RUN_ARTIFACT = 'Not a file a run of this workflow engine wrote.'

/** As much of the run service as the decision reads. */
export type ArtifactSource = Pick<MainWorkflowRunService, 'artifactFile'>

export function serveRunArtifact(
  runs: ArtifactSource,
  request: ExhibitRequest
): ExhibitResponse {
  if (request.method !== 'GET') return refuse()

  const asked = parseExhibitUrl(request.url)
  if (asked === undefined || asked.kind !== 'run') return refuse()

  // An exact lookup of the decoded path against the record, never a path
  // resolved on disk: `..` and every other smuggling shape match no entry.
  const file = runs.artifactFile(asked.runId, asked.path)
  // Markdown and text ride the service's `artifact` operation; only a document
  // that is HTML needs an origin of its own.
  if (file === undefined || artifactKind(file.path) !== 'html') return refuse()

  let body: Uint8Array
  try {
    body = readFileSync(file.path)
  } catch {
    return refuse()
  }

  return {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Read at request time, every time: re-opening the reader shows what is
      // on disk now.
      'Cache-Control': 'no-store',
      'Content-Security-Policy': EXHIBIT_POLICY
    },
    body
  }
}

// Nothing the caller controls is reflected: one sentence, whatever was asked
// for and whichever step refused it.
function refuse(): ExhibitResponse {
  return {
    status: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': EXHIBIT_POLICY
    },
    body: NOT_A_RUN_ARTIFACT
  }
}
