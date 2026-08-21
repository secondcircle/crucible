// @vitest-environment node
//
// The whole decision, over real files: only Electron's translation into a
// `Response` sits above what is exercised here. A run artifact that is HTML
// gets an origin of its own, and it gets it only because the run's record
// names the file — which is the question the service answers, and the
// stand-in below answers the same way its two implementations do.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exhibitUrl, runExhibitUrl } from '../../shared/agent/exhibit-url'
import { EXHIBIT_POLICY, type ExhibitResponse } from '../panel/serve-exhibit'
import {
  NOT_A_RUN_ARTIFACT,
  serveRunArtifact,
  type ArtifactSource
} from './serve-run-artifact'

let dir: string
let service: ArtifactSource
let report: string
let spec: string

/** A run whose record names exactly the files written here. */
function serviceOver(files: Record<string, string>): ArtifactSource {
  const paths = Object.keys(files)
  for (const [path, body] of Object.entries(files)) writeFileSync(path, body, 'utf8')
  return {
    artifactFile: (runId, path) =>
      runId === 'en42' && paths.includes(path) ? { path } : undefined
  }
}

function get(url: string): ExhibitResponse {
  return serveRunArtifact(service, { method: 'GET', url })
}

const text = (response: ExhibitResponse): string =>
  typeof response.body === 'string' ? response.body : new TextDecoder().decode(response.body)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crucible-run-artifact-'))
  report = join(dir, 'report.html')
  spec = join(dir, 'spec.md')
  service = serviceOver({
    [report]: '<!doctype html><p>the report</p>',
    [spec]: '# the spec'
  })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('serving a run artifact', () => {
  it('serves a recorded HTML artifact under the exhibit policy', () => {
    const served = get(runExhibitUrl('en42', report))

    expect(served.status).toBe(200)
    expect(text(served)).toContain('the report')
    expect(served.headers['Content-Type']).toBe('text/html; charset=utf-8')
    expect(served.headers['Cache-Control']).toBe('no-store')
    expect(served.headers['Content-Security-Policy']).toBe(EXHIBIT_POLICY)
  })

  it('refuses everything the record does not name, saying nothing back', () => {
    const refusals = [
      // Not in the record: a real file, and a path that climbs out of the dir.
      runExhibitUrl('en42', join(dir, 'secret.html')),
      runExhibitUrl('en42', `${dir}/../../etc/passwd`),
      // A run that does not exist, and the panel form on this route.
      runExhibitUrl('nope', report),
      exhibitUrl('s1', 'tab-1'),
      // Shapes the builder never writes.
      `exhibit://run/en42/${encodeURIComponent(report)}?fresh=1`,
      `exhibit://run/en42/${encodeURIComponent(report)}#top`,
      'exhibit://run/en42',
      'exhibit://run/en42/%zz',
      'not a url at all'
    ]
    for (const url of refusals) {
      const refused = get(url)
      expect(refused.status, url).toBe(404)
      expect(text(refused), url).toBe(NOT_A_RUN_ARTIFACT)
      // Nothing the caller sent comes back in the refusal.
      expect(text(refused)).not.toContain('passwd')
      expect(text(refused)).not.toContain('secret')
    }
  })

  it('refuses a recorded file that is not HTML: markdown rides the service', () => {
    const refused = get(runExhibitUrl('en42', spec))
    expect(refused.status).toBe(404)
    expect(text(refused)).toBe(NOT_A_RUN_ARTIFACT)
  })

  it('refuses anything but a GET', () => {
    const posted = serveRunArtifact(service, {
      method: 'POST',
      url: runExhibitUrl('en42', report)
    })
    expect(posted.status).toBe(404)
    expect(text(posted)).toBe(NOT_A_RUN_ARTIFACT)
  })

  it('refuses with the same sentence when the file has vanished', () => {
    rmSync(report)
    const refused = get(runExhibitUrl('en42', report))
    expect(refused.status).toBe(404)
    expect(text(refused)).toBe(NOT_A_RUN_ARTIFACT)
    expect(refused.headers['Content-Security-Policy']).toBe(EXHIBIT_POLICY)
  })
})
